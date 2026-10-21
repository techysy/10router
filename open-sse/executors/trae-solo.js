import { BaseExecutor } from "./base.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { PROVIDERS } from "../config/providers.js";

// Trae SOLO executor — POST /api/agent/v3/llm_utils_chat.
//
// Contract notes (from the Rust reference `providers/trae/{payload,stream,errors}.rs`
// and the MIT Trae2api-cn stream mapping):
//   * the upstream body is REBUILT from a whitelist — extra keys are rejected,
//     not ignored (agent_type / thinking / stream_options all break the turn);
//   * `tools[].function.parameters` must be a JSON *string*;
//   * `tool_choice` must be a bare string;
//   * assistant `tool_calls[].function` must be renamed `function_call`;
//   * `developer` is not accepted and silently produces an empty stream;
//   * the upstream never sends `[DONE]` — it ends on `event: done`;
//   * business errors arrive inside a HTTP 200 SSE as `event: error`.
//
// Node/HTTP only. Tokens are never logged.

const STREAM_TIMEOUT_MS = parseInt(process.env.TRAE_SOLO_STREAM_TIMEOUT_MS || "300000", 10);
export const TRAE_SOLO_AGENT_BASE_URL = (process.env.TRAE_SOLO_AGENT_BASE_URL || "https://trae-api-cn.mchost.guru").replace(/\/$/, "");
const AGENT_BASE_URL = TRAE_SOLO_AGENT_BASE_URL;
const CHAT_PATH = "/api/agent/v3/llm_utils_chat";

const SOLO_FUNCTION = "solo_work_lite";
const DEFAULT_CONFIG_NAME = "glm-5.2";
// The upstream truncates output at 128k; send a large default unless the client
// asked for something explicit (Rust DEFAULT_MAX_TOKENS).
const DEFAULT_MAX_TOKENS = 1_000_000;
const PROMPT_MAX_TOKENS = 168000;

const IDE_VERSION = "0.1.61";
// Tied to the model catalog served by the agent gateway: changing this without
// changing the advertised models produces stream-internal 4001 for every model.
const IDE_VERSION_CODE = "20260820";
const APP_ID = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8";
const DEVICE_BRAND = "83DG";
const OS_VERSION = "Windows 11 Pro";
const CLIENT_USER_AGENT = "Trae/0.1.61";

const SAMPLING_KEYS = [
  "temperature",
  "top_p",
  "max_tokens",
  "presence_penalty",
  "frequency_penalty",
  "seed",
  "n",
];

const INPUT_TOO_LARGE_MARKERS = [
  "too long",
  "too many tokens",
  "context length",
  "maximum context",
  "context window",
  "request entity too large",
  "input too large",
  "输入过长",
  "内容过长",
  "上下文过长",
  "上下文长度",
  "超出模型上限",
];

const LENGTH_FINISH_REASONS = new Set([
  "length",
  "max_tokens",
  "max_output_tokens",
  "max_token",
  "token_limit",
  // Trae reports an over-budget prompt/context as its own reason. Folding this
  // into `stop` would tell the client a truncated answer is complete.
  "model_context_window_exceeded",
  "context_window_exceeded",
  "context_length_exceeded",
]);
const TOOL_FINISH_REASONS = new Set(["tool_calls", "tool-calls", "function_call", "tool_use", "tool"]);
const FILTER_FINISH_REASONS = new Set(["content_filter", "content-filter", "safety"]);
const STOP_FINISH_REASONS = new Set(["stop", "end_turn", "eos", "done", "finished", "complete"]);

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// ── Payload rebuild ─────────────────────────────────────────────────────────

function normalizeMessageContent(message) {
  // upstream only accepts the block-array shape for text; pass multimodal
  // arrays through untouched (the Rust reference does the same).
  if (typeof message.content === "string") {
    message.content = [{ type: "text", text: message.content }];
  }
}

