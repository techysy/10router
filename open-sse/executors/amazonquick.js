/**
 * AmazonQuickExecutor — sends OpenAI-format chat requests to Amazon
 * Quick's web-session Chat operation and translates its AWS EventStream
 * answer back into OpenAI SSE.
 *
 * Upstream shape (live-verified 2026-11-21; see
 * shared/amazonquick/constants.js for the full wire notes):
 *   POST /sn/account/{awsAccountId}/qbsproxy/quicksight/accounts/{awsAccountId}/conversations/chat?mbtc={csrf}
 *   auth = the browser session's Cookie header + x-amzn-csrf-token +
 *   x-amzn-target: api. No Authorization, no SigV4.
 *   body = { userMessage, awsAccountId, surfaceType, performanceMode, … }
 *   response = EventStream frames: textMessageEvent deltas, closed by a
 *   metadataEvent carrying finalTextMessage (the calibrated full text).
 *
 * Multi-turn strategy (perplexity-web pattern, hardened): Quick keeps
 * conversation state server-side, keyed by a conversationId it issues
 * on the first turn — there is no CreateConversation call and the
 * gateway's chat API is stateless, so the executor bridges the two:
 *   - the incoming messages are split into history + current message;
 *   - a hash of the history (scoped per account + credential, so two
 *     connections can never share a conversation) looks up the
 *     conversationId an earlier turn stored for exactly that prefix;
 *   - on a hit, only the current message is sent, with conversationId;
 *   - on a miss, a fresh conversation starts from a flattened
 *     transcript (system + history + current) so context survives
 *     gateway restarts and cache expiry — correctness never depends
 *     on the cache, it only saves re-sending the transcript;
 *   - when a turn completes, the full transcript (history + this
 *     exchange) is stored against the conversationId for the next turn.
 *
 * The executor always answers OpenAI SSE (qwenwork pattern): chatCore
 * converts for non-streaming clients, and Quick's first frame can take
 * minutes on agent turns, so the stream is committed only after the
 * first frame proves the session is alive (an immediate exception
 * frame becomes a real HTTP error instead of fake chat text).
 */

import { createHash } from "crypto";

