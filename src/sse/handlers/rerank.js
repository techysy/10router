import { getRoutingIdentity } from "../services/routingIdentity.js";
import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
  checkApiKeyDailyLimit,
} from "../services/auth.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo } from "../services/model.js";
import { handleRerankCore } from "open-sse/handlers/rerankCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import * as log from "../utils/logger.js";
import { saveRequestUsage } from "@/lib/usageDb.js";

/**
 * Handle rerank requests for the Next.js server.
 * Follows the same auth + account-fallback pattern as handleSystemone
 * (which itself mirrors handleEmbeddings). Rerank lanes are API-key only
 * today, so there is no token-refresh hop — a rerank provider that grows an
 * OAuth lane adds checkAndRefreshToken here, nothing else.
 *
 * @param {Request} request
 */
export async function handleRerank(request) {
  const requestStartTime = Date.now();
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("RERANK", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const url = new URL(request.url);
  const modelStr = body.model;

  log.request("POST", `${url.pathname} | ${modelStr}`);

  // Log API key (masked)
  const apiKey = extractApiKey(request);
  if (apiKey) {
    log.debug("AUTH", `API Key: ${log.maskKey(apiKey)}`);
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

  const limitResponse = await checkApiKeyDailyLimit(apiKey, { request, model: modelStr });
  if (limitResponse) return limitResponse;

  if (!modelStr) {
    log.warn("RERANK", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) {
    log.warn("RERANK", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  if (modelStr !== `${provider}/${model}`) {
    log.info("ROUTING", `${modelStr} → ${provider}/${model}`);
  } else {
    log.info("ROUTING", `Provider: ${provider}, Model: ${model}`);
  }

  // Credential + fallback loop (mirrors handleSystemone)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  const routingIdentity = getRoutingIdentity(request, apiKey, body);
  while (true) {
  const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, { routingIdentity });

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("RERANK", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.error("AUTH", `No credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
      }
      log.warn("RERANK", "No more accounts available", { provider });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    log.info("AUTH", `\x1b[32mUsing ${provider} account: ${credentials.connectionName}\x1b[0m`);

    const result = await handleRerankCore({
      body,
      modelInfo: { provider, model },
      credentials,
      log,
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
      },
    });

    if (result.success) {
      credentials.commitSession?.([]);
      if (result.usage) {
        saveRequestUsage({
          provider,
          model,
          connectionId: credentials.connectionId,
          apiKey,
          endpoint: url.pathname,
          tokens: result.usage,
          status: "success",
          meta: { latencyMs: Date.now() - requestStartTime },
        }).catch(() => {});
      }
      return result.response;
    }

    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model);

    if (shouldFallback) {
      log.warn("AUTH", `Account ${credentials.connectionName} unavailable (${result.status}), trying fallback`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }
}
