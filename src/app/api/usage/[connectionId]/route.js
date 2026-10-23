// Ensure proxyFetch is loaded to patch globalThis.fetch
import "open-sse/index.js";

import { getProviderConnectionById, updateProviderConnection } from "@/lib/localDb";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { extractEarliestPackageExpiry } from "open-sse/services/usage/expiryExtractor.js";
import { extractConnectionBalance } from "open-sse/services/usage/balanceExtractor.js";
import { isUnrecoverableRefreshError } from "open-sse/services/tokenRefresh.js";
import { markConnectionNeedsReauth, NEEDS_REAUTH_MESSAGE } from "@/sse/services/tokenRefresh.js";
import { getExecutor } from "open-sse/executors/index.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { USAGE_APIKEY_PROVIDERS, USAGE_COOKIE_PROVIDERS } from "@/shared/constants/providers";

// Detect auth-expired messages returned by usage providers instead of throwing
const AUTH_EXPIRED_PATTERNS = ["expired", "authentication", "unauthorized", "401", "re-authorize"];
function isAuthExpiredMessage(usage) {
  if (!usage?.message) return false;
  const msg = usage.message.toLowerCase();
  return AUTH_EXPIRED_PATTERNS.some((p) => msg.includes(p));
}

/**
 * Refresh credentials using executor and update database
 * @param {boolean} force - Skip needsRefresh check and always attempt refresh
 * @returns Promise<{ connection, refreshed: boolean }>
 */
export async function refreshAndUpdateCredentials(connection, force = false, proxyOptions = null) {
  // 刷新前重读 DB 里的最新凭据：OpenAI 每次刷新都会轮换 refresh token，
  // 拿快照旧值再去刷新属于"复用"，会吊销整个 session（账号被登出）——上游 0bc7f86e。
  const latest = connection.id ? await getProviderConnectionById(connection.id) : null;
  if (latest) connection = latest;

  const executor = getExecutor(connection.provider);

  // Build credentials object from connection
  const credentials = {
    accessToken: connection.accessToken,
    refreshToken: connection.refreshToken,
    idToken: connection.idToken,
    expiresAt: connection.expiresAt || connection.tokenExpiresAt,
    lastRefreshAt: connection.lastRefreshAt,
    connectionId: connection.id,
    providerSpecificData: connection.providerSpecificData,
    // For GitHub
    copilotToken: connection.providerSpecificData?.copilotToken,
    copilotTokenExpiresAt: connection.providerSpecificData?.copilotTokenExpiresAt,
  };

  // Check if refresh is needed (skip when force=true)
  const needsRefresh = force || executor.needsRefresh(credentials);

  if (!needsRefresh) {
    return { connection, refreshed: false };
  }

  // Use executor's refreshCredentials method (with optional proxy)
  const refreshResult = await executor.refreshCredentials(credentials, console, proxyOptions);

  // refresh token 已失效/被复用——整个 token 族已被吊销，绝不能拿死 token 继续用。
  if (refreshResult && isUnrecoverableRefreshError(refreshResult)) {
    // Usage 轮询是发现死账号的另一条路（请求路径由 checkAndRefreshToken 标记）。
    // 标记 + 冷却在这里同样要落库，否则账号继续留在轮换里每 2 分钟被重试一次。
    await markConnectionNeedsReauth(connection.id, {
      provider: connection.provider,
      reason: refreshResult,
      log: console,
    });
    throw new Error(NEEDS_REAUTH_MESSAGE);
  }

  if (!refreshResult) {
    // Refresh failed but we still have an accessToken — try with existing token
    if (connection.accessToken) {
      return { connection, refreshed: false };
    }
    throw new Error("Failed to refresh credentials. Please re-authorize the connection.");
  }

  // Build update object
  const now = new Date().toISOString();
  const updateData = {
    updatedAt: now,
  };

  // Update accessToken if present
  if (refreshResult.accessToken) {
    updateData.accessToken = refreshResult.accessToken;
  }

  // Update refreshToken if present
  if (refreshResult.refreshToken) {
    updateData.refreshToken = refreshResult.refreshToken;
  }

  if (refreshResult.idToken) {
    updateData.idToken = refreshResult.idToken;
  }

  if (refreshResult.lastRefreshAt) {
    updateData.lastRefreshAt = refreshResult.lastRefreshAt;
  }

  // Update token expiry
  if (refreshResult.expiresIn) {
    updateData.expiresAt = new Date(Date.now() + refreshResult.expiresIn * 1000).toISOString();
    updateData.expiresIn = refreshResult.expiresIn;
  } else if (refreshResult.expiresAt) {
    updateData.expiresAt = refreshResult.expiresAt;
  }

  // Handle provider-specific data (copilotToken for GitHub, etc.)
  const providerSpecificUpdates = {
    ...(refreshResult.providerSpecificData || {}),
    ...(refreshResult.copilotToken ? { copilotToken: refreshResult.copilotToken } : {}),
    ...(refreshResult.copilotTokenExpiresAt ? { copilotTokenExpiresAt: refreshResult.copilotTokenExpiresAt } : {}),
  };
  if (Object.keys(providerSpecificUpdates).length > 0) {
    updateData.providerSpecificData = {
      ...(connection.providerSpecificData || {}),
      ...providerSpecificUpdates,
    };
  }

  // Update database
  await updateProviderConnection(connection.id, updateData);

  // Return updated connection
  const updatedConnection = {
    ...connection,
    ...updateData,
    providerSpecificData: updateData.providerSpecificData || connection.providerSpecificData,
  };

  return {
    connection: updatedConnection,
    refreshed: true,
  };
}

