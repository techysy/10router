// OfficeAce chat executor.
//
// The upstream is plain OpenAI Chat Completions on `{gateway}/v2/chat/completions`
// with `Authorization: Basic base64(model_app_key:model_app_secret)`. Four
// provider-specific behaviours live here:
//
//   1. always stream — the gateway streams even when asked not to (both public
//      implementations force `stream:true` and aggregate locally), so we force
//      it and let the session layer fold the stream back for non-stream clients.
//   2. reasoning budget — `max_tokens` is the budget for reasoning + text; a
//      small value yields HTTP 200 with an EMPTY body and `finish_reason=length`
//      (reasoning ate it all). We *append* 1024 rather than `max()` so an
//      intentional tiny ask (max_tokens < 16) is passed through untouched.
//   3. output ceilings per family (see config/officeace.js). qwen3's ceiling is
//      an input+output total, so the local clamp is a conservative ceiling.
//   4. two walls — `81113` arrives WITH HTTP 429 and must be reclassified as
//      413 request-too-large (no retry, no account cooldown: the body, not the
//      account, is at fault), and `messages` length >= 5000 is rejected locally
//      before we spend a round trip on it.
//
// TODO(silent-200): the third known fake-success shape for this family is
// `200 + empty content + finish_reason=length` (reasoning consumed the budget).
// It is NOT rewritten here — mount a first-visible-delta guard in the stream
// relay (same place as atomcode's TODO) so a real empty completion can be told
// apart from a truncated one. Do not "fix" it by bumping max_tokens blindly.
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { errorResponse } from "../utils/error.js";
import {
  OFFICEACE_DEFAULT_GATEWAY_BASE,
  OFFICEACE_MESSAGES_LIMIT,
  OFFICEACE_REASONING_ALLOWANCE,
  OFFICEACE_TINY_MAX_TOKENS,
  OFFICEACE_TOO_LARGE_MARKERS,
  officeaceChatEndpoint,
  officeaceOutputLimitFor,
} from "../config/officeace.js";

const MAX_PEEK_BYTES = 32 * 1024;

/** `key:secret` (optionally `Basic `-prefixed) → Basic header value. */
export function officeaceBasicHeader(credentials) {
  const psd = credentials?.providerSpecificData || {};
  const fromFields = psd.modelAppKey && psd.modelAppSecret
    ? `${psd.modelAppKey}:${psd.modelAppSecret}`
    : "";
  const raw = String(credentials?.apiKey || credentials?.accessToken || fromFields).trim();
  if (!raw) return "";
  const pair = raw.replace(/^Basic\s+/i, "");
  if (pair.includes(":")) {
    return `Basic ${Buffer.from(pair, "utf8").toString("base64")}`;
  }
  return fromFields ? `Basic ${Buffer.from(fromFields, "utf8").toString("base64")}` : "";
}

function randomHex(bytes = 16) {
  try {
    return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");
  } catch {
    return Date.now().toString(16).padStart(bytes * 2, "0").slice(0, bytes * 2);
  }
}

/** True when the body matches the request-too-large family (81113 etc.). */
export function officeaceIsRequestTooLarge(bodyText) {
  const lower = String(bodyText || "").toLowerCase();
  if (!lower) return false;
  return OFFICEACE_TOO_LARGE_MARKERS.some((marker) => lower.includes(marker));
}

/** Human-readable 413 message for a too-large upstream body (or ""). */
export function officeaceRequestTooLargeMessage(bodyText) {
  if (!officeaceIsRequestTooLarge(bodyText)) return "";
  const excerpt = String(bodyText || "").replace(/\s+/g, " ").trim().slice(0, 300);
  return (
    "OfficeAce 上游拒绝了这份请求：请求体超过上限（81113）。" +
    "这条拒的是 messages 的条数（上游实测硬上限 5000 条），与 token 数无关——" +
    "要减少的是条数，把每条改短没用。" +
    (excerpt ? `上游原文：${excerpt}` : "")
  );
}

/** Local pre-flight: the `messages` count wall (>= 5000 is rejected upstream). */
export function officeaceMessageLimitViolation(body) {
  const count = Array.isArray(body?.messages) ? body.messages.length : 0;
  if (count < OFFICEACE_MESSAGES_LIMIT) return "";
  return (
    `messages 共 ${count} 条，达到 OfficeAce 的硬上限 ${OFFICEACE_MESSAGES_LIMIT} 条` +
    "（上游 81113；计的是条数，不是 token）。请在本地裁剪历史消息后再发。"
  );
}

/** Clamp a requested completion budget to the family ceiling. */
export function clampOfficeaceMaxTokens(model, value) {
  const limit = officeaceOutputLimitFor(model);
  const requested = Number(value);
  if (!limit || !Number.isFinite(requested) || requested <= 0) return value;
  return Math.min(Math.trunc(requested), limit.maxOutputTokens);
}