import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { SSE_DONE } from "../utils/sseConstants.js";
import { sseChunk } from "../utils/sse.js";
import { FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import {
  AMAZONQUICK_SURFACE_TYPE,
  amazonQuickChatUrl,
  buildAmazonQuickHeaders,
  resolveAmazonQuickCredentials,
} from "../shared/amazonquick/constants.js";
import { amazonQuickPerformanceModeFor } from "../services/amazonquickModels.js";

// ─── AWS EventStream framing (same wire format as kiro's decoder) ───────────

const EVENTSTREAM_MAX_MESSAGE_BYTES = 24 * 1024 * 1024;
const EVENTSTREAM_MAX_HEADERS_BYTES = 128 * 1024;

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return value >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const frameDecoder = new TextDecoder();

/**
 * Parse one complete EventStream frame (prelude + headers + payload +
 * trailing CRC). Throws on framing/CRC corruption; a payload that is
 * not JSON is returned as raw text rather than killing the stream.
 */
function parseEventFrame(data) {
  if (!(data instanceof Uint8Array) || data.byteLength < 16) {
    throw new Error("AWS EventStream frame is shorter than 16 bytes");
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const totalLength = view.getUint32(0, false);
  const headersLength = view.getUint32(4, false);
  if (totalLength !== data.byteLength) {
    throw new Error("AWS EventStream frame length does not match its prelude");
  }
  if (totalLength > EVENTSTREAM_MAX_MESSAGE_BYTES ||
      headersLength > EVENTSTREAM_MAX_HEADERS_BYTES ||
      headersLength > totalLength - 16) {
    throw new Error("AWS EventStream frame bounds are invalid");
  }
  if (view.getUint32(8, false) !== crc32(data.subarray(0, 8))) {
    throw new Error("AWS EventStream prelude CRC mismatch");
  }
  if (view.getUint32(totalLength - 4, false) !== crc32(data.subarray(0, totalLength - 4))) {
    throw new Error("AWS EventStream message CRC mismatch");
  }

  const headers = Object.create(null);
  let offset = 12;
  const headerEnd = offset + headersLength;
  const requireBytes = (count) => {
    if (offset + count > headerEnd) {
      throw new Error("AWS EventStream header exceeds its declared bounds");
    }
  };

  while (offset < headerEnd) {
    requireBytes(1);
    const nameLength = data[offset++];
    requireBytes(nameLength + 1);
    const name = frameDecoder.decode(data.subarray(offset, offset + nameLength));
    offset += nameLength;
    const type = data[offset++];

    if (type === 0 || type === 1) {
      headers[name] = type === 0;
    } else if (type === 2) {
      requireBytes(1);
      headers[name] = view.getInt8(offset);
      offset += 1;
    } else if (type === 3) {
      requireBytes(2);
      headers[name] = view.getInt16(offset, false);
      offset += 2;
    } else if (type === 4) {
      requireBytes(4);
      headers[name] = view.getInt32(offset, false);
      offset += 4;
    } else if (type === 5 || type === 8) {
      requireBytes(8);
      offset += 8;
    } else if (type === 6 || type === 7) {
      requireBytes(2);
      const valueLength = view.getUint16(offset, false);
      offset += 2;
      requireBytes(valueLength);
      const bytes = data.subarray(offset, offset + valueLength);
      headers[name] = type === 7 ? frameDecoder.decode(bytes) : bytes;
      offset += valueLength;
    } else if (type === 9) {
      requireBytes(16);
      offset += 16;
    } else {
      throw new Error(`AWS EventStream header ${name} has unknown type ${type}`);
    }
  }

  const payloadBytes = data.subarray(headerEnd, totalLength - 4);
  if (payloadBytes.byteLength === 0) return { headers, payload: null };
  const payloadText = frameDecoder.decode(payloadBytes);
  if (!payloadText.trim()) return { headers, payload: null };
  try {
    return { headers, payload: JSON.parse(payloadText) };
  } catch {
    return { headers, payload: payloadText };
  }
}

/** Incremental frame splitter: feed socket chunks, get complete frames. */
class EventStreamDecoder {
  constructor() {
    this.buffer = new Uint8Array(0);
  }

  push(chunk) {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
    const frames = [];
    while (this.buffer.length >= 12) {
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
      const totalLength = view.getUint32(0, false);
      if (totalLength < 16 || totalLength > EVENTSTREAM_MAX_MESSAGE_BYTES) {
        throw new Error("AWS EventStream frame bounds are invalid");
      }
      if (this.buffer.length < totalLength) break;
      frames.push(parseEventFrame(this.buffer.slice(0, totalLength)));
      this.buffer = this.buffer.slice(totalLength);
    }
    return frames;
  }
}

/** Async-iterate the frames of a web ReadableStream response body. */
async function* decodeEventStream(body) {
  const reader = body.getReader();
  const decoder = new EventStreamDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength) {
        for (const frame of decoder.push(value)) yield frame;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/**
 * Normalize a frame to { kind: "event" | "exception", eventType, payload }.
 * On the wire the union member name rides the :event-type header and the
 * payload is the member struct; accept a wrapped { member: struct }
 * payload too, in case a proxy re-shapes it.
 */
function eventFromFrame(frame) {
  const headers = frame?.headers || {};
  const exceptionType = headers[":exception-type"];
  if (headers[":message-type"] === "exception" || headers[":message-type"] === "error" || exceptionType) {
    return { kind: "exception", eventType: exceptionType || "", payload: frame.payload };
  }
  let payload = frame?.payload ?? null;
  let eventType = headers[":event-type"] || "";
  if (payload && typeof payload === "object") {
    if (!eventType && Object.keys(payload).length === 1) {
      eventType = Object.keys(payload)[0];
      payload = payload[eventType];
    } else if (eventType && Object.keys(payload).length === 1 && payload[eventType] && typeof payload[eventType] === "object") {
      payload = payload[eventType];
    }
  }
  // Model-level exceptions (internalFailureException, …) arrive as
  // ordinary events whose member name ends in "Exception".
  if (/exception$/i.test(eventType)) {
    return { kind: "exception", eventType, payload };
  }
  return { kind: "event", eventType, payload };
}

function exceptionMessage(eventType, payload) {
  if (typeof payload === "string" && payload) return payload;
  const msg = payload?.message || payload?.Message || payload?.errorMessage || null;
  if (typeof msg === "string" && msg) return msg;
  return eventType ? `amazonquick upstream exception (${eventType})` : "amazonquick upstream exception";
}

// ─── OpenAI message splitting + transcript flattening ───────────────────────

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && (c.type === "text" || typeof c.text === "string"))
      .map((c) => String(c.text || ""))
      .join(" ");
  }
  return "";
}

