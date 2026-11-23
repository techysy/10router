import { NextResponse } from "next/server";
import { getProviderConnections } from "@/lib/localDb";
import { backfillCodexEmails } from "@/lib/oauth/providers";
import { USAGE_SUPPORTED_PROVIDERS } from "@/shared/constants/providers";
import { isUsageEligible } from "@/shared/utils/usageEligibility";
import { buildExternalConnectionRows, filterClaimedExternalRows, attachClaimRefreshUrls } from "@/lib/externalQuota";

const SAFE_FIELDS = [
  "id", "provider", "authType", "name", "email", "displayName",
  "priority", "globalPriority", "isActive", "defaultModel",
  "testStatus", "lastError", "lastErrorAt", "errorCode",
  "expiresAt", "lastUsedAt", "consecutiveUseCount",
  "createdAt", "updatedAt",
  // Read-only quota-freshness mirror (written by the usage refresh path, see
  // computeConnectionUsage): feeds the server-side "expiring" sort below and
  // the client-side expiring-first fallback for cards whose quota fetch has
  // not landed yet. A timestamp, no credentials.
  "earliestPackageExpiry",
  // Mirrored from a same-name-claimed external push (see attachClaimRefreshUrls)
  // so the connection card's refresh button can call the pusher back. Not a DB
  // column — present only on rows that actually claimed a push with a callback.
  "refreshUrl",
];

const SAFE_PSD_FIELDS = [
  "baseUrl", "azureEndpoint", "deployment", "apiVersion", "accountId",
  "region", "projectId", "resourceUrl", "proxyPoolId",
  "connectionProxyEnabled", "connectionProxyUrl", "connectionNoProxy",
  "githubLogin", "githubName", "githubEmail", "githubUserId",
  "username", "firstName", "lastName", "authMethod", "authKind",
  "profileArn",
];

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 500;

function maskName(name) {
  if (typeof name !== "string" || name.length <= 16) return name;
  if (/[a-zA-Z0-9_-]{32,}/.test(name)) return `${name.slice(0, 8)}***`;
  return name;
}