function normalizeMessages(rawMessages) {
  if (!Array.isArray(rawMessages)) return rawMessages;
  const kept = [];
  for (const item of rawMessages) {
    if (!isPlainObject(item)) continue;
    const message = { ...item };
    if (message.role === "developer") message.role = "system";
    normalizeMessageContent(message);

    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      const calls = [];
      for (const call of message.tool_calls) {
        if (!isPlainObject(call)) continue;
        const next = { ...call };
        if (isPlainObject(next.function)) {
          next.function_call = next.function;
          delete next.function;
        }
        // function_call.name is mandatory upstream; a nameless call is dropped.
        const name = next.function_call?.name;
        if (typeof name === "string" && name.trim()) calls.push(next);
      }
      if (calls.length) {
        message.tool_calls = calls;
      } else {
        delete message.tool_calls;
        // An assistant with no content and no usable call is an empty
        // placeholder — the upstream may answer those with an empty stream.
        if (!("content" in message) || message.content == null) {
          kept.push(null);
          continue;
        }
      }
    }
    kept.push(message);
  }

  // Drop tool results whose call id no longer exists (clients trim history).
  const knownCallIds = new Set();
  for (const message of kept) {
    if (!message || message.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      if (typeof call.id === "string" && call.id) knownCallIds.add(call.id);
    }
  }
  return kept.filter((message) => {
    if (!message) return false;
    if (message.role !== "tool") return true;
    return knownCallIds.has(String(message.tool_call_id || ""));
  });
}

function normalizeTools(rawTools) {
  if (!Array.isArray(rawTools)) return undefined;
  const kept = [];
  for (const tool of rawTools) {
    if (!isPlainObject(tool) || !isPlainObject(tool.function)) continue;
    const fn = { ...tool.function };
    if (isPlainObject(fn.parameters)) {
      // The upstream Go struct declares this as string: sending an object fails
      // deserialization for the WHOLE request, not just this tool.
      fn.parameters = JSON.stringify(fn.parameters);
    }
    kept.push({ ...tool, function: fn });
  }
  return kept.length ? kept : undefined;
}

function normalizeToolChoice(rawChoice) {
  if (rawChoice === undefined) return { choice: undefined, suppressTools: false };
  if (typeof rawChoice === "string") {
    if (rawChoice.trim().toLowerCase() === "none") return { choice: undefined, suppressTools: true };
    return { choice: rawChoice, suppressTools: false };
  }
  if (isPlainObject(rawChoice)) {
    const type = String(rawChoice.type || "").trim().toLowerCase();
    if (type === "none") return { choice: undefined, suppressTools: true };
    if (type === "auto" || type === "required") return { choice: type, suppressTools: false };
    if (type === "function") {
      const name = String(rawChoice.function?.name || rawChoice.name || "").trim();
      return { choice: name || "auto", suppressTools: false };
    }
    return { choice: undefined, suppressTools: false };
  }
  return { choice: undefined, suppressTools: false };
}

// Strip exactly one namespacing suffix. NEVER split on "/": config names such
// as `deepseek-ai/deepseek-v4-pro` are legal bare names upstream.
export function sanitizeTraeSoloModelName(model) {
  let name = String(model || "").trim();
  if (name.endsWith("-solo")) name = name.slice(0, -"-solo".length);
  if (name.endsWith("-intl")) name = name.slice(0, -"-intl".length);
  return name.trim();
}

/**
 * Rebuild an OpenAI-style request into the `llm_utils_chat` whitelist shape.
 * Pure function — exported for the unit tests.
 */
