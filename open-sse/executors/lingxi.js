/*
 * LingxiExecutor — WPS 灵犀 (lingxi.kdocs.cn) web-cookie provider.
 *
 * Credential (connection.apiKey) = the WPS session Cookie header (wps_sid /
 * kso_sid …, captured from a logged-in lingxi.kdocs.cn browser session or
 * synced from CreditDaddy). No signature headers: the web client's
 * signPopToken always returns "empty" (the X-Pop-Token header is only
 * computed by the WPS desktop native SDK), so a plain Cookie jar is the
 * complete auth — verified live 2026-11-15.
 *
 * Upstream protocol (two calls per turn):
 *   1. POST /solution/api/aigc/v3/assistant/sessions          → {data:{session_id}}
 *      (the /solution prefix applies to every /api/aigc/* path; /api/public/v1/*
 *      paths — checkin/balance, CreditDaddy's line — do NOT take it)
 *   2. POST .../sessions/{session_id}/completions  body {question, thinking, …}
 *      → text/event-stream where every frame is
 *        event: execution|aigc
 *        data: {"type":"text","data":"<delta>","message_id":"…", …}
 *      Content deltas live in the `data` field of type:"text" frames (NOT
 *      OpenAI's choices[].delta), reasoning in type:"reasoning" data.text,
 *      per-turn end is type:"end" and the whole round ends with event:finish.
 *
 * Auth failures arrive INSIDE the stream: a 200 with
 *   event:error + {"result":"UserUnauthorized"} + event:finish
 * so liveness must be judged from stream content — we synthesize a 401 for
 * the standard refresh/needs-reauth pipeline in that case.
 *
 * Billing (verified 2026-11-15, free-tier accounts): base 对话-mode turns do
 * NOT deduct 灵点 ("暂不消耗智点" per the web UI); the multiplier table
 * (plans endpoint) only bites on Pro/Max subscriptions / heavy features.
 */

import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { SSE_DONE, SSE_HEADERS_NO_BUFFER } from "../utils/sseConstants.js";
import { sseChunk } from "../utils/sse.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

const LINGXI_BASE = "https://lingxi.kdocs.cn";
const SESSIONS_URL = `${LINGXI_BASE}/solution/api/aigc/v3/assistant/sessions`;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

// Auth-error results carried inside the SSE error frame (bundle enum Ip).
const AUTH_RESULTS = new Set(["UserUnauthorized", "Unauthorized"]);

// thinking:"enabled" streams a separate reasoning channel; the web client's
// enum is auto/enabled/disabled (no per-effort levels upstream — reasoning
// effort only exists as a UI hint for paid-tier models).
const THINKING_MODES = new Set(["auto", "enabled", "disabled"]);

// Plan-mode model ids expect_model:"plan_pro"|"plan_max" + current_mode:"plan".
const PLAN_MODELS = new Set(["plan_pro", "plan_max"]);

/**
 * Flatten OpenAI messages into a single `question` string. Lingxi takes one
 * prompt per turn (stateless from our side — a fresh session each request);
 * system prompts are prepended, older turns are kept as "role: text" context
 * so multi-turn clients still see coherent behaviour.
 */
export function flattenMessages(messages) {
  const parts = [];
  const extracted = [];
  for (const msg of Array.isArray(messages) ? messages : []) {
    let role = String(msg?.role || "user");
    if (role === "developer") role = "system";
    let text = "";
    if (typeof msg?.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg?.content)) {
      text = msg.content
        .filter((c) => c?.type === "text")
        .map((c) => String(c.text || ""))
        .join("\n");
    }
    if (!String(text).trim()) continue;
    extracted.push({ role, text: String(text) });
  }

  const lastUserIdx = (() => {
    for (let i = extracted.length - 1; i >= 0; i--) {
      if (extracted[i].role === "user") return i;
    }
    return extracted.length - 1;
  })();

  for (let i = 0; i < extracted.length; i++) {
    const { role, text } = extracted[i];
    parts.push(i === lastUserIdx ? text : `${role}: ${text}`);
  }
  return parts.join("\n\n");
}

/**
 * Map our registry model id to the upstream request fields.
 *  - "auto"      → no expect_model (server default)
 *  - plan_pro/plan_max → expect_model + current_mode:"plan"
 *  - anything else     → expect_model:<id> (plans endpoint model keys pass through)
 * Reasoning intent: thinking:"enabled" only for models the client asked to
 * think (openai reasoning_effort≥medium maps below) or explicit thinking param.
 */