function sanitize(c) {
  // Synthetic external-quota rows (pushed display-only cards, see
  // src/lib/externalQuota.js) carry no credentials by construction — the push
  // endpoint whitelists every field — so they pass through with their `external`
  // / `quota` payload intact instead of the SAFE_FIELDS strip.
  if (c.external) return { ...c };
  const safe = {};
  for (const f of SAFE_FIELDS) if (c[f] !== undefined) safe[f] = c[f];
  if (safe.name) safe.name = maskName(safe.name);
  if (c.providerSpecificData) {
    const psd = {};
    for (const f of SAFE_PSD_FIELDS) {
      if (c.providerSpecificData[f] !== undefined) psd[f] = c.providerSpecificData[f];
    }
    safe.providerSpecificData = psd;
  }
  return safe;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sortConnections(connections, sort) {
  const list = [...connections];

  if (sort === "provider") {
    return list.sort((a, b) => {
      const orderA = USAGE_SUPPORTED_PROVIDERS.indexOf(a.provider);
      const orderB = USAGE_SUPPORTED_PROVIDERS.indexOf(b.provider);
      if (orderA !== orderB) return orderA - orderB;
      return a.provider.localeCompare(b.provider);
    });
  }

  // "Resets first" (quota toolbar's hourglass): earliest-package-expiry order
  // across PAGES. The dashboard's hourglass toggle was client-side-only — it
  // re-sorted just the ~20 connections on the current page using per-card
  // resetAt that only exists after the quota fetch lands, so with few live
  // resetAt values the order collapsed back to the default and the button
  // looked dead. The connection row already persists the routing-side
  // earliest-package expiry (earliestPackageExpiry, written by the usage
  // refresh path), so the server can sort the WHOLE list before paging.
  // Never-expiring (Infinity) sink to the bottom in provider/name order.
  if (sort === "expiring") {
    const expiryTime = (c) => {
      const t = c?.earliestPackageExpiry ? new Date(c.earliestPackageExpiry).getTime() : NaN;
      return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
    };
    return list.sort((a, b) => {
      const diff = expiryTime(a) - expiryTime(b);
      if (diff !== 0) return diff;
      return (
        (a.provider || "").localeCompare(b.provider || "") ||
        (a.name || "").localeCompare(b.name || "")
      );
    });
  }

  // Default band: group by PROVIDER first, then priority within the group.
  // Sorting priority-first split one provider's cards across bands wherever a
  // user had set per-connection priorities (minimax-code #187 pri 1 vs #131
  // pri 2 landed pages apart on the quota wall) — the provider is the mental
  // unit, the priority only ranks cards inside it. groupByProviderStable on
  // the client then keeps the whole group together.
  return list.sort((a, b) => {
    const providerDiff = (a.provider || "").localeCompare(b.provider || "");
    if (providerDiff !== 0) return providerDiff;
    const priorityA = a.priority ?? Number.MAX_SAFE_INTEGER;
    const priorityB = b.priority ?? Number.MAX_SAFE_INTEGER;
    if (priorityA !== priorityB) return priorityA - priorityB;
    return (a.name || "").localeCompare(b.name || "");
  });
}

export async function GET(request) {
  try {
    await backfillCodexEmails();

    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider") || "all";
    const accountStatus = searchParams.get("accountStatus") || "all";
    const sort = searchParams.get("sort") || "priority";
    const page = parsePositiveInt(searchParams.get("page"), 1);
    const pageSize = Math.min(parsePositiveInt(searchParams.get("pageSize"), DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);

    const allConnections = await getProviderConnections();
    const eligibleConnections = allConnections.filter(isUsageEligible);

    // External-pushed quota cards (CreditDaddy and successors): synthetic,
    // display-only rows living in _meta snapshots, never in the providers table.
    // Fail-soft — a broken snapshot layer must not blank the real connections.
    // They bypass isUsageEligible (that whitelist is about upstream credential
    // providers); "eligible" here simply means "has a card to show".
    let externalConnections = [];
    try {
      externalConnections = await buildExternalConnectionRows();
    } catch {
      externalConnections = [];
    }
    // 同名认领：与真实连接同 provider 同名的推送卡让位（数字改由连接卡展示，不重复出卡）。
    // 让位前先把推送卡的 refreshUrl 镜像到连接行——连接卡的刷新按钮据此 POST 回
    // 推送方现拉（否则认领后的卡刷新只会重读本地快照，CD 收不到请求）。
    try {
      attachClaimRefreshUrls(eligibleConnections, externalConnections);
      externalConnections = filterClaimedExternalRows(eligibleConnections, externalConnections);
    } catch { /* 认领过滤失败保留全部推送卡 */ }

    const mergedConnections = [...eligibleConnections, ...externalConnections];
    const providerOptions = Array.from(new Set(mergedConnections.map((conn) => conn.provider))).sort();

    const providerFilteredConnections = mergedConnections.filter((conn) => (
      provider === "all" || conn.provider === provider
    ));

    const accountFilteredConnections = providerFilteredConnections.filter((conn) => {
      if (accountStatus === "active") return conn.isActive ?? true;
      if (accountStatus === "inactive") return !(conn.isActive ?? true);
      return true;
    });

    const sortedConnections = sortConnections(accountFilteredConnections, sort);
    const total = sortedConnections.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const currentPage = Math.min(page, totalPages);
    const offset = (currentPage - 1) * pageSize;
    const pageConnections = sortedConnections.slice(offset, offset + pageSize).map(sanitize);

    return NextResponse.json({
      connections: pageConnections,
      providerOptions,
      pagination: {
        page: currentPage,
        pageSize,
        total,
        totalPages,
      },
      totals: {
        // External cards count here too: the page's empty-state gate reads
        // eligibleConnections, and pushed-only installs must still render.
        eligibleConnections: mergedConnections.length,
        providerFilteredConnections: providerFilteredConnections.length,
      },
    });
  } catch (error) {
    console.log("Error fetching providers for client:", error);
    return NextResponse.json({ error: "Failed to fetch providers" }, { status: 500 });
  }
}