export function buildTraeSoloPayload(body, resolvedModel = "") {
  if (!isPlainObject(body)) return body;

  const messages = normalizeMessages(body.messages);
  const { choice, suppressTools } = normalizeToolChoice(body.tool_choice);
  const tools = suppressTools ? undefined : normalizeTools(body.tools);

  let model = sanitizeTraeSoloModelName(resolvedModel || body.model || "");
  if (!model) model = DEFAULT_CONFIG_NAME;

  const out = {};
  if (messages !== undefined) out.messages = messages;
  out.function = SOLO_FUNCTION;
  out.stream = true;
  out.config_name = model;
  out.model = model;
  if (tools) out.tools = tools;
  if (choice !== undefined) out.tool_choice = choice;

  for (const key of SAMPLING_KEYS) {
    // Types are not tolerated upstream: `"temperature":"0.3"` breaks the turn.
    if (typeof body[key] === "number" && Number.isFinite(body[key])) out[key] = body[key];
  }
  if (out.max_tokens === undefined) out.max_tokens = DEFAULT_MAX_TOKENS;
  if (typeof body.reasoning_effort === "string") {
    const effort = body.reasoning_effort.trim().toLowerCase();
    if (effort && effort !== "auto" && effort !== "none" && effort !== "off") {
      out.reasoning_effort = body.reasoning_effort;
    }
  }
  if (typeof body.stop === "string" || Array.isArray(body.stop)) out.stop = body.stop;
  out.prompt_max_tokens = PROMPT_MAX_TOKENS;
  return out;
}

// ── Finish reason / usage ───────────────────────────────────────────────────

export function mapTraeSoloFinishReason(reason, sawToolCalls = false) {
  const value = String(reason || "").trim().toLowerCase();
  if (LENGTH_FINISH_REASONS.has(value)) return "length";
  if (FILTER_FINISH_REASONS.has(value)) return "content_filter";
  if (TOOL_FINISH_REASONS.has(value)) return "tool_calls";
  if (!value || STOP_FINISH_REASONS.has(value)) return sawToolCalls ? "tool_calls" : "stop";
  return "stop";
}

function normalizeUsage(rawUsage) {
  if (!isPlainObject(rawUsage)) return null;
  const prompt = Number(rawUsage.prompt_tokens ?? rawUsage.input_tokens ?? 0) || 0;
  const completion = Number(rawUsage.completion_tokens ?? rawUsage.output_tokens ?? 0) || 0;
  const total = Number(rawUsage.total_tokens ?? prompt + completion) || 0;
  const usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
  if (isPlainObject(rawUsage.prompt_tokens_details)) usage.prompt_tokens_details = rawUsage.prompt_tokens_details;
  if (isPlainObject(rawUsage.completion_tokens_details)) usage.completion_tokens_details = rawUsage.completion_tokens_details;
  return usage;
}

// ── Error dictionary ────────────────────────────────────────────────────────