async function readPeek(response, limit = MAX_PEEK_BYTES) {
  if (!response?.body && typeof response?.text !== "function") return "";
  try {
    const clone = response.clone();
    if (!clone.body) return String(await clone.text()).slice(0, limit);
    const reader = clone.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (size < limit) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        chunks.push(chunk);
        size += chunk.length;
      }
    } finally {
      try { await reader.cancel(); } catch { /* already closed */ }
    }
    return Buffer.concat(chunks).subarray(0, limit).toString("utf8");
  } catch {
    return "";
  }
}

/** Inspect a non-OK response for the 81113 family. Returns "" when clean. */
export async function detectOfficeaceRequestTooLarge(response) {
  if (!response || response.ok) return "";
  return officeaceRequestTooLargeMessage(await readPeek(response));
}

export class OfficeAceExecutor extends BaseExecutor {
  constructor(provider = "officeace") {
    super(provider, PROVIDERS[provider] || PROVIDERS.officeace);
  }

  gatewayBaseOf(credentials) {
    const psd = credentials?.providerSpecificData || {};
    return (
      psd.baseUrl || psd.apiBase || psd.api_base || psd.gatewayBase ||
      this.config?.baseUrl || OFFICEACE_DEFAULT_GATEWAY_BASE
    );
  }

  buildUrl(_model, _stream, _urlIndex = 0, credentials = null) {
    return officeaceChatEndpoint(this.gatewayBaseOf(credentials)) ||
      officeaceChatEndpoint(OFFICEACE_DEFAULT_GATEWAY_BASE);
  }

  transformRequest(model, body, _stream) {
    if (!body || typeof body !== "object") return body;
    const payload = { ...body };
    // Upstream is streaming-only; non-stream clients are aggregated by chatCore.
    payload.stream = true;

    if (typeof payload.max_tokens === "number") {
      const raised = payload.max_tokens >= OFFICEACE_TINY_MAX_TOKENS
        ? payload.max_tokens + OFFICEACE_REASONING_ALLOWANCE
        : payload.max_tokens;
      payload.max_tokens = clampOfficeaceMaxTokens(model, raised);
    }
    if (payload.max_completion_tokens !== undefined) {
      payload.max_completion_tokens = clampOfficeaceMaxTokens(model, payload.max_completion_tokens);
    }

    // Always ask for the trailing usage frame; never override an explicit value.
    const options = payload.stream_options && typeof payload.stream_options === "object"
      ? { ...payload.stream_options }
      : {};
    if (options.include_usage === undefined) options.include_usage = true;
    payload.stream_options = options;
    return payload;
  }

  buildHeaders(credentials) {
    const headers = {
      "Content-Type": "application/json",
      // The request body is always `stream:true`, so accept a stream regardless
      // of what the client asked for; chatCore folds it back for JSON clients.
      Accept: "text/event-stream",
      lang: "en",
    };
    const auth = officeaceBasicHeader(credentials);
    if (auth) headers.Authorization = auth;
    headers["Chat-Id"] = randomHex(16);
    headers["Session-Id"] = randomHex(16);
    return headers;
  }

  async execute(options) {
    const body = options?.body;
    const violation = officeaceMessageLimitViolation(body);
    if (violation) {
      // Local pre-flight: no upstream call, no account penalty. 413 is a
      // request-scoped 4xx, so the fallback layer hands it straight back.
      return {
        response: errorResponse(413, violation),
        url: this.buildUrl(options?.model, options?.stream, 0, options?.credentials),
        headers: {},
        transformedBody: body,
      };
    }

    const result = await super.execute(options);
    const tooLarge = await detectOfficeaceRequestTooLarge(result.response);
    if (!tooLarge) return result;
    // Reclassify BEFORE chatCore sees the status: the upstream sends 81113 with
    // HTTP 429, and letting 429 through would cool the account and invite the
    // client to retry a body that can never pass. 413 is neither retried nor
    // cooled (accountFallback returns shouldFallback:false for non-scoped 4xx).
    return { ...result, response: errorResponse(413, tooLarge) };
  }

  parseError(response, bodyText) {
    const status = response?.status || 502;
    const text = String(bodyText || "");
    if (status === 413) {
      try {
        const parsed = JSON.parse(text);
        const message = parsed?.error?.message;
        if (typeof message === "string" && message.trim()) return { status: 413, message };
      } catch { /* not our envelope */ }
    }
    const tooLarge = officeaceRequestTooLargeMessage(text);
    if (tooLarge) return { status: 413, message: tooLarge };
    let message = "";
    try {
      const parsed = JSON.parse(text);
      message = parsed?.error?.message || parsed?.error_msg || parsed?.message || parsed?.error || "";
      if (typeof message !== "string") message = JSON.stringify(message);
    } catch {
      message = text;
    }
    return {
      status,
      message: String(message || "").trim().slice(0, 500) || `OfficeAce 上游返回 HTTP ${status}`,
    };
  }

  // The upstream answers 429 for a request-scoped wall; retrying the same body
  // is pointless. (Account-scoped rate limits still flow through as 429 and are
  // handled by the fallback layer.)
  shouldRetry(status, urlIndex) {
    if (status === 413) return false;
    return super.shouldRetry(status, urlIndex);
  }
}

export default OfficeAceExecutor;
