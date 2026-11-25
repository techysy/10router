/**
 * QoderExecutor — sends OpenAI-format chat requests to Qoder's COSY-signed
 * inference endpoint at api3.qoder.sh, then unwraps Qoder's `{statusCodeValue,
 * body}` SSE envelope back into plain OpenAI SSE for the rest of the pipeline.
 *
 * Differences vs the previous placeholder:
 *   - URL is api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation
 *     with `&Encode=1` so we can ship the body through the WAF-bypass
 *     encoder.
 *   - Authentication is COSY (RSA + AES + MD5 + ~17 Cosy-* headers), not
 *     a static HMAC.
 *   - The request shape Qoder expects is non-trivial (chat_context with
 *     mirrored modelConfig, business block with stable IDs, system text
 *     hoisted out of the messages array). All ported from the reference.
 *   - Model identifier is one of the canonical Qoder keys (auto / ultimate /
 *     performance / efficient / lite + frontier "*model" ids); the
 *     translator layer feeds us "qoder/<key>" so we strip the prefix.
 *   - Per-model `model_config` is fetched live from /algo/api/v2/model/list
 *     and cached. Sending the wrong block silently downgrades to a
 *     different model upstream, so a missing entry is a hard error.
 */

import { qoderEncodeBody } from "../shared/qoder/encoding.js";
import { buildCosyHeaders } from "../shared/qoder/cosy.js";
import { v4 as uuidv4 } from "uuid";
import { createHash } from "crypto";

import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { SSE_DONE } from "../utils/sseConstants.js";
import { FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import {
  QODER_CHAT_URL_ENCODED,
  QODER_CHAT_BASE_ALT,
  QODER_CHAT_SIG_PATH,
  QODER_MODEL_MAP,
  QODER_CN_GATEWAY_BASE,
} from "../shared/qoder/constants.js";
import { getQoderModelConfig, resolveQoderModels, isQoderPat, resolveQoderCredentials } from "../services/qoderModels.js";
import { OPENAI_BLOCK, CLAUDE_BLOCK } from "../translator/schema/blocks.js";
import { encodeDataUri } from "../translator/concerns/image.js";

/**
 * Hoist role:"system" messages out of the messages array (Qoder rejects
 * system in messages) and flatten multipart content arrays — EXCEPT image
 * blocks, which are preserved (see normalizeContent).
 */
function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages: [], systemText: "" };
  }
  const systemParts = [];
  const out = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    if (msg.role === "system") {
      const text = extractText(msg.content);
      if (text) systemParts.push(text);
      continue;
    }
    const cloned = { ...msg };
    cloned.content = normalizeContent(msg.content);
    out.push(cloned);
  }
  return { messages: out, systemText: systemParts.join("\n\n") };
}

/**
 * Normalize one message's content for Qoder.
 *
 * Text-only content is flattened to a plain string (Qoder's historical
 * shape). When images are present the content stays an array and image
 * blocks are kept as OpenAI-style `image_url` parts — verified against the
 * upstream: it accepts both http(s) URLs and inline base64 data: URIs
 * directly, no pre-upload to the /image/upload OSS flow required (that is
 * a qodercli client-side choice, not a protocol requirement). The legacy
 * top-level `image_urls` / `chat_context.imageUrls` slots stay null —
 * qodercli leaves them null too.
 *
 * Claude-style `{type:"image", source:{...}}` blocks are converted to
 * `image_url` so claude-format clients also round-trip.
 */