function messageIsInputTooLarge(message) {
  const lower = String(message || "").toLowerCase();
  return INPUT_TOO_LARGE_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * Classify an in-stream business error. Order matters: plan-limit codes win,
 * then input-size (a 4001 paired with "prompt is too long" is a request
 * problem, not a channel problem), then the channel codes.
 *
 * 9074 is DEVICE-level rate limiting. It must only cool this connection down
 * for a short window (`errorConfig.js` `{ provider: "trae-solo", text: "9074" }`);
 * treating it as a channel error would cool the whole pool.
 */
export function classifyTraeSoloError(code, message) {
  const numeric = Number(code) || 0;
  if (numeric === 1005 || numeric === 4008) return { code: numeric, kind: "plan_limit", status: 429 };
  if (messageIsInputTooLarge(message)) return { code: numeric, kind: "input_too_large", status: 413 };
  switch (numeric) {
    case 2001:
      // "failed to get app config: record not found" — not published yet.
      return { code: numeric, kind: "config_pending", status: 503 };
    case 4001:
      // Model unavailable on this `function` channel — request level.
      return { code: numeric, kind: "model_unavailable", status: 404 };
    case 4011:
      return { code: numeric, kind: "rate_limit", status: 429 };
    case 4023:
      // Model unknown for this gateway / catalog version — request level.
      return { code: numeric, kind: "model_unavailable", status: 404 };
    case 4222:
      return { code: numeric, kind: "enterprise_pool", status: 403 };
    case 9074:
      return { code: numeric, kind: "device_rate_limit", status: 429 };
    case 20101:
      return { code: numeric, kind: "session_dead", status: 401 };
    default:
      return { code: numeric, kind: "client", status: 400 };
  }
}

function classifyHttpError(status, bodyText) {
  if (status === 413) return { code: 413, kind: "input_too_large", status: 413 };
  const codeMatch = String(bodyText || "").match(/"code"\s*:\s*(-?\d+)/);
  if (codeMatch) {
    const business = classifyTraeSoloError(Number(codeMatch[1]), bodyText);
    if (business.kind !== "client") return business;
  }
  if (status === 401) return { code: 401, kind: "session_dead", status: 401 };
  if (status === 429) return { code: 429, kind: "rate_limit", status: 429 };
  if (status === 404) return { code: 404, kind: "model_unavailable", status: 404 };
  if (status >= 500) return { code: status, kind: "server", status: 502 };
  return { code: status, kind: "client", status: status >= 400 ? status : 502 };
}

function errorBody(message, kind, code) {
  return JSON.stringify({
    error: {
      message,
      type: kind || "api_error",
      code: code === undefined || code === null ? "" : code,
    },
  });
}

function errorResponse(status, message, kind, code) {
  return new Response(errorBody(message, kind, code), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function soloErrorText(code, message) {
  return `solo error code=${code || 0} msg=${message || ""}`;
}

// ── SSE parsing / frame translation ─────────────────────────────────────────

function createSseScanner() {
  let event = "";
  let data = "";
  return {
    feedLine(line) {
      const text = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (!text) {
        if (!event) {
          event = "";
          data = "";
          return null;
        }
        const boundary = { event, data };
        event = "";
        data = "";
        return boundary;
      }
      if (text.startsWith("event:")) event = text.slice(6).trim();
      // Deliberately no trim: multi-line data is concatenated verbatim so the
      // upstream's `{"response":` + ` "y"}` split still parses.
      else if (text.startsWith("data:")) data += text.slice(5);
      return null;
    },
  };
}

async function* iterateSseEvents(reader) {
  const decoder = new TextDecoder();
  const scanner = createSseScanner();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const boundary = scanner.feedLine(line);
      if (boundary) yield boundary;
    }
  }
  if (buffer) {
    const boundary = scanner.feedLine(buffer);
    if (boundary) yield boundary;
  }
  // EOF pushes the last unterminated event out, matching the line-based
  // reference reader.
  const tail = scanner.feedLine("");
  if (tail) yield tail;
}

function normalizeStreamToolCalls(rawCalls) {
  const list = Array.isArray(rawCalls) ? rawCalls : [rawCalls];
  return list.filter(Boolean).map((call, index) => {
    if (!isPlainObject(call)) return { index, type: "function", function: { name: "", arguments: "" } };
    const out = { ...call };
    if (isPlainObject(out.function_call)) {
      out.function = out.function_call;
      delete out.function_call;
    }
    if (!Number.isInteger(out.index)) out.index = index;
    if (isPlainObject(out.function)) {
      const fn = { ...out.function };
      // SOLO-only fields that OpenAI clients do not understand.
      delete fn.namespace;
      delete fn.partial_arguments;
      out.function = fn;
    }
    return out;
  });
}

class SoloStreamProcessor {
  constructor({ id, created, model }) {
    this.id = id;
    this.created = created;
    this.model = model;
    this.scanner = createSseScanner();
    this.pendingUsage = null;
    this.sawDone = false;
    this.sawContent = false;
    this.sawToolCalls = false;
    this.finishReason = "stop";
    this.content = "";
    this.reasoning = "";
    this.toolCalls = [];
  }

  feedLine(line) {
    const boundary = this.scanner.feedLine(line);
    if (!boundary) return { frames: [] };
    return this.apply(boundary);
  }

  apply({ event, data }) {
    if (!event) return { frames: [] };
    let parsed = null;
    if (data && data.trim()) {
      try {
        parsed = JSON.parse(data);
      } catch {
        // Invalid JSON is an ignored frame upstream, not a hard failure.
        parsed = null;
      }
    }

    if (event === "output") {
      if (!isPlainObject(parsed)) return { frames: [] };
      const delta = {};
      if (typeof parsed.response === "string" && parsed.response) {
        delta.content = parsed.response;
        this.content += parsed.response;
      }
      if (typeof parsed.reasoning_content === "string" && parsed.reasoning_content) {
        delta.reasoning_content = parsed.reasoning_content;
        this.reasoning += parsed.reasoning_content;
      }
      if (parsed.tool_calls != null) {
        const calls = normalizeStreamToolCalls(parsed.tool_calls);
        if (calls.length) {
          delta.tool_calls = calls;
          this.sawToolCalls = true;
          this.mergeToolCalls(calls);
        }
      }
      if (!Object.keys(delta).length) return { frames: [] };
      this.sawContent = true;
      return { frames: [{ type: "chunk", value: this.chunk(delta) }] };
    }

    if (event === "token_usage") {
      this.pendingUsage = normalizeUsage(parsed);
      return { frames: [] };
    }

    if (event === "done") {
      this.sawDone = true;
      const reason = mapTraeSoloFinishReason(parsed?.finish_reason, this.sawToolCalls);
      this.finishReason = reason;
      return { frames: [{ type: "chunk", value: this.finishChunk(reason) }, { type: "done" }] };
    }

    if (event === "error") {
      this.sawDone = true;
      const code = Number(parsed?.code) || 0;
      const message = typeof parsed?.message === "string" ? parsed.message : "";
      return { frames: [], error: { ...classifyTraeSoloError(code, message), message } };
    }

    return { frames: [] };
  }

  // The upstream may close without `done`. Always synthesize a finish frame and
  // a `[DONE]` so clients do not wait forever on the last chunk.
  finish() {
    if (this.sawDone) return [];
    this.sawDone = true;
    const reason = mapTraeSoloFinishReason("", this.sawToolCalls);
    this.finishReason = reason;
    return [{ type: "chunk", value: this.finishChunk(reason) }, { type: "done" }];
  }

  chunk(delta) {
    return {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: null }],
    };
  }

  finishChunk(reason) {
    const chunk = {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta: {}, finish_reason: reason }],
    };
    if (this.pendingUsage) {
      chunk.usage = this.pendingUsage;
      this.finalUsage = this.pendingUsage;
      this.pendingUsage = null;
    }
    return chunk;
  }

  mergeToolCalls(calls) {
    for (const call of calls) {
      const index = Number.isInteger(call.index) ? call.index : this.toolCalls.length;
      let slot = this.toolCalls[index];
      if (!slot) {
        slot = { id: "", type: "function", function: { name: "", arguments: "" } };
        this.toolCalls[index] = slot;
      }
      if (call.id) slot.id = call.id;
      if (call.type) slot.type = call.type;
      const fn = call.function || {};
      if (fn.name) slot.function.name = fn.name;
      if (fn.arguments) slot.function.arguments += fn.arguments;
    }
  }
}

