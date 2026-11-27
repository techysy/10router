import { saveRequestUsage, appendRequestLog, saveRequestDetail } from "@/lib/usageDb.js";
import { COLORS } from "../../utils/stream.js";
import { canonicalizeUsage } from "../../utils/usageTracking.js";

const OPTIONAL_PARAMS = [
  "temperature", "top_p", "top_k",
  "max_tokens", "max_completion_tokens",
  "thinking", "reasoning", "enable_thinking",
  "presence_penalty", "frequency_penalty",
  "seed", "stop", "tools", "tool_choice",
  "response_format", "prediction", "store", "metadata",
  "n", "logprobs", "top_logprobs", "logit_bias",
  "user", "parallel_tool_calls"
];

export function extractRequestConfig(body, stream) {
  const config = { messages: body.messages || [], model: body.model, stream };
  for (const param of OPTIONAL_PARAMS) {
    if (body[param] !== undefined) config[param] = body[param];
  }
  return config;
}

export function extractUsageFromResponse(responseBody) {
  if (!responseBody || typeof responseBody !== "object") return null;

  // Claude format
  if (responseBody.usage?.input_tokens !== undefined) {
    return {
      prompt_tokens: responseBody.usage.input_tokens || 0,
      completion_tokens: responseBody.usage.output_tokens || 0,
      cache_read_input_tokens: responseBody.usage.cache_read_input_tokens,
      cache_creation_input_tokens: responseBody.usage.cache_creation_input_tokens
    };
  }

  // OpenAI format
  if (responseBody.usage?.prompt_tokens !== undefined) {
    return {
      prompt_tokens: responseBody.usage.prompt_tokens || 0,
      completion_tokens: responseBody.usage.completion_tokens || 0,
      cached_tokens: responseBody.usage.prompt_tokens_details?.cached_tokens,
      reasoning_tokens: responseBody.usage.completion_tokens_details?.reasoning_tokens
    };
  }

  // Gemini format. Antigravity / gemini-cli wrap the payload in { response: {...} }.
  const usageMetadata = responseBody.usageMetadata || responseBody.response?.usageMetadata;
  if (usageMetadata) {
    return {
      prompt_tokens: usageMetadata.promptTokenCount || 0,
      completion_tokens: usageMetadata.candidatesTokenCount || 0,
      cached_tokens: usageMetadata.cachedContentTokenCount || 0,
      reasoning_tokens: usageMetadata.thoughtsTokenCount || 0
    };
  }

  return null;
}

export function buildRequestDetail(base, overrides = {}) {
  return {
    provider: base.provider || "unknown",
    model: base.model || "unknown",
    connectionId: base.connectionId || undefined,
    timestamp: new Date().toISOString(),
    latency: base.latency || { ttft: 0, total: 0 },
    tokens: base.tokens || { prompt_tokens: 0, completion_tokens: 0 },
    request: base.request,
    providerRequest: base.providerRequest || null,
    providerResponse: base.providerResponse || null,
    response: base.response || {},
    pxpipe: base.pxpipe || undefined,
    status: base.status || "success",
    ...overrides
  };
}

// Build the "done" summary: duration, ttft, in/out tokens with cache breakdown
export function formatDoneLine({ usage, latency }) {
  const u = usage || {};
  const inTok = u.prompt_tokens ?? u.input_tokens ?? 0;
  const outTok = u.completion_tokens ?? u.output_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? u.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheCreate = u.cache_creation_input_tokens ?? 0;
  let inStr = `IN ${inTok}`;
  if (cacheRead || cacheCreate) {
    const parts = [];
    if (cacheRead) parts.push(`↻${cacheRead}`);
    if (cacheCreate) parts.push(`+${cacheCreate}`);
    inStr += ` (CACHE ${parts.join(" ")})`;
  }
  const ttftStr = latency?.ttft ? ` · TTFT ${latency.ttft}ms` : "";
  return `DONE ${latency?.total ?? 0}ms${ttftStr} · ${inStr} · OUT ${outTok}`;
}

export function saveUsageStats({ provider, model, tokens, connectionId, apiKey, endpoint, latency = null, usageKey = undefined, label = "USAGE", silent = false, status = "ok", error = null }) {
  const isError = status === "error";
  if ((!tokens || typeof tokens !== "object") && !isError) return;

  const inTokens = tokens?.input_tokens ?? tokens?.prompt_tokens ?? 0;
  const outTokens = tokens?.output_tokens ?? tokens?.completion_tokens ?? 0;

  // A failed turn usually has no usage at all — but it still happened, so it
  // still gets a row (status "error"), or the failure is invisible in
  // usageHistory. Successful zero-token rows keep the old drop.
  if (inTokens === 0 && outTokens === 0 && !isError) return;

  if (!silent) {
    const time = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const accountSuffix = connectionId ? ` | account=${connectionId.slice(0, 8)}...` : "";
    console.log(`${COLORS.green}[${time}] 📊 [${label}] ${provider.toUpperCase()} | in=${inTokens} | out=${outTokens}${accountSuffix}${COLORS.reset}`);
  }

  // Canonicalize to one storage convention (prompt_tokens cache-inclusive) so
  // cached/cache-creation tokens survive to cost calc + stats. See canonicalizeUsage.
  const safeTokens = (tokens && typeof tokens === "object") ? tokens : {};
  const normalized = canonicalizeUsage(safeTokens) || {
    prompt_tokens: safeTokens.prompt_tokens ?? safeTokens.input_tokens ?? 0,
    completion_tokens: safeTokens.completion_tokens ?? safeTokens.output_tokens ?? 0
  };

  // Latency observation rides on the usage row itself (meta.latencyMs/ttftMs):
  // usageHistory rows outlive the requestDetails 200-record ring and travel
  // with gateway-synced imports, so dashboards on BOTH instances show real
  // speed instead of a dash. Same numbers the requestDetails record gets —
  // no second measurement, just a second home.
  const meta = {};
  if (latency && typeof latency.total === "number" && latency.total > 0) {
    meta.latencyMs = Math.round(latency.total);
    if (typeof latency.ttft === "number" && latency.ttft > 0) {
      meta.ttftMs = Math.round(latency.ttft);
    }
  }
  // Failure rows carry the upstream error that killed the turn, so the row
  // is diagnosable without the requestDetails ring.
  if (error && typeof error === "object") {
    meta.upstreamError = {
      message: error.message || "Upstream error",
      ...(error.type ? { type: error.type } : {}),
      ...(error.code ? { code: error.code } : {}),
    };
  }

  saveRequestUsage({
    provider: provider || "unknown",
    model: model || "unknown",
    tokens: normalized,
    timestamp: new Date().toISOString(),
    connectionId: connectionId || undefined,
    apiKey: apiKey || undefined,
    endpoint: endpoint || null,
    // Forward the dedup key: every call site stamps one per upstream attempt.
    // Without it two distinct requests landing in the same millisecond with
    // identical token counts collapse into one row (the legacy content-only
    // dedup silently ate the second).
    usageKey,
    status,
    meta: Object.keys(meta).length > 0 ? meta : undefined
  }).catch(() => {});
}