function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (!Array.isArray(content)) return String(content);

  const blocks = [];
  const textParts = [];
  let hasImage = false;
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    if (item.type === OPENAI_BLOCK.IMAGE_URL && typeof item.image_url?.url === "string" && item.image_url.url) {
      blocks.push({ type: OPENAI_BLOCK.IMAGE_URL, image_url: { url: item.image_url.url } });
      hasImage = true;
    } else if (item.type === CLAUDE_BLOCK.IMAGE && item.source) {
      // Claude base64/url image → OpenAI image_url equivalent.
      const src = item.source;
      const url = src.type === "base64" && src.data
        ? encodeDataUri(src.media_type || "image/png", src.data)
        : typeof src.url === "string" && src.url ? src.url : null;
      if (url) {
        blocks.push({ type: OPENAI_BLOCK.IMAGE_URL, image_url: { url } });
        hasImage = true;
      }
    } else if (typeof item.text === "string" && item.text) {
      if (hasImage || blocks.length) {
        // Keep ordering faithful once images are in play.
        blocks.push({ type: OPENAI_BLOCK.TEXT, text: item.text });
      } else {
        textParts.push(item.text);
      }
    }
  }

  if (!hasImage) return textParts.join("\n");
  // Prepend any text collected before the first image block.
  if (textParts.length) blocks.unshift({ type: OPENAI_BLOCK.TEXT, text: textParts.join("\n") });
  return blocks;
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (item && typeof item === "object") {
        if (item.type === "text" && typeof item.text === "string") {
          parts.push(item.text);
        } else if (typeof item.text === "string") {
          parts.push(item.text);
        }
      }
    }
    return parts.join("\n");
  }
  return String(content);
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) return extractText(m.content);
  }
  return "";
}

function stableHash(prefix, ...parts) {
  const h = createHash("sha256");
  h.update(prefix);
  for (const p of parts) {
    h.update("\0");
    h.update(String(p ?? ""));
  }
  return h.digest("hex").slice(0, 16);
}

function stableChatRecordId(model, messages, tools, maxTokens) {
  const h = createHash("sha256");
  h.update("qoder-record\0");
  h.update(String(model));
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    if (m.role) { h.update("\0"); h.update(m.role); }
    if (typeof m.content === "string" && m.content) {
      h.update("\0"); h.update(m.content);
    } else if (Array.isArray(m.content)) {
      // Include image refs so the same prompt with a different image gets
      // a distinct chat_record_id.
      h.update("\0");
      try { h.update(JSON.stringify(m.content)); } catch {}
    }
  }
  if (tools) {
    h.update("\0");
    try { h.update(JSON.stringify(tools)); } catch {}
  }
  h.update(`\0mt=${maxTokens}`);
  return h.digest("hex").slice(0, 16);
}

function truncate(s, n) {
  return s && s.length > n ? `${s.slice(0, n)}...` : s || "";
}

/**
 * Map the OpenAI-style request body into the exact shape Qoder expects.
 */