/**
 * Split OpenAI messages into { systemText, history, currentMsg } — the
 * perplexity-web split. Only text survives: Quick's Chat takes a single
 * userMessage string (attachments ride a separate upload flow the
 * gateway does not drive in v1).
 */
function parseQuickMessages(messages) {
  let systemText = "";
  const history = [];
  for (const msg of messages || []) {
    let role = String(msg?.role || "user");
    if (role === "developer") role = "system";
    const content = extractText(msg?.content);
    if (!content.trim()) continue;
    if (role === "system") systemText += (systemText ? "\n" : "") + content;
    else if (role === "user" || role === "assistant") history.push({ role, content });
  }
  let currentMsg = "";
  if (history.length > 0 && history[history.length - 1].role === "user") {
    currentMsg = history.pop().content;
  }
  return { systemText, history, currentMsg };
}

/**
 * The userMessage for a FRESH upstream conversation: bare current
 * message when there is nothing else; otherwise a readable transcript
 * so the new conversation starts with the full context.
 */
function buildUserMessage({ systemText, history, currentMsg }) {
  if (history.length === 0 && !systemText) return currentMsg;
  const parts = [];
  if (systemText) parts.push(`[System]\n${systemText}`);
  for (const h of history) {
    parts.push(`${h.role === "user" ? "User" : "Assistant"}: ${h.content}`);
  }
  parts.push(`User: ${currentMsg}`);
  return parts.join("\n\n");
}

// ─── Conversation-id session cache (history-prefix → conversationId) ────────

const SESSION_MAX_AGE_MS = 3600_000;
const SESSION_MAX_ENTRIES = 200;

/** Map<key, { conversationId, ts }> */
const sessionCache = new Map();

function sessionScopeKey(creds) {
  const fingerprint = createHash("sha256").update(creds.cookie || "").digest("hex").slice(0, 16);
  return `${creds.awsAccountId}:${fingerprint}`;
}

function sessionKey(scopeKey, history) {
  const parts = history.map((h) => `${h.role}:${h.content}`).join("\n");
  return createHash("sha256").update(`${scopeKey}\n${parts}`).digest("hex");
}

function sessionLookup(scopeKey, history) {
  if (history.length === 0) return null;
  const key = sessionKey(scopeKey, history);
  const entry = sessionCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > SESSION_MAX_AGE_MS) {
    sessionCache.delete(key);
    return null;
  }
  return entry.conversationId;
}

function sessionStore(scopeKey, history, currentMsg, responseText, conversationId) {
  if (!conversationId) return;
  const full = [...history, { role: "user", content: currentMsg }, { role: "assistant", content: responseText }];
  sessionCache.set(sessionKey(scopeKey, full), { conversationId, ts: Date.now() });
  if (sessionCache.size > SESSION_MAX_ENTRIES) {
    let oldestKey = null;
    let oldestTs = Infinity;
    for (const [k, v] of sessionCache) {
      if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k; }
    }
    if (oldestKey) sessionCache.delete(oldestKey);
  }
}

// ─── Request body ────────────────────────────────────────────────────────────

function buildAmazonQuickRequestBody({ model, parsed, conversationId, awsAccountId }) {
  const body = {
    userMessage: conversationId ? parsed.currentMsg : buildUserMessage(parsed),
    awsAccountId,
    surfaceType: AMAZONQUICK_SURFACE_TYPE,
    temporaryChat: false,
    userMetadata: {
      localTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    },
    // The web UI only sends performanceMode when its model-picker flag
    // is on, but the service accepts it directly (verified live).
    performanceMode: amazonQuickPerformanceModeFor(model),
    additionalChatContext: { chatOptions: { disableWebSearch: false } },
  };
  if (conversationId) body.conversationId = conversationId;
  return body;
}

// ─── EventStream → OpenAI SSE ────────────────────────────────────────────────