function frameToSse(frame) {
  if (frame.type === "done") return "data: [DONE]\n\n";
  if (frame.type === "error") {
    return `data: ${JSON.stringify({
      id: "",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "",
      choices: [],
      error: {
        message: soloErrorText(frame.code, frame.message),
        type: frame.kind || "api_error",
        code: frame.code || 0,
      },
    })}\n\n`;
  }
  return `data: ${JSON.stringify(frame.value)}\n\n`;
}

/**
 * Identity / fingerprint headers for the SOLO agent gateway.
 *
 * Exported because the model catalogue (`/api/ide/v1/get_detail_param`) lives
 * on the same gateway and is gated by the SAME version + identity headers: a
 * catalogue request built from a second copy would drift the moment either
 * side changes, and the failure mode is an empty catalogue that looks like
 * "this account has no models".
 */
export function buildTraeSoloHeaders(credentials, { accept = "text/event-stream" } = {}) {
  const token = credentials?.accessToken || credentials?.apiKey || "";
  const psd = credentials?.providerSpecificData || {};
  const headers = {
    Accept: accept,
    "Content-Type": "application/json",
    "User-Agent": CLIENT_USER_AGENT,
    // The same token is carried in three headers; missing one is treated as
    // anonymous by upstream while still answering HTTP 200.
    Authorization: `Cloud-IDE-JWT ${token}`,
    "X-Cloudide-Token": token,
    "X-Ide-Token": token,
    "X-App-Id": APP_ID,
    "X-App-Version": psd.appVersion || "default",
    "X-Ide-Version": IDE_VERSION,
    "X-Ide-Version-Code": IDE_VERSION_CODE,
    "X-App-Version-Code": IDE_VERSION_CODE,
    "X-Ide-Version-Type": "stable",
    "X-Device-Type": "windows",
    "X-OS-Version": OS_VERSION,
    "X-Device-Brand": DEVICE_BRAND,
    "Request-Traffic-Type": "prod",
  };
  // Empty identity headers must be omitted, not sent blank.
  if (psd.userId) headers["X-Uid"] = String(psd.userId);
  if (psd.machineId) headers["X-Machine-Id"] = String(psd.machineId);
  if (psd.deviceId) headers["X-Device-Id"] = String(psd.deviceId);
  return headers;
}