async function buildQoderRequestBody({ model, body, credentials, log, proxyOptions, signal }) {
  const qoderKey = String(model || "").replace(/^qoder\//, "");
  
  // Fetch model config from dynamic API instead of relying on static QODER_MODEL_MAP.
  // This allows support for new Qoder models (e.g., qmodel_latest) without code changes.
  let modelConfig = await getQoderModelConfig(credentials, qoderKey, { log, proxyOptions, signal });
  if (!modelConfig) {
    // Try a forced refresh once before giving up — the cache may simply
    // not be populated yet on first ever call for this credential.
    const refreshed = await resolveQoderModels(credentials, { forceRefresh: true, log, proxyOptions, signal });
    const retried = refreshed?.rawConfigs.get(qoderKey);
    if (!retried) {
      throw new Error(
        `qoder: model_config for "${qoderKey}" not yet known (run a model list fetch or check upstream connectivity)`,
      );
    }
    modelConfig = { ...retried, key: qoderKey };
  }

  const { messages, systemText } = normalizeMessages(body.messages || []);
  const tools = body.tools;
  const isReasoning = !!modelConfig.is_reasoning;
  const maxOutputTokens = Number(modelConfig.max_output_tokens) || 0;

  let maxTokens = 32_768;
  if (maxOutputTokens > 0) maxTokens = maxOutputTokens;
  if (typeof body.max_tokens === "number" && body.max_tokens > 0 && body.max_tokens < maxTokens) {
    maxTokens = body.max_tokens;
  }
  if (typeof body.max_completion_tokens === "number" && body.max_completion_tokens > 0 && body.max_completion_tokens < maxTokens) {
    maxTokens = body.max_completion_tokens;
  }

  const lastUser = lastUserText(messages);
  const psd = credentials.providerSpecificData || {};
  const sessionId = stableHash("qoder-session", psd.userId, qoderKey);
  const recordId = stableChatRecordId(qoderKey, messages, tools, maxTokens);

  return {
    qoderKey,
    payload: {
      request_id: uuidv4(),
      request_set_id: recordId,
      chat_record_id: recordId,
      session_id: sessionId,
      stream: true,
      chat_task: "FREE_INPUT",
      is_reply: true,
      is_retry: false,
      source: 1,
      version: "3",
      session_type: "qodercli",
      agent_id: "agent_common",
      task_id: "common",
      code_language: "",
      chat_prompt: "",
      image_urls: null,
      aliyun_user_type: "",
      system: systemText,
      messages,
      tools: Array.isArray(tools) ? tools : [],
      parameters: { max_tokens: maxTokens },
      chat_context: {
        chatPrompt: "",
        imageUrls: null,
        extra: {
          context: [],
          modelConfig: { key: qoderKey, is_reasoning: isReasoning },
          originalContent: lastUser,
        },
        features: [],
        text: lastUser,
      },
      model_config: modelConfig,
      business: {
        product: "cli",
        version: "1.0.0",
        type: "agent",
        stage: "start",
        id: uuidv4(),
        name: truncate(lastUser, 30),
        begin_at: Date.now(),
      },
    },
    modelConfig,
  };
}

/**
 * Check if a qoder error message indicates a billing/quota block.
 * Signatures: code 110 (billing daily count exceeded), code 112 (quota
 * exhausted), code 10605 (queue throttle), pricingUrl field.
 */
// The signature code is often nested one JSON level deep inside a generic
// envelope, so its quotes arrive escaped — NAS 2026-09-26:
//   {"code":"403","message":"{\"code\":\"10605\",\"message\":\"{\\\"isQueued\\\":true,…
// `\\*` before each quote accepts any escaping depth.
const QODER_BLOCK_CODE_RE = /\\*"code\\*"\s*:\s*\\*"(110|112|10605)\\*"/;
const QODER_RETRY_AFTER_RE = /\\*"retryAfterSeconds\\*"\s*:\s*(\d+)/;
// Estimated seconds until the GLOBAL per-model queue drains. The official
// client's "模型请求正在排队" clock — usually minutes. retryAfterSeconds (30)
// is only the re-poll interval; cooling 30s for a queue minutes deep just
// bought another 429 (NAS 2026-10-27: queueCount 1742, waitTime 390).
const QODER_WAIT_TIME_RE = /\\*"waitTime\\*"\s*:\s*(\d+)/;

function billingBlockCode(inner) {
  if (!inner || typeof inner !== "string") return null;
  const m = inner.match(QODER_BLOCK_CODE_RE);
  if (m) return m[1];
  return inner.toLowerCase().includes("pricingurl") ? "pricingUrl" : null;
}

function isBillingBlock(inner) {
  return billingBlockCode(inner) !== null;
}

/**
 * Turn a detected block or upstream error into the HTTP error chatCore acts on.
 * 10605 is a queue throttle ("isQueued", "retryAfterSeconds":30), not an
 * exhausted account: answer 429 and restate the wait in words
 * extractRetrySeconds understands, so the account cools for the time the
 * upstream asked for instead of the 2-minute 403 lock.
 * 112 / pricingUrl stay 403 (quota gone → long cooldown, fall through).
 * Other errors (like 429 provider_error / All backends failed, 5xx) return
 * the upstream status so chatCore can trigger fallback or return proper error.
 */
function qoderErrorResponse(code, statusVal, message) {
  if (code === "10605") {
    // waitTime (queue-drain estimate), not retryAfterSeconds (re-poll
    // interval), is the honest cooldown: extractRetrySeconds picks the first
    // "retry after N seconds" in this text, and the hint precedes the raw body.
    const waitSec = Number((message.match(QODER_WAIT_TIME_RE) || [])[1])
      || Number((message.match(QODER_RETRY_AFTER_RE) || [])[1])
      || 0;
    const hint = waitSec ? `, retry after ${waitSec} seconds` : "";
    return new Response(
      JSON.stringify({ error: { message: `qoder queue throttle (10605)${hint}: ${message}`, code: statusVal } }),
      { status: 429, headers: { "Content-Type": "application/json" } }
    );
  }
  if (code === "110" || code === "112" || code === "pricingUrl") {
    return new Response(
      JSON.stringify({ error: { message, code: statusVal } }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
  }
  const httpStatus = statusVal >= 400 && statusVal <= 599 ? statusVal : 502;
  return new Response(
    JSON.stringify({ error: { message, code: statusVal, type: "provider_error" } }),
    { status: httpStatus, headers: { "Content-Type": "application/json" } }
  );
}

/**
 * Peek the first SSE frame to detect errors (billing blocks, provider_error, etc.) before piping.
 * Returns { isError, isBilling, code, statusVal, message, consumed } — `consumed` is every
 * byte read so far (including the peeked line) so the caller can re-process
 * it and nothing is dropped from the stream.
 */
async function peekFirstQoderFrame(reader, decoder) {
  let consumed = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return { isError: false, isBilling: false, consumed, upstreamDone: true };

    consumed += decoder.decode(value, { stream: true });
    const nl = consumed.indexOf("\n");
    if (nl === -1) continue; // need a full line first

    const line = consumed.slice(0, nl).replace(/\r$/, "").trim();
    if (!line.startsWith("data:")) continue;

    const data = line.slice(5).trimStart();
    if (data === "[DONE]") return { isError: false, isBilling: false, consumed };

    let envelope;
    try { envelope = JSON.parse(data); } catch { return { isError: false, isBilling: false, consumed }; }

    const statusVal = typeof envelope.statusCodeValue === "number" ? envelope.statusCodeValue : 200;
    const inner = typeof envelope.body === "string" ? envelope.body : "";

    if (statusVal !== 200) {
      const code = billingBlockCode(inner);
      return {
        isError: true,
        isBilling: code !== null,
        code,
        statusVal,
        message: inner || `qoder upstream error (${statusVal})`,
      };
    }
    return { isError: false, isBilling: false, consumed };
  }
}

/**
 * Wrap the upstream's `{statusCodeValue, body}` SSE envelope into plain
 * OpenAI SSE chunks the rest of the chatCore pipeline understands.
 *
 * Each upstream line looks like:
 *   data: {"statusCodeValue":200,"body":"{\"choices\":[{\"delta\":{...}}]}"}
 * The inner body is an OpenAI streaming chunk (or "[DONE]"). We unwrap it
 * and re-emit as `data: <inner>\n\n`. Errors become a synthetic OpenAI error
 * chunk + [DONE].
 *
 * Critical: Qoder's SSE often keeps the socket open after the terminal
 * [DONE]/error frame (agent keepalive). Non-streaming clients drain via
 * response.text() which hangs until the socket closes — so on terminal
 * events we cancel the upstream reader and close our stream immediately.
 *
 * Peek first frame to detect billing blocks (code 112/10605/pricingUrl).
 * If detected, return an HTTP error (403, or 429 for the 10605 queue
 * throttle) so chatCore cools the connection down and falls back instead of
 * leaking error text into chat.
 */
async function wrapQoderSSE(response, model) {
  if (!response.ok || !response.body) return response;

  const decoder = new TextDecoder();
  const reader = response.body.getReader();

  // Peek first frame to detect errors (billing block, provider_error, etc.)
  const peek = await peekFirstQoderFrame(reader, decoder);
  if (peek?.isError) {
    // Upstream error on the first frame — fail this connection so chatCore can
    // trigger fallback/error handling instead of emitting fake text to the client.
    await reader.cancel().catch(() => {});
    return qoderErrorResponse(peek.code, peek.statusVal, peek.message);
  }

  return wrapFromPeek(response, model, reader, decoder, peek);
}

/**
 * Stream-building half of wrapQoderSSE, usable after an external peek — the
 * queue-wait loop in execute() peeks itself so it can decide to resend before
 * committing to a stream.
 */
function wrapFromPeek(response, model, reader, decoder, peek) {
  // Normal flow: re-process every byte the peek consumed, then continue.
  let buffer = peek.consumed || "";
  const upstreamDrained = peek.upstreamDone === true;
  const encoder = new TextEncoder();
  let doneEmitted = false;

  // Process one already-extracted SSE line (no trailing newline).
  const processLine = (line, controller) => {
    const trimmed = line.replace(/\r$/, "").trim();
    if (!trimmed) return;
    if (!trimmed.startsWith("data:")) return;
    if (doneEmitted) return;

    const data = trimmed.slice(5).trimStart();
    if (data === "[DONE]") {
      controller.enqueue(encoder.encode(SSE_DONE));
      doneEmitted = true;
      return;
    }

    let envelope;
    try { envelope = JSON.parse(data); } catch { return; }
    const statusVal = typeof envelope.statusCodeValue === "number" ? envelope.statusCodeValue : 200;
    const inner = typeof envelope.body === "string" ? envelope.body : "";
    if (statusVal !== 200) {
      const msg = inner || `upstream status ${statusVal}`;
      const errChunk = JSON.stringify({
        id: `qoder-error-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        error: {
          message: `[qoder error ${statusVal}: ${truncate(msg, 200)}]`,
          type: "provider_error",
          code: statusVal,
        },
      });
      controller.enqueue(encoder.encode(`data: ${errChunk}\n\n`));
      controller.enqueue(encoder.encode(SSE_DONE));
      doneEmitted = true;
      return;
    }
    if (!inner) return;
    if (inner === "[DONE]") {
      controller.enqueue(encoder.encode(SSE_DONE));
      doneEmitted = true;
      return;
    }
    // Strip embedded newlines so the SSE frame stays a single event.
    const sanitized = inner.replace(/\r?\n/g, "");
    controller.enqueue(encoder.encode(`data: ${sanitized}\n\n`));
  };

  const stream = new ReadableStream({
    // Use start()+loop (not pull): a pull that buffers a partial line without
    // enqueueing would never be re-invoked, hanging consumers like .text().
    async start(controller) {
      try {
        // Drain whatever the peek already pulled off the socket first.
        let nlSeed;
        while ((nlSeed = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nlSeed);
          buffer = buffer.slice(nlSeed + 1);
          processLine(line, controller);
          if (doneEmitted) {
            await reader.cancel().catch(() => {});
            controller.close();
            return;
          }
        }
        if (upstreamDrained) {
          // Peek hit end-of-stream: flush any trailing partial line.
          buffer += decoder.decode();
          if (buffer.length > 0) {
            processLine(buffer, controller);
            buffer = "";
          }
        }

        while (!doneEmitted && !upstreamDrained) {
          const { done, value } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            if (buffer.length > 0) {
              processLine(buffer, controller);
              buffer = "";
            }
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            processLine(line, controller);
            if (doneEmitted) {
              // Terminal frame received — drop upstream keepalive and end.
              await reader.cancel().catch(() => {});
              controller.close();
              return;
            }
          }
        }
      } catch {
        // fall through to terminal [DONE] + close
      } finally {
        if (!doneEmitted) {
          try {
            controller.enqueue(encoder.encode(SSE_DONE));
            doneEmitted = true;
          } catch { /* already closed */ }
        }
        try { controller.close(); } catch { /* already closed */ }
        await reader.cancel().catch(() => {});
      }
    },
    cancel() {
      return reader.cancel().catch(() => {});
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}

// ─── Queue-wait (10605) — stand in line like the official client does ────────
//
// 10605 is a GLOBAL per-model admission queue, not an account fault: NAS
// 2026-10-27, five accounts answered within seconds, all quoting the same
// queueCount=1742. Switching accounts cannot dodge it (the official client
// never tries — it just re-polls every retryAfterSeconds until waitTime
// elapses). Three pieces here:
//   A. execute() waits, re-signs, resends the SAME body (bounded by
//      QUEUE_WAIT_*) instead of failing the account on the first 10605 —
//      this is the "模型请求正在排队，预计等待不足 1 分钟" behavior.
//   B. when the budget runs out, a per-(provider,model) flag makes sibling
//      accounts fail fast — the account walk would otherwise serialize
//      N × 90s of queue-standing for one global verdict.
//   C. the 429 text carries waitTime, so extractRetrySeconds locks the model
//      for the real window instead of the 30s re-poll interval.

/** Max re-sends after the initial attempt (each preceded by one poll wait). */
const QUEUE_WAIT_MAX_RESENDS = 2;
/** Total time allowed standing in line across all rounds. */
const QUEUE_WAIT_MAX_TOTAL_MS = 90_000;
/** Fast-fail window after giving up — capped, so a recovery probe happens. */
const QUEUE_FLAG_MAX_MS = 120_000;

/** providerId:modelKey → { until: number, waitSec: number } */
const queueFlags = new Map();

// Tests inject an instant waiter; null → real abortable sleep.
let queueSleeper = null;

function defaultWait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted while waiting out qoder queue"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted while waiting out qoder queue"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.("abort", onAbort);
  });
}

export class QoderExecutor extends BaseExecutor {
  /**
   * @param {string} providerId - "qoder" (global) or "qoder-cn"
   * @param {string} chatBaseAlt - api2-equivalent host for jt- tokens
   */
  constructor(providerId = "qoder", chatBaseAlt = QODER_CHAT_BASE_ALT) {
    super(providerId, PROVIDERS[providerId] || PROVIDERS.qoder);
    this.providerId = providerId;
    this.chatBaseAlt = chatBaseAlt;
    this.isCn = providerId === "qoder-cn";
  }

  buildUrl(credentials) {
    // Job-token (jt-...) traffic must hit the alt gateway — api3/gateway
    // rejects jt- with "Login expired" (403). Device tokens stay on the
    // primary host.
    const raw = credentials?.apiKey || credentials?.accessToken;
    if (typeof raw === "string" && !raw.startsWith("pt-") && (raw.startsWith("jt-") || (credentials?.accessToken || "").startsWith("jt-"))) {
      return `${this.chatBaseAlt}/algo${QODER_CHAT_SIG_PATH}?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;
    }
    if (this.isCn) {
      return `${QODER_CN_GATEWAY_BASE}/algo${QODER_CHAT_SIG_PATH}?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;
    }
    return QODER_CHAT_URL_ENCODED;
  }

  // Override execute entirely — Qoder needs:
  //   - body built from translated chat completion payload
  //   - body encoded with QoderEncodeBody before signing
  //   - COSY headers built from the *encoded* body bytes
  //   - response stream re-wrapped from {statusCodeValue, body} to OpenAI SSE
  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    // PAT (pt-...) → exchange for short-lived job token + resolve userId so
    // downstream COSY signing + catalog fetch work. Device tokens (dt-...) and
    // job tokens (jt-...) skip this and are used directly.
    const rawToken = credentials?.apiKey || credentials?.accessToken;
    if (isQoderPat(rawToken)) {
      try {
        credentials = await resolveQoderCredentials(credentials, proxyOptions, signal);
      } catch (err) {
        log?.error?.("QODER", `PAT exchange failed: ${err.message}`);
        const fakeResp = new Response(
          JSON.stringify({ error: { message: `qoder PAT exchange failed: ${err.message}` } }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
        return { response: fakeResp, url: this.buildUrl(credentials), headers: {}, transformedBody: body };
      }
    }

    const url = this.buildUrl(credentials);
    const psd = credentials?.providerSpecificData || {};
    if (!psd.userId) {
      // No user id → no way to sign. Surface a 401 so the dashboard nudges
      // the user back to OAuth.
      const fakeResp = new Response(
        JSON.stringify({ error: { message: "qoder credential is missing userId; reconnect the account" } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
      return { response: fakeResp, url, headers: {}, transformedBody: body };
    }
    if (!credentials?.accessToken) {
      // Same shape as the userId guard — clean 401 so chatCore reports
      // "reconnect" rather than bubbling cosy.js's synchronous throw as 500.
      const fakeResp = new Response(
        JSON.stringify({ error: { message: "qoder credential is missing accessToken; reconnect the account" } }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
      return { response: fakeResp, url, headers: {}, transformedBody: body };
    }

    let qoderKey;
    let payload;
    try {
      ({ qoderKey, payload } = await buildQoderRequestBody({ model, body, credentials, log, proxyOptions, signal }));
    } catch (err) {
      const fakeResp = new Response(
        JSON.stringify({ error: { message: err.message } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
      return { response: fakeResp, url, headers: {}, transformedBody: body };
    }

    const plainBody = Buffer.from(JSON.stringify(payload), "utf8");
    const encodedBodyStr = qoderEncodeBody(plainBody);
    const encodedBodyBuf = Buffer.from(encodedBodyStr, "latin1");

    // B: a sibling account just measured this model's queue (or hit a hard
    // throttle) seconds ago. The verdict is global — same model, same queue,
    // regardless of account — so fail fast instead of paying another connect +
    // queue-wait to learn it again. Capped window, so recovery is probed.
    const flagKey = `${this.providerId}:${qoderKey}`;
    const liveFlag = queueFlags.get(flagKey);
    if (liveFlag && liveFlag.until > Date.now()) {
      const flagSec = Math.max(1, Math.ceil((liveFlag.until - Date.now()) / 1000));
      const fakeResp = new Response(
        JSON.stringify({
          error: {
            message: `qoder ${qoderKey} is still queued upstream (global per-model queue, est. clear ~${liveFlag.waitSec}s; all accounts share it) — skipping re-attempt, retry after ${flagSec} seconds`,
            code: 429,
            type: "provider_error",
          },
        }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      );
      return { response: fakeResp, url, headers: {}, transformedBody: body };
    }

    const buildHeaders = () => {
      let cosyHeaders;
      try {
        cosyHeaders = buildCosyHeaders(
          encodedBodyBuf,
          url,
          {
            userId: psd.userId,
            authToken: credentials.accessToken,
            name: credentials.displayName || "",
            email: credentials.email || "",
            machineId: psd.machineId || "",
          },
        );
      } catch (err) {
        // cosy.js throws synchronously on missing userId/authToken — surface
        // as 401 so chatCore prompts re-auth instead of returning a 500.
        const errResp = new Response(
          JSON.stringify({ error: { message: `qoder cosy signing failed: ${err.message}` } }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
        return { error: errResp };
      }
      const modelSource = (payload.model_config && payload.model_config.source) || "system";
      return {
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
          "X-Model-Key": qoderKey,
          "X-Model-Source": modelSource,
          // gzip triggers signature validation on Qoder's CDN; force identity.
          "Accept-Encoding": "identity",
          ...cosyHeaders,
        },
      };
    };

    // Abort if upstream doesn't return response headers within connect timeout.
    const timeoutMs = this.config?.timeoutMs || FETCH_CONNECT_TIMEOUT_MS;

    // A: send → peek → on 10605 wait the poll interval and re-sign/resend the
    // SAME body (the signature is timestamped per request, the body is not).
    let totalQueuedMs = 0;
    let resends = 0;
    while (true) {
      const built = buildHeaders();
      if (built.error) return { response: built.error, url, headers: {}, transformedBody: body };
      const headers = built.headers;

      const connectCtrl = new AbortController();
      const connectTimer = setTimeout(() => connectCtrl.abort(new Error("fetch connect timeout")), timeoutMs);
      const mergedSignal = signal ? AbortSignal.any([signal, connectCtrl.signal]) : connectCtrl.signal;

      let response;
      try {
        response = await proxyAwareFetch(
          url,
          { method: "POST", headers, body: encodedBodyBuf, signal: mergedSignal },
          proxyOptions,
        );
      } finally {
        clearTimeout(connectTimer);
      }

      if (!response.ok || !response.body) {
        // Pass error response through unchanged so chatCore can capture it.
        return { response, url, headers, transformedBody: payload };
      }

      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      const peek = await peekFirstQoderFrame(reader, decoder);
      const isQueue = peek?.isError && peek.code === "10605";
      // "All backends failed" 429s are the same global saturation without a
      // stated wait — not worth a blind resend, but the fast-fail flag applies.
      const isHardThrottle = peek?.isError && peek.statusVal === 429;

      if (isQueue || isHardThrottle) {
        await reader.cancel().catch(() => {});
        const retrySec = Number((peek.message.match(QODER_RETRY_AFTER_RE) || [])[1]) || 30;
        const waitSec = Math.max(retrySec, Number((peek.message.match(QODER_WAIT_TIME_RE) || [])[1]) || 0);

        if (isQueue && resends < QUEUE_WAIT_MAX_RESENDS && totalQueuedMs + waitSec * 1000 <= QUEUE_WAIT_MAX_TOTAL_MS) {
          resends += 1;
          totalQueuedMs += waitSec * 1000;
          log?.info?.("QODER", `${qoderKey} queued upstream (depth ~${waitSec}s); standing in line round ${resends}/${QUEUE_WAIT_MAX_RESENDS}`);
          await (queueSleeper || defaultWait)(waitSec * 1000, signal);
          continue;
        }

        // Give up: record the verdict so the account walk fast-fails (B) and
        // answer 429 with the real wait (C).
        const flagMs = Math.min((waitSec || retrySec) * 1000, QUEUE_FLAG_MAX_MS);
        queueFlags.set(flagKey, { until: Date.now() + flagMs, waitSec: waitSec || retrySec });
        return {
          response: qoderErrorResponse(peek.code, peek.statusVal, peek.message),
          url,
          headers,
          transformedBody: payload,
        };
      }

      if (peek?.isError) {
        await reader.cancel().catch(() => {});
        return {
          response: qoderErrorResponse(peek.code, peek.statusVal, peek.message),
          url,
          headers,
          transformedBody: payload,
        };
      }

      // Served — also proves the queue drained, so drop any stale flag.
      queueFlags.delete(flagKey);
      const wrapped = wrapFromPeek(response, `qoder/${qoderKey}`, reader, decoder, peek);
      return { response: wrapped, url, headers, transformedBody: payload };
    }
  }

  // Qoder device tokens don't refresh through OAuth — the upstream returns
  // 403 for our flow. Surfacing failure via 401-on-chat is enough; the
  // dashboard tells users to re-login when their token expires (~30 days).
  async refreshCredentials() {
    return null;
  }

  needsRefresh() {
    return false;
  }
}

export default QoderExecutor;

// Internals exposed for unit tests. Not part of the public API — callers
// should import QoderExecutor and use its public methods.
export const __test__ = {
  normalizeMessages,
  wrapQoderSSE,
  wrapFromPeek,
  buildQoderRequestBody,
  isBillingBlock,
  qoderErrorResponse,
  peekFirstQoderFrame,
  queueFlags,
  QUEUE_WAIT_MAX_RESENDS,
  QUEUE_WAIT_MAX_TOTAL_MS,
  QUEUE_FLAG_MAX_MS,
  setQueueSleeper(fn) { queueSleeper = fn; },
  resetQueueSleeper() { queueSleeper = null; },
};
