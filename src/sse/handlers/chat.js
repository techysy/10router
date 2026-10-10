import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  invalidateQuotaCache,
  extractApiKey,
  isValidApiKey,
  checkApiKeyDailyLimit,
} from "../services/auth.js";
import { getSettings, getChannelBlock, setChannelBlock, clearChannelBlock } from "@/lib/localDb";
import { buildChannelBlock, channelBlockRemainingMs, formatRetryAfter, withChannelScopeHint, withRateLimitHint } from "open-sse/services/accountFallback.js";
import { getModelInfo, getComboModels } from "../services/model.js";
import { isOversizedForCbcn, describeCbcnOversize } from "open-sse/executors/codebuddy-cn.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { upstreamResponseHeaders } from "open-sse/utils/upstreamHeaders.js";
import { handleComboChat, handleFusionChat, detectRequiredCapabilities } from "open-sse/services/combo.js";
import { maybeCompactChatBody } from "../services/autoCompact.js";
import { augmentModelsWithCapacityAdapter, withCapacityAdapterStripping, getActiveAdapterStrategy } from "open-sse/services/capacityAdapter.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken, persistRefreshedCredentials, markConnectionNeedsReauth } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  // Claude Code 会把 1M 上下文请求标成 `<model>[1m]`；标记匹配不到任何
  // combo/alias/provider-model 对，必须剥掉再进解析——能力由 anthropic-beta
  // 请求头原样透传。codex 侧则用 contextMarker 拼回请求侧 id，喂给账号
  // enabledModels 过滤（上游 v0.5.95, 9f41ee75）。
  const { model: modelStr, contextMarker } = stripModelContextMarker(body.model);
  if (contextMarker) body.model = modelStr;

  // Request summary is emitted as the unified "▶" line in chatCore (has fmt/thinking/account)

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  const limitResponse = await checkApiKeyDailyLimit(apiKey);
  if (limitResponse) return limitResponse;

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  // ── Auto-compaction for oversized contexts. Runs before combo/adapter
  // dispatch so every downstream path (single model, combo, fusion, capacity
  // adapter) sees ONE summarized body instead of individually hitting
  // "prompt is too long". Fail-open by design: any error keeps the original
  // request byte-identical. The internal summary call carries a guard header
  // so it can never recurse into this layer.
  try {
    await maybeCompactChatBody({
      request,
      body,
      modelStr,
      endpoint: clientRawRequest?.endpoint,
      settings,
    });
  } catch (e) {
    log.warn("COMPACT", `skipped: ${e?.message || e}`);
  }

  const requiredCapabilities = detectRequiredCapabilities(body);

  // Check if model is a combo (has multiple models with fallback)
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    // Check for combo-specific strategy first, fallback to global
    const comboStrategies = settings.comboStrategies || {};
    const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";
    const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, settings);
    const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

    if (comboStrategy === "fusion") {
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
      return handleFusionChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m, isPanel) => {
          let cleanRawReq = clientRawRequest;
          if (isPanel && clientRawRequest) {
            const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
            cleanRawReq = { ...clientRawRequest, body: cleanBody };
          }
          return handleSingleModelChat(b, m, cleanRawReq, request, apiKey);
        },
        log,
        comboName: modelStr,
        judgeModel: comboStrategies[modelStr]?.judgeModel,
        tuning: comboStrategies[modelStr]?.fusionTuning,
      });
    }

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    const retryOnEmpty = comboStrategies[modelStr]?.retryOnEmpty ?? settings.comboRetryOnEmpty ?? false;
    const retryOnEmptyLimit = comboStrategies[modelStr]?.retryOnEmptyLimit ?? settings.comboRetryOnEmptyLimit;
    log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: augmentedModels,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
      retryOnEmpty,
      retryOnEmptyLimit
    });
  }

  // Single model request — may still switch to a capacity-adapter model if the
  // target lacks a capability the request needs (e.g. no vision, request has an image).
  const soloAugmented = augmentModelsWithCapacityAdapter([modelStr], requiredCapabilities, settings);
  if (soloAugmented.length > 1) {
    const adapterAdded = soloAugmented.filter((m) => m !== modelStr);
    log.info("CHAT", `Capacity adapter for [${[...requiredCapabilities].join(",")}] on "${modelStr}" → trying ${soloAugmented.join(", ")}`);
    return handleComboChat({
      body,
      models: soloAugmented,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy: getActiveAdapterStrategy(requiredCapabilities, settings)
    });
  }

  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, {
    inferFallback: false,
    requestedModel: contextMarker ? `${modelStr.slice(modelStr.indexOf("/") + 1)}[${contextMarker}]` : null,
  });
}