export default class TraeSoloExecutor extends BaseExecutor {
  constructor() {
    super("trae-solo", PROVIDERS["trae-solo"]);
  }

  getAgentUrl() {
    return `${AGENT_BASE_URL}${CHAT_PATH}`;
  }

  buildHeaders(credentials) {
    return buildTraeSoloHeaders(credentials);
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const url = this.getAgentUrl();
    const headers = this.buildHeaders(credentials);
    const transformedBody = buildTraeSoloPayload(body, model);
    const responseId = `chatcmpl-trae-solo-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    const controller = new AbortController();
    let timer = null;
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else if (signal) signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => controller.abort(new Error("trae-solo stream timeout")), STREAM_TIMEOUT_MS);

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    };

    let upstream;
    try {
      upstream = await proxyAwareFetch(
        url,
        {
          method: "POST",
          headers,
          body: JSON.stringify(transformedBody),
          signal: controller.signal,
        },
        proxyOptions
      );
    } catch (err) {
      cleanup();
      const message = err?.message ? String(err.message) : String(err);
      log?.warn?.("TRAE_SOLO", `upstream request failed: ${message}`);
      return {
        response: errorResponse(502, `trae-solo upstream request failed: ${message}`, "api_error", ""),
        url,
        headers,
        transformedBody,
      };
    }

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      cleanup();
      const cls = classifyHttpError(upstream.status, text);
      return {
        response: errorResponse(
          cls.status,
          `trae-solo HTTP ${upstream.status}: ${String(text || "").slice(0, 500)}`,
          cls.kind,
          cls.code
        ),
        url,
        headers,
        transformedBody,
      };
    }

    if (!upstream.body) {
      cleanup();
      return {
        response: errorResponse(502, "trae-solo upstream returned an empty body", "api_error", ""),
        url,
        headers,
        transformedBody,
      };
    }

    const reader = upstream.body.getReader();
    const events = iterateSseEvents(reader);
    const processor = new SoloStreamProcessor({ id: responseId, created, model: model || transformedBody.config_name });
    const gated = [];
    let gateError = null;

    // First-packet gate: a business error inside a 200 stream must become a real
    // HTTP error, otherwise the gateway records a successful (but empty) turn.
    try {
      for (;;) {
        const { value: event, done } = await events.next();
        if (done) break;
        const result = processor.apply(event);
        gated.push(...result.frames);
        if (result.error) {
          gateError = result.error;
          break;
        }
        if (processor.sawContent || processor.sawDone) break;
      }
    } catch (err) {
      cleanup();
      const message = err?.message ? String(err.message) : String(err);
      return {
        response: errorResponse(502, `trae-solo stream failed: ${message}`, "api_error", ""),
        url,
        headers,
        transformedBody,
      };
    }

    if (gateError) {
      await reader.cancel().catch(() => {});
      cleanup();
      const status = gateError.status || 502;
      const text = soloErrorText(gateError.code, gateError.message);
      log?.warn?.("TRAE_SOLO", `${text} (${gateError.kind}, HTTP ${status})`);
      return {
        response: errorResponse(status, text, gateError.kind, gateError.code),
        url,
        headers,
        transformedBody,
      };
    }

    if (stream !== false) {
      const encoder = new TextEncoder();
      const responseBody = new ReadableStream({
        start: async (streamController) => {
          const enqueue = (frame) => {
            try {
              streamController.enqueue(encoder.encode(frameToSse(frame)));
            } catch { /* consumer went away */ }
          };
          for (const frame of gated) enqueue(frame);
          try {
            for (;;) {
              const { value: event, done } = await events.next();
              if (done) break;
              const result = processor.apply(event);
              for (const frame of result.frames) enqueue(frame);
              if (result.error) {
                enqueue({ type: "error", ...result.error });
                enqueue({ type: "done" });
                await reader.cancel().catch(() => {});
                return;
              }
              if (result.frames.some((frame) => frame.type === "done")) {
                await reader.cancel().catch(() => {});
                return;
              }
            }
            for (const frame of processor.finish()) enqueue(frame);
          } catch (err) {
            if (!controller.signal.aborted) {
              const message = err?.message ? String(err.message) : String(err);
              enqueue({ type: "error", code: 0, message, kind: "stream_error" });
              enqueue({ type: "done" });
            }
          } finally {
            cleanup();
            try {
              streamController.close();
            } catch { /* already closed */ }
          }
        },
      });
      return {
        response: new Response(responseBody, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        }),
        url,
        headers,
        transformedBody,
      };
    }

    // Non-streaming: the upstream has no non-stream endpoint, so aggregate the
    // same SSE into one chat.completion payload.
    try {
      for (;;) {
        const { value: event, done } = await events.next();
        if (done) break;
        const result = processor.apply(event);
        if (result.error) {
          await reader.cancel().catch(() => {});
          cleanup();
          return {
            response: errorResponse(
              result.error.status || 502,
              soloErrorText(result.error.code, result.error.message),
              result.error.kind,
              result.error.code
            ),
            url,
            headers,
            transformedBody,
          };
        }
      }
      processor.finish();
    } catch (err) {
      cleanup();
      const message = err?.message ? String(err.message) : String(err);
      return {
        response: errorResponse(502, `trae-solo stream failed: ${message}`, "api_error", ""),
        url,
        headers,
        transformedBody,
      };
    } finally {
      cleanup();
    }

    const message = { role: "assistant", content: processor.content };
    if (processor.reasoning) message.reasoning_content = processor.reasoning;
    const toolCalls = processor.toolCalls.filter((call) => call && call.function?.name);
    if (toolCalls.length) message.tool_calls = toolCalls;

    const out = {
      id: responseId,
      object: "chat.completion",
      created,
      model: model || transformedBody.config_name,
      choices: [{ index: 0, message, finish_reason: processor.finishReason }],
    };
    if (processor.finalUsage) out.usage = processor.finalUsage;

    return {
      response: new Response(JSON.stringify(out), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      url,
      headers,
      transformedBody,
    };
  }
}