function errorResponse(status, message) {
  return new Response(
    JSON.stringify({ error: { message, type: "provider_error", code: status } }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * Wrap the frame iterator (first frame already pulled by the peek in
 * execute) into an OpenAI SSE response. Text deltas stream as they
 * arrive; when the metadataEvent's finalTextMessage shows the deltas
 * missed a tail (or were re-ordered), the missing suffix is flushed
 * before the finish chunk so the client ends with the calibrated
 * full text. The session store runs on completion with that text.
 */
function wrapAmazonQuickSSE({ iterator, firstFrame, model, seedConversationId, session, log }) {
  const encoder = new TextEncoder();
  const cid = `chatcmpl-aq-${crypto.randomUUID().slice(0, 12)}`;
  const created = Math.floor(Date.now() / 1000);
  let conversationId = seedConversationId || null;
  let accumulated = "";
  let finalText = null;

  const chunk = (delta, finishReason = null) => sseChunk({
    id: cid,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
  });

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (text) => controller.enqueue(encoder.encode(text));
      try {
        emit(chunk({ role: "assistant" }));

        let pending = firstFrame;
        while (pending !== null) {
          const frame = pending.value;
          pending = null;
          if (frame) {
            const ev = eventFromFrame(frame);
            if (ev.kind === "exception") {
              emit(chunk({ content: `[amazonquick error: ${exceptionMessage(ev.eventType, ev.payload)}]` }));
              break;
            }
            const payload = ev.payload && typeof ev.payload === "object" ? ev.payload : {};
            if (typeof payload.conversationId === "string" && payload.conversationId) {
              conversationId = payload.conversationId;
            }
            if (ev.eventType === "textMessageEvent") {
              const delta = typeof payload.textMessage === "string" ? payload.textMessage : "";
              if (delta) {
                accumulated += delta;
                emit(chunk({ content: delta }));
              }
            } else if (ev.eventType === "metadataEvent") {
              if (typeof payload.finalTextMessage === "string" && payload.finalTextMessage) {
                finalText = payload.finalTextMessage;
              }
            }
            // All other events (intermediate narration, artifacts,
            // permission requests, heartbeats) are agent-side surface
            // the chat pipeline cannot act on in v1 — ignored by design.
          }
          const next = await iterator.next();
          if (!next.done) pending = next;
        }

        // Calibrate against the metadata full text: flush a missed
        // tail; a divergent finalText cannot retract streamed deltas,
        // so it only wins for the stored transcript.
        const fullText = finalText ?? accumulated;
        if (finalText && finalText.startsWith(accumulated) && finalText.length > accumulated.length) {
          emit(chunk({ content: finalText.slice(accumulated.length) }));
        } else if (finalText && finalText !== accumulated) {
          log?.warn?.("AMAZONQUICK", "finalTextMessage diverged from streamed deltas; keeping deltas for the client, finalText for the transcript");
        }

        emit(chunk({}, "stop"));
        emit(SSE_DONE);
        if (session) {
          sessionStore(session.scopeKey, session.history, session.currentMsg, fullText, conversationId);
        }
      } catch (err) {
        try {
          emit(chunk({ content: `[Stream error: ${err.message || String(err)}]` }, "stop"));
          emit(SSE_DONE);
        } catch { /* already closed */ }
      } finally {
        try { controller.close(); } catch { /* already closed */ }
        await iterator.return?.().catch(() => {});
      }
    },
    async cancel() {
      await iterator.return?.().catch(() => {});
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}

// ─── Executor ────────────────────────────────────────────────────────────────

export class AmazonQuickExecutor extends BaseExecutor {
  constructor(providerId = "amazonquick") {
    super(providerId, PROVIDERS[providerId] || PROVIDERS.amazonquick);
    this.providerId = providerId;
  }

  async execute({ model, body, credentials, signal, log, proxyOptions = null }) {
    const creds = resolveAmazonQuickCredentials(credentials);
    const url = creds.awsAccountId
      ? amazonQuickChatUrl(creds.awsAccountId, creds.csrf)
      : "https://quick.aws.com/sn/account/<awsAccountId>/qbsproxy/quicksight/accounts/<awsAccountId>/conversations/chat";

    if (creds.missing.length > 0) {
      // Name the missing fields so the dashboard nudges a re-paste of
      // exactly what the curl harvest missed.
      return {
        response: errorResponse(401, `amazonquick credential is missing: ${creds.missing.join(", ")} — in a logged-in quick.aws.com tab, right-click any qbsproxy request in devtools → Network, Copy as cURL, and paste the whole command into the connection's credential field`),
        url,
        headers: {},
        transformedBody: body,
      };
    }

    const messages = body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return {
        response: errorResponse(400, "Missing or empty messages array"),
        url,
        headers: {},
        transformedBody: body,
      };
    }

    const parsed = parseQuickMessages(messages);
    if (!parsed.currentMsg) {
      return {
        response: errorResponse(400, "amazonquick chat needs a trailing user message"),
        url,
        headers: {},
        transformedBody: body,
      };
    }

    const scopeKey = sessionScopeKey(creds);
    const conversationId = sessionLookup(scopeKey, parsed.history);
    if (conversationId) log?.info?.("AMAZONQUICK", `Session continue: ${conversationId.slice(0, 12)}...`);

    const payload = buildAmazonQuickRequestBody({
      model,
      parsed,
      conversationId,
      awsAccountId: creds.awsAccountId,
    });

    const headers = {
      ...buildAmazonQuickHeaders(creds),
      Accept: "application/x-amz-eventstream",
    };

    // Abort if upstream doesn't return response headers within the
    // configured budget (agent turns are slow; see registry timeoutMs).
    const timeoutMs = this.config?.timeoutMs || FETCH_CONNECT_TIMEOUT_MS;
    const connectCtrl = new AbortController();
    const connectTimer = setTimeout(() => connectCtrl.abort(new Error("fetch connect timeout")), timeoutMs);
    const mergedSignal = signal ? AbortSignal.any([signal, connectCtrl.signal]) : connectCtrl.signal;

    let response;
    try {
      response = await proxyAwareFetch(
        url,
        { method: "POST", headers, body: JSON.stringify(payload), signal: mergedSignal },
        proxyOptions,
      );
    } finally {
      clearTimeout(connectTimer);
    }

    if (!response.ok || !response.body) {
      let detail = "";
      try { detail = (await response.text()).slice(0, 300); } catch { /* unreadable body */ }
      if (response.status === 401 || response.status === 403) {
        return {
          response: errorResponse(response.status, "amazonquick auth failed — the web session cookie is expired or invalid. Paste a fresh Copy as cURL from a logged-in quick.aws.com tab into the connection's credential field."),
          url,
          headers,
          transformedBody: payload,
        };
      }
      const status = response.status >= 400 && response.status <= 599 ? response.status : 502;
      return {
        response: errorResponse(status, `amazonquick upstream error (${response.status})${detail ? `: ${detail}` : ""}`),
        url,
        headers,
        transformedBody: payload,
      };
    }

    // Peek the first frame: an immediate exception (dead session,
    // throttling) becomes a real HTTP error; an empty stream is a 502.
    const iterator = decodeEventStream(response.body);
    const first = await iterator.next().catch((err) => ({ done: true, error: err }));
    if (first.done || first.error) {
      await iterator.return?.().catch(() => {});
      return {
        response: errorResponse(502, `amazonquick returned an empty event stream${first.error ? `: ${first.error.message}` : ""}`),
        url,
        headers,
        transformedBody: payload,
      };
    }
    const firstEvent = eventFromFrame(first.value);
    if (firstEvent.kind === "exception") {
      await iterator.return?.().catch(() => {});
      return {
        response: errorResponse(502, `amazonquick upstream exception: ${exceptionMessage(firstEvent.eventType, firstEvent.payload)}`),
        url,
        headers,
        transformedBody: payload,
      };
    }

    const wrapped = wrapAmazonQuickSSE({
      iterator,
      firstFrame: first,
      model,
      seedConversationId: response.headers?.get?.("x-amzn-conversation-id") || conversationId,
      session: { scopeKey, history: parsed.history, currentMsg: parsed.currentMsg },
      log,
    });
    return { response: wrapped, url, headers, transformedBody: payload };
  }

  // Cookie sessions cannot be renewed — expiry surfaces as the 401
  // above and the user re-pastes a fresh Copy as cURL.
  async refreshCredentials() {
    return null;
  }

  needsRefresh() {
    return false;
  }
}

export default AmazonQuickExecutor;

// Internals exposed for unit tests. Not part of the public API.
export const __test__ = {
  crc32,
  parseEventFrame,
  EventStreamDecoder,
  decodeEventStream,
  eventFromFrame,
  parseQuickMessages,
  buildUserMessage,
  buildAmazonQuickRequestBody,
  sessionLookup,
  sessionStore,
  sessionScopeKey,
  clearSessions() { sessionCache.clear(); },
};