export function resolveUpstreamFields(model, body) {
  const fields = {};
  if (model && model !== "auto") {
    fields.expect_model = model;
    if (PLAN_MODELS.has(model)) fields.current_mode = "plan";
  }
  // Thinking intent: honor an explicit upstream-style thinking param first,
  // then OpenAI reasoning_effort ("none"/"minimal" → off, otherwise on).
  const explicit = body?.thinking;
  if (typeof explicit === "string" && THINKING_MODES.has(explicit)) {
    fields.thinking = explicit;
  } else {
    const effort = String(body?.reasoning_effort || "").toLowerCase();
    fields.thinking = effort && effort !== "none" && effort !== "minimal" ? "enabled" : "disabled";
  }
  return fields;
}

function jsonError(status, message, code) {
  return new Response(
    JSON.stringify({ error: { message, type: "upstream_error", ...(code ? { code } : {}) } }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

function buildLingxiHeaders(cookie, stream) {
  const h = {
    "Content-Type": "application/json; charset=utf-8",
    Accept: stream ? "text/event-stream" : "application/json",
    Referer: `${LINGXI_BASE}/`,
    Origin: LINGXI_BASE,
    "X-Cc-Version": "1",
    "X-Client-Type": "pc_web",
    "X-Cc-Entrance": "web",
    "User-Agent": USER_AGENT,
  };
  if (cookie) h["Cookie"] = cookie;
  return h;
}

/**
 * Parse the cookie credential down to the WPS session names the API needs.
 * Accepts a raw Cookie header string or an exported cookies JSON array
 * [{name,value},…] — same contract as the other webCookie providers.
 */
export function normalizeCookie(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (s.startsWith("[") || s.startsWith("{")) {
    try {
      const arr = JSON.parse(s);
      const list = Array.isArray(arr) ? arr : [arr];
      return list
        .map((c) => (c?.name ? `${c.name}=${c.value ?? ""}` : null))
        .filter(Boolean)
        .join("; ");
    } catch {
      return s;
    }
  }
  return s;
}

/** Read SSE frames into {event, data} objects; tolerant of partial buffers. */
export function parseLingxiSseFrame(rawFrame) {
  let event = "";
  const dataLines = [];
  for (const line of String(rawFrame).split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (!dataLines.length) return { event, data: null, raw: "" };
  const raw = dataLines.join("\n");
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    data = null;
  }
  return { event, data, raw };
}

/**
 * Walk the upstream SSE body, yielding normalized events:
 *   {delta}                — content text
 *   {reasoning}            — thinking text
 *   {error:{result,hint}}  — in-stream error frame
 *   {done:true}            — terminal (type:"end" seen, or event:finish, or stream end)
 * Non-text chatter (websearch/recommend/…) is consumed silently.
 */
export async function* readLingxiEvents(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawEnd = false;
  try {
    outer: while (true) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const idx = buffer.indexOf("\n\n");
        if (idx < 0) break;
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const parsed = parseLingxiSseFrame(frame);
        const ev = yield* handleFrame(parsed, () => { sawEnd = true; });
        if (ev === "stop") break outer;
      }
    }
    // flush a trailing frame without the closing blank line
    const tail = buffer.trim();
    if (tail) {
      const parsed = parseLingxiSseFrame(tail);
      yield* handleFrame(parsed, () => { sawEnd = true; });
    }
  } finally {
    reader.releaseLock();
  }
  yield { done: true };
}

/** Handle one parsed frame; "stop" return = terminate stream consumption. */
function* handleFrame(parsed, markEnd) {
  const { event, data } = parsed;
  if (event === "finish") {
    markEnd();
    return "stop";
  }
  if (!data || typeof data !== "object") return;
  const type = String(data.type || "");

  if (type === "text" && typeof data.data === "string" && data.data) {
    yield { delta: data.data };
    return;
  }
  if (type === "reasoning") {
    const t = data.data?.text;
    if (typeof t === "string" && t) yield { reasoning: t };
    return;
  }
  if (type === "end") {
    markEnd();
    yield { done: true };
    return "stop";
  }
  if (event === "error" || type === "error" || type === "error_msg") {
    const result = String(data.result || data.code || "upstream_error");
    const hint = String(data.hint || data.msg || data.message || "");
    yield { error: { result, hint } };
    return;
  }
  // websearch_*/recommend_*/tool_call_*/parsefile_*/process … — progress chatter
}

function syntheticAuthResponse(message) {
  return jsonError(401, message, "needs_reauth");
}

function buildStreamingResponse(eventStream, model, cid, created, signal) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      let content = "";
      let reasoning = "";
      let streamError = null;
      const base = { id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: null };
      try {
        controller.enqueue(
          encoder.encode(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null, logprobs: null }] }))
        );

        for await (const ev of readLingxiEvents(eventStream, signal)) {
          if (ev.error) {
            if (AUTH_RESULTS.has(ev.error.result)) {
              streamError = { auth: true, message: `灵犀会话已失效 (${ev.error.result})` };
              break;
            }
            const msg = ev.error.hint ? `${ev.error.hint} (${ev.error.result})` : ev.error.result;
            controller.enqueue(
              encoder.encode(
                sseChunk({ ...base, choices: [{ index: 0, delta: { content: `[Error: ${msg}]` }, finish_reason: null, logprobs: null }] })
              )
            );
            continue;
          }
          if (ev.reasoning) {
            reasoning += ev.reasoning;
            controller.enqueue(
              encoder.encode(
                sseChunk({ ...base, choices: [{ index: 0, delta: { reasoning_content: ev.reasoning }, finish_reason: null, logprobs: null }] })
              )
            );
            continue;
          }
          if (ev.delta) {
            content += ev.delta;
            controller.enqueue(
              encoder.encode(
                sseChunk({ ...base, choices: [{ index: 0, delta: { content: ev.delta }, finish_reason: null, logprobs: null }] })
              )
            );
            continue;
          }
          if (ev.done) break;
        }

        if (streamError?.auth) {
          // Replace the role frame we already sent with a terminal 401-shaped
          // error so chatCore routes it through refreshCredentials/needs-reauth.
          controller.enqueue(
            encoder.encode(sseChunk({ ...base, error: { message: streamError.message, type: "authentication_error", code: "needs_reauth" } }))
          );
        }
        controller.enqueue(
          encoder.encode(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop", logprobs: null }] }))
        );
        controller.enqueue(encoder.encode(SSE_DONE));
      } catch (err) {
        controller.enqueue(
          encoder.encode(
            sseChunk({
              ...base,
              choices: [{ index: 0, delta: { content: `[Stream error: ${err.message || String(err)}]` }, finish_reason: "stop", logprobs: null }],
            })
          )
        );
        controller.enqueue(encoder.encode(SSE_DONE));
      } finally {
        controller.close();
      }
    },
  });
}