/**
 * GET /api/usage/[connectionId] - Get usage data for a specific connection
 */
export async function GET(request, { params }) {
  const { connectionId } = await params;
  const force = new URL(request.url).searchParams.get("force") === "1";

  // Get connection from database
  let connection;
  try {
    connection = await getProviderConnectionById(connectionId);
  } catch (error) {
    console.warn(`[Usage] unknown: ${error.message}`);
    return Response.json({ error: error.message }, { status: 500 });
  }
  if (!connection) {
    return Response.json({ error: "Connection not found" }, { status: 404 });
  }
  const { status, body } = await computeConnectionUsage(connection, { force });
  return Response.json(body, status === 200 ? undefined : { status });
}

/**
 * Usage for one connection (refresh credentials if needed → provider usage API →
 * persist earliest package expiry). Shared by GET /api/usage/[connectionId] and the
 * aggregated GET /api/usage/quotas. Returns { status, body } — body is exactly what
 * the per-connection endpoint has always returned.
 */
export async function computeConnectionUsage(connection, { force = false } = {}) {
  try {
    // Allow OAuth connections, plus whitelisted apikey providers (glm/minimax/kiro/...)
    // Kiro's headless api-key flow persists authType "api_key" (underscore) while
    // generic apikey providers persist "apikey" — accept both spellings here.
    const isOAuth = connection.authType === "oauth";
    const isApikeyAuth =
      connection.authType === "apikey" || connection.authType === "api_key";
    const isApikeyEligible =
      isApikeyAuth && USAGE_APIKEY_PROVIDERS.includes(connection.provider);
    const isCookieEligible =
      connection.authType === "cookie" && USAGE_COOKIE_PROVIDERS?.includes(connection.provider);

    if (!isOAuth && !isApikeyEligible && !isCookieEligible) {
      return { status: 200, body: { message: "Usage not available for this connection" } };
    }

    // Resolve connection proxy config; force strictProxy=false so quota/refresh fall back to direct on failure
    const proxyConfig = await resolveConnectionProxyConfig(connection.providerSpecificData);
    const proxyOptions = {
      connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
      connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
      connectionNoProxy: proxyConfig.connectionNoProxy || "",
      vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
      strictProxy: false,
    };

    // Refresh credentials only for OAuth connections (apikey has no token refresh)
    if (isOAuth) {
      try {
        const result = await refreshAndUpdateCredentials(connection, false, proxyOptions);
        connection = result.connection;
      } catch (refreshError) {
        console.error("[Usage API] Credential refresh failed:", refreshError);
        return { status: 401, body: { error: `Credential refresh failed: ${refreshError.message}` } };
      }
    }

    // Fetch usage from provider API
    let usage = await getUsageForProvider(connection, proxyOptions, { force });

    // If provider returned an auth-expired message instead of throwing,
    // force-refresh token and retry once (OAuth only)
    if (isOAuth && isAuthExpiredMessage(usage) && connection.refreshToken) {
      try {
        const retryResult = await refreshAndUpdateCredentials(connection, true, proxyOptions);
        connection = retryResult.connection;
        usage = await getUsageForProvider(connection, proxyOptions, { force });
      } catch (retryError) {
        console.warn(`[Usage] ${connection.provider}: force refresh failed: ${retryError.message}`);
      }
    }

    // Persist earliest available package expiry for expire-first routing and balance for balance routing
    try {
      const expiryInfo = extractEarliestPackageExpiry(usage);
      const parsedBalance = extractConnectionBalance(usage);
      const balancePatch = typeof parsedBalance === "number" ? { quotaBalance: parsedBalance } : {};
      if (expiryInfo) {
        await updateProviderConnection(connection.id, {
          earliestPackageExpiry: expiryInfo.expiry || null,
          earliestPackageName: expiryInfo.name || null,
          earliestPackageRemaining:
            typeof expiryInfo.remainingPercentage === "number" ? expiryInfo.remainingPercentage : null,
          shortWindowRemaining:
            typeof expiryInfo.shortRemainingPct === "number" ? expiryInfo.shortRemainingPct : null,
          longWindowRemaining:
            typeof expiryInfo.longRemainingPct === "number" ? expiryInfo.longRemainingPct : null,
          quotaZone: expiryInfo.zone || null,
          shortZone: expiryInfo.shortZone || null,
          longZone: expiryInfo.longZone || null,
          quotaWindowSource: expiryInfo.windowSource || null,
          quotaCheckedAt: new Date().toISOString(),
          ...balancePatch,
        });
      } else if (usage && usage.quotas) {
        await updateProviderConnection(connection.id, {
          earliestPackageExpiry: null,
          earliestPackageName: null,
          earliestPackageRemaining: null,
          shortWindowRemaining: null,
          longWindowRemaining: null,
          quotaZone: null,
          shortZone: null,
          longZone: null,
          quotaWindowSource: null,
          quotaCheckedAt: new Date().toISOString(),
          ...balancePatch,
        });
      }
    } catch (e) {
      console.warn(`[Usage API] Failed to update package expiry for ${connection.id}:`, e.message);
    }

    // 同名认领（2026-10-14 定版）：CD 推送的余额快照（river / 小米 MiMo / ModelScope
    // 等「余额只在网页会话侧」的供应商）归到连接卡展示——数字已在本地 _meta 快照，
    // 无需任何凭据。连接改名（编辑连接 → 名称）与 CD 账号别名同名即认领；未认领的
    // 给指路文案（这些供应商没有原生 usage handler，不指路就会漏出
    // "Usage API not implemented for <provider>"——river 已因此被修过一次，
    // modelscope 同设计，一并纳入）。
    try {
      const { buildExternalConnectionRows, findClaimedExternalRow } = await import("@/lib/externalQuota");
      const claimed = findClaimedExternalRow(connection, await buildExternalConnectionRows());
      const rows = claimed?.quota?.quotas || [];
      const PUSH_ONLY_USAGE_PROVIDERS = new Set(["river", "modelscope", "longcat"]);
      if (rows.length) {
        const extQuotas = Object.fromEntries(rows.map((r) => [r.name, r]));
        if (usage && usage.quotas && Object.keys(usage.quotas).length) {
          usage = { ...usage, quotas: { ...usage.quotas, ...extQuotas } };   // 原生行 + 推送余额行
        } else {
          usage = { quotas: extQuotas, plan: claimed.quota.plan ?? usage?.plan ?? null };
        }
        // Update balance if extracted from claimed rows
        try {
          const extBalance = extractConnectionBalance(usage);
          if (typeof extBalance === "number") {
            await updateProviderConnection(connection.id, { quotaBalance: extBalance });
          }
        } catch { /* ignore */ }
      } else if (PUSH_ONLY_USAGE_PROVIDERS.has(connection.provider) && usage && usage.message) {
        usage = { message: "No pushed balance matched this connection — set the CreditDaddy account alias to this connection's name (same name claims the card)" };
      }
    } catch { /* 认领读取失败保留原 usage */ }

    return { status: 200, body: usage };
  } catch (error) {
    const provider = connection?.provider ?? "unknown";
    console.warn(`[Usage] ${provider}: ${error.message}`);
    return { status: 500, body: { error: error.message } };
  }
}