/**
 * Handle single model chat request
 *
 * `inferFallback` stays TRUE for combo-internal model entries (a combo author
 * explicitly listed those names) and is FALSE only for the top-level client
 * request: there a bare name that matches no alias/combo is a client error —
 * /v1/models never advertises bare ids (#34), and the old prefix guess
 * produced misleading "No active credentials for provider: <guess>" 404s.
 *
 * `requestedModel` 是客户端要求的原始模型 id（可能带 [1m] 标记），与解析后的
 * 基础 id 分开传递：账号 enabledModels 勾选过滤按它判断（codex [1m]）。
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, { inferFallback = true, requestedModel = null } = {}) {
  const modelInfo = await getModelInfo(modelStr, { inferFallback });

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      const chatSettings = await getSettings();
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";
      const requiredCapabilities = detectRequiredCapabilities(body);
      const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, chatSettings);
      const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: comboModels,
          handleSingleModel: (b, m, isPanel) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey);
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
        });
      }

      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      const retryOnEmpty = comboStrategies[modelStr]?.retryOnEmpty ?? chatSettings.comboRetryOnEmpty ?? false;
      const retryOnEmptyLimit = comboStrategies[modelStr]?.retryOnEmptyLimit ?? chatSettings.comboRetryOnEmptyLimit;
      log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: augmentedModels,
        handleSingleModel: withCapacityAdapterStripping(
          (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
          adapterAdded
        ),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit,
        retryOnEmpty,
        retryOnEmptyLimit
      });
    }
    log.warn("CHAT", "Unknown model", { model: modelStr });
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Unknown model: "${modelStr}". It is not in /v1/models — send a provider-prefixed model id from GET /v1/models.`
    );
  }

  const { provider, model } = modelInfo;

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;
  let lastHeaders = null;

  // Pre-emptive protection for CodeBuddy CN — EXTREME-SIZE BACKSTOP ONLY.
  //
  // Evidence (2026-09-17, cbcn requestDetails + app log): 11128 fires on
  // requests as small as ~60KB while a 113KB request on the same account
  // succeeded. Payload size is therefore NOT the discriminating factor — the
  // upstream WAF keys on request *content/shape*, which we cannot evaluate
  // locally. This guard exists only to stop the pathological case (a ~5MB
  // agentic session, measured failing 100% of the time) from burning a
  // channel-breaker strike; it does NOT and cannot prevent ordinary 11128.
  // Real 11128 handling is the channel breaker below.
  if (provider === "codebuddy-cn" && isOversizedForCbcn(body)) {
    const stats = describeCbcnOversize(body);
    log.warn("CHAT", `[${provider}/${model}] payload exceeds extreme-size backstop (${stats}); rejected locally`);
    const hint = withChannelScopeHint(
      `[${provider}/${model}] 请求体积已达极端量级（${stats}），已在本地拦截，避免触发上游渠道级风控。`
    );
    return errorResponse(HTTP_STATUS.BAD_REQUEST, hint);
  }

  // A channel-scope failure (e.g. CodeBuddy 11128 "unapproved channel") is a
  // property of the channel, not of one account: every sibling answers exactly
  // the same, and walking the list only multiplies the burst. So the first such
  // answer stops the whole provider for CHANNEL_BLOCK_MS instead of retrying.
  const activeChannelBlock = await getChannelBlock(provider);
  const channelBlockLeftMs = channelBlockRemainingMs(activeChannelBlock);
  if (channelBlockLeftMs > 0) {
    const until = activeChannelBlock.until;
    const human = formatRetryAfter(until);
    log.warn("AUTH", `${provider} | channel blocked (${human}) — skipping all accounts`);
    return unavailableResponse(
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      withChannelScopeHint(`[${provider}/${model}] 上游渠道风控临时冷却中（${human}自动解冻）`),
      until,
      human,
    );
  }

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, { requestedModel: requestedModel || model });

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        // Cooldown is already running (backoff rule); translate a raw 429 JSON
        // blob into something actionable for the client (non-429 passes through).
        return unavailableResponse(
          status,
          withRateLimitHint(`[${provider}/${model}] ${errorMsg}`, provider),
          credentials.retryAfter,
          credentials.retryAfterHuman,
          lastHeaders,
        );
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(
        lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE,
        withRateLimitHint(lastError || "All accounts unavailable", provider),
        lastHeaders,
      );
    }

    // Account selection shown in the unified "▶" line (acc:...)
    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken, provider);
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // Use shared chatCore
    const chatSettings = await getSettings();
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
    const result = await handleChatCore({
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey,
      ccFilterNaming: !!chatSettings.ccFilterNaming,
      rtkEnabled: !!chatSettings.rtkEnabled,
      headroomEnabled: !!chatSettings.headroomEnabled,
      headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
      headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
      cavemanEnabled: !!chatSettings.cavemanEnabled,
      cavemanLevel: chatSettings.cavemanLevel || "full",
      ponytailEnabled: !!chatSettings.ponytailEnabled,
      ponytailLevel: chatSettings.ponytailLevel || "full",
      pxpipeEnabled: !!chatSettings.pxpipeEnabled,
      pxpipeMinChars: chatSettings.pxpipeMinChars,
      pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
      // Lazily warms the in-process module on first use; null when not installed (fail-open)
      pxpipeTransform: chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null,
      onPxpipeEvent: appendPxpipeEvent,
      providerThinking,
      // Detect source format by endpoint + body
      sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
      // Shared with every other handler on purpose: the inlined copies used to
      // disagree on which fields to write (some dropped lastRefreshAt/expiresAt,
      // which the "DB is newer" adoption guard compares on) and all of them
      // ignored the persist result. See persistRefreshedCredentials.
      onCredentialsRefreshed: async (newCreds) => {
        await persistRefreshedCredentials(credentials.connectionId, newCreds, {
          providerSpecificData: credentials.providerSpecificData,
          provider,
          log,
        });
      },
      // The failure sink that pairs with the one above: an unrecoverable refresh
      // (invalid_grant / refresh_token_reused) marks the account needs-re-auth
      // instead of leaving it in rotation to be re-probed every cooldown window.
      onCredentialsRefreshFailed: async (err) => {
        await markConnectionNeedsReauth(credentials.connectionId, { provider, reason: err, log });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
        // A success proves the channel is serving again — drop any block
        // immediately instead of making callers wait out the remaining window.
        // If one was actually in force, the covered window may have crossed a
        // package boundary, so invalidate the cached expiry timestamps too and
        // let the next selection refetch them (earliest-expiry ordering must not
        // rank accounts on data collected before the breaker).
        const hadBlock = (await getChannelBlock(provider)) !== null;
        await clearChannelBlock(provider);
        if (hadBlock) await invalidateQuotaCache(provider);
      }
    });

    if (result.success) return result.response;

    // Mark account unavailable (auto-calculates cooldown with exponential backoff, or precise resetsAtMs)
    const { shouldFallback, channelScope } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, result.resetsAtMs);

    if (shouldFallback && channelScope) {
      // Channel-scope: stop the whole provider rather than trying the next
      // account. Sibling accounts answer identically (verified on a 4-account
      // CodeBuddy pool: all four 11128 within one second), so the retry burst is
      // pure amplification. Escalates to a longer pause on repeat offences.
      const prev = await getChannelBlock(provider);
      const block = buildChannelBlock(prev);
      await setChannelBlock(provider, block);
      const human = formatRetryAfter(block.until);
      log.warn("AUTH", `${provider} | channel blocked for ${Math.round(block.durationMs / 1000)}s (strike ${block.strikes}${block.escalated ? ", escalated" : ""}) — aborting account fallback`);
      log.warn("CHAT", `[${provider}/${model}] ${result.error} (channel blocked, ${human})`);
      return unavailableResponse(
        result.status || HTTP_STATUS.SERVICE_UNAVAILABLE,
        withChannelScopeHint(`[${provider}/${model}] ${result.error}`),
        block.until,
        human,
      );
    }

    if (shouldFallback) {
      log.warn("FALLBACK", `⇄ ACC:${credentials.connectionName} UNAVAILABLE (${result.status}) → NEXT ACCOUNT`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      lastHeaders = upstreamResponseHeaders(result.response?.headers);
      continue;
    }

    return result.response;
  }
}