async function buildNonStreamingResponse(eventStream, model, cid, created, signal) {
  let content = "";
  const reasoning = [];
  let authError = null;

  for await (const ev of readLingxiEvents(eventStream, signal)) {
    if (ev.error) {
      if (AUTH_RESULTS.has(ev.error.result)) {
        authError = `灵犀会话已失效 (${ev.error.result})`;
        break;
      }
      const msg = ev.error.hint ? `${ev.error.hint} (${ev.error.result})` : ev.error.result;
      content += `[Error: ${msg}]`;
      continue;
    }
    if (ev.reasoning) reasoning.push(ev.reasoning);
    if (ev.delta) content += ev.delta;
    if (ev.done) break;
  }

  if (authError) return syntheticAuthResponse(authError);

  const msg = { role: "assistant", content };
  if (reasoning.length) msg.reasoning_content = reasoning.join("");

  const approxTokens = Math.ceil((content.length || 1) / 4);
  return new Response(
    JSON.stringify({
      id: cid,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message: msg, finish_reason: "stop", logprobs: null }],
      usage: { prompt_tokens: approxTokens, completion_tokens: approxTokens, total_tokens: approxTokens * 2 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

export class LingxiExecutor extends BaseExecutor {
  constructor() {
    super("lingxi", PROVIDERS["lingxi"]);
  }

  buildUrl() {
    return SESSIONS_URL;
  }

  buildHeaders(credentials, stream = true) {
    return buildLingxiHeaders(normalizeCookie(credentials?.apiKey || credentials?.accessToken), stream);
  }

  /**
   * Two-call turn: create session → POST completions. The completions SSE is
   * converted to an OpenAI-shaped Response here (same pattern as grok-web),
   * because Lingxi's stream shape doesn't round-trip through the OpenAI pivot.
   */
  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const cookie = normalizeCookie(credentials?.apiKey || credentials?.accessToken || "");
    if (!cookie) {
      return {
        response: jsonError(401, "Lingxi requires the WPS session Cookie header (wps_sid …) pasted into the connection", "needs_reauth"),
        url: SESSIONS_URL,
        headers: {},
        transformedBody: body,
      };
    }

    const messages = body?.messages;
    const question = flattenMessages(messages);
    if (!question.trim()) {
      return {
        response: jsonError(400, "Empty query after processing", "EMPTY_QUERY"),
        url: SESSIONS_URL,
        headers: {},
        transformedBody: body,
      };
    }

    const upstreamFields = resolveUpstreamFields(model, body);
    const payload = {
      question,
      ...upstreamFields,
      file_ids: [],
      upload_ids: [],
      group_id: "",
      with_mcp: false,
      with_expert: false,
      command: "",
    };

    const headers = buildLingxiHeaders(cookie, true);
    let sessionId;
    try {
      log?.debug?.("FETCH", `LINGXI → create session`);
      const sessionRes = await proxyAwareFetch(SESSIONS_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
        signal,
      }, proxyOptions);
      if (!sessionRes.ok) {
        const text = await sessionRes.text().catch(() => "");
        let hint = `HTTP ${sessionRes.status}`;
        try {
          const j = JSON.parse(text);
          hint = j.hint || j.msg || hint;
        } catch { /* keep status text */ }
        if (sessionRes.status === 401 || sessionRes.status === 403) {
          return {
            response: syntheticAuthResponse(`灵犀会话已失效，请重新捕获 WPS Cookie（${hint}）`),
            url: SESSIONS_URL,
            headers,
            transformedBody: payload,
          };
        }
        return {
          response: jsonError(502, `Lingxi session create failed: ${String(hint).slice(0, 160)}`),
          url: SESSIONS_URL,
          headers,
          transformedBody: payload,
        };
      }
      const sessionJson = await sessionRes.json();
      sessionId = sessionJson?.data?.session_id;
      if (!sessionId) {
        return {
          response: jsonError(502, "Lingxi session create returned no session_id"),
          url: SESSIONS_URL,
          headers,
          transformedBody: payload,
        };
      }
    } catch (err) {
      if (signal?.aborted || err.name === "AbortError") throw err;
      return {
        response: jsonError(502, `Lingxi session create failed: ${err.message || String(err)}`),
        url: SESSIONS_URL,
        headers,
        transformedBody: payload,
      };
    }

    const completionsUrl = `${SESSIONS_URL}/${sessionId}/completions`;
    const cid = `chatcmpl-lingxi-${crypto.randomUUID().slice(0, 12)}`;
    const created = Math.floor(Date.now() / 1000);

    let response;
    try {
      log?.debug?.("FETCH", `LINGXI → completions session=${sessionId} model=${model} thinking=${payload.thinking} len=${question.length}`);
      response = await proxyAwareFetch(completionsUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal,
      }, proxyOptions);
    } catch (err) {
      if (signal?.aborted || err.name === "AbortError") throw err;
      return {
        response: jsonError(502, `Lingxi completions failed: ${err.message || String(err)}`),
        url: completionsUrl,
        headers,
        transformedBody: payload,
      };
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let hint = `HTTP ${response.status}`;
      try {
        const j = JSON.parse(text);
        hint = j.hint || j.msg || hint;
      } catch { /* keep status text */ }
      if (response.status === 401 || response.status === 403) {
        return {
          response: syntheticAuthResponse(`灵犀会话已失效（${hint}）`),
          url: completionsUrl,
          headers,
          transformedBody: payload,
        };
      }
      return {
        response: jsonError(response.status === 429 ? 429 : 502, `Lingxi completions error: ${String(hint).slice(0, 160)}`),
        url: completionsUrl,
        headers,
        transformedBody: payload,
      };
    }

    if (!response.body) {
      return {
        response: jsonError(502, "Lingxi returned empty response body"),
        url: completionsUrl,
        headers,
        transformedBody: payload,
      };
    }

    const finalResponse = stream
      ? new Response(buildStreamingResponse(response.body, model, cid, created, signal), {
          status: 200,
          headers: { ...SSE_HEADERS_NO_BUFFER },
        })
      : await buildNonStreamingResponse(response.body, model, cid, created, signal);

    return { response: finalResponse, url: completionsUrl, headers, transformedBody: payload };
  }
}

export const __test__ = {
  flattenMessages,
  resolveUpstreamFields,
  normalizeCookie,
  parseLingxiSseFrame,
  readLingxiEvents,
  LINGXI_BASE,
  SESSIONS_URL,
  AUTH_RESULTS,
  PLAN_MODELS,
};

export default LingxiExecutor;
