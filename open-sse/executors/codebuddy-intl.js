import crypto from "crypto";
import { DefaultExecutor } from "./default.js";
import { parseCodeBuddyFrequencyLimit } from "./codebuddy-cn.js";
import { resolveSessionId } from "../utils/sessionManager.js";

/**
 * CodeBuddyIntlExecutor — talks to https://www.codebuddy.ai/v2/chat/completions
 *
 * Same OpenAI-compatible-but-stream-only gateway behavior as codebuddy-cn:
 * non-stream requests are rejected, and reasoning is surfaced only when the
 * request carries the IDE's OpenAI-style reasoning params. Force stream and
 * mirror reasoning_summary exactly like CodeBuddyExecutor.
 */

// Deterministic RFC-4122-v5-shaped UUID from a session key, mirroring the
// official client's per-conversation id (uuid5 over the session key).
function stableUuidFrom(key) {
  const hash = crypto.createHash("sha1").update(key).digest("hex");
  const timeHigh = ((parseInt(hash.slice(12, 16), 16) & 0x0fff) | 0x5000).toString(16).padStart(4, "0");
  const clockSeq = ((parseInt(hash.slice(16, 20), 16) & 0x3fff) | 0x8000).toString(16).padStart(4, "0");
  return [hash.slice(0, 8), hash.slice(8, 12), timeHigh, clockSeq, hash.slice(20, 32)].join("-");
}

// Read a header case-insensitively, "" when absent/blank. Header names are
// case-insensitive: a caller (or a previous buildHeaders pass) that wrote
// `x-conversation-id` must be FOUND — testing the exact key would miss it and
// a second write under different casing makes undici join both values into
// "caller, ours", corrupting the id that is supposed to stay stable.
function readHeader(headers, name) {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  const value = key ? headers[key] : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

// Write under the canonical name, dropping a same-name-different-case key so
// no duplicate is ever left behind.
function writeHeader(headers, name, value) {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  if (key && key !== name) delete headers[key];
  headers[name] = value;
}

export class CodeBuddyIntlExecutor extends DefaultExecutor {
  constructor() {
    super("codebuddy-intl");
  }

  buildHeaders(credentials, stream = true, url, model, transformedBody) {
    const headers = super.buildHeaders(credentials, stream, url, model, transformedBody);

    // CodeBuddy intl WAF gate (HTTP 400 code 11128 "conversation id missing"):
    // ALL THREE of X-Conversation-ID / -Request-ID / -Message-ID are required —
    // any two are still answered 11128 (live A/B, 2026-10-25). X-Request-ID is
    // not part of the gate; it mirrors the message id because the official
    // client sends it.
    //
    // Idempotent + case-safe: existing non-empty values are preserved, so a
    // second buildHeaders pass over the same bag (base.js retry) keeps the ids
    // instead of rotating them, and a caller-tracked conversation survives.
    const readH = (name) => readHeader(headers, name);
    const writeH = (name, value) => writeHeader(headers, name, value);

    // Conversation key, in priority order: explicit body session fields → our
    // session continuity (client headers / assistant text / connection-derived)
    // → the opening user message, so one conversation keeps one id even when
    // no session field exists.
    const body = transformedBody;
    const explicit =
      (typeof body?.session_id === "string" && body.session_id) ||
      (typeof body?.prompt_cache_key === "string" && body.prompt_cache_key) ||
      (typeof body?.conversation_id === "string" && body.conversation_id) ||
      "";
    let sessionKey = explicit;
    if (!sessionKey) {
      try {
        sessionKey =
          resolveSessionId({
            headers: credentials?.rawHeaders,
            body,
            connectionId: credentials?.connectionId,
            scope: "codebuddy-intl",
          }) || "";
      } catch { /* first-user-message fallback below covers it */ }
    }
    if (!sessionKey) {
      const firstUser = Array.isArray(body?.messages) ? body.messages.find((m) => m?.role === "user") : null;
      const userText = typeof firstUser?.content === "string"
        ? firstUser.content
        : Array.isArray(firstUser?.content)
          ? firstUser.content.map((b) => (b && typeof b.text === "string" ? b.text : "")).join("\n")
          : "";
      sessionKey = userText ? `cbai:${userText}` : credentials?.connectionId || "codebuddy-intl";
    }

    if (!readH("X-Conversation-ID")) {
      writeH("X-Conversation-ID", stableUuidFrom(sessionKey));
    }
    // One fresh id per build, mirrored across the request/message pair —
    // existing values (caller-tracked or a previous pass) always win.
    const requestId = readH("X-Conversation-Request-ID") || readH("X-Request-ID") || crypto.randomUUID();
    writeH("X-Conversation-Request-ID", requestId);
    const messageId = readH("X-Conversation-Message-ID") || requestId;
    writeH("X-Conversation-Message-ID", messageId);
    writeH("X-Request-ID", messageId);
    // WAF fingerprint headers we already sent before the gate existed.
    if (!readH("X-Agent-Intent")) headers["X-Agent-Intent"] = "craft";
    if (!readH("X-Agent-Type")) headers["X-Agent-Type"] = "main";

    return headers;
  }

  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(model, body, stream, credentials);
    transformed.stream = true;

    // 11155: upstream rejects the turn whenever reasoning is requested but any PRIOR
    // assistant turn with tool_calls lacks a real (non-empty) reasoning_content.
    // Read from the ORIGINAL body so the guard sees what the client actually sent —
    // super.transformRequest() runs injectReasoningContent, which for DeepSeek
    // (MODEL_RULES /deepseek/i, scope "all") fills a " " placeholder into every
    // unreasoned assistant turn. Note the predicate below already tolerates that
    // placeholder (`" ".trim()` is empty, so `!(…)` is true, keeping the guard live);
    // reading `body` just makes the intent explicit and independent of pre-processing.
    const source = Array.isArray(transformed.messages) ? transformed.messages : [];
    const origin = Array.isArray(body?.messages) ? body.messages : source;
    const hasUnreasonedToolTurn = origin.some(
      (m) => m && m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0 && !(typeof m.reasoning_content === "string" && m.reasoning_content.trim())
    );

    // A malformed reasoning_effort (true/{}/[]/0/"") is not a level, and upstream
    // answers it with 400 11150 exactly like "auto". Treat it as absent rather than
    // forwarding it (mirrors the typeof check in opencode.js).
    if (transformed.reasoning_effort !== undefined && typeof transformed.reasoning_effort !== "string") {
      delete transformed.reasoning_effort;
    }

    const eff = transformed.reasoning_effort;
    // 11150: DeepSeek-series models reject reasoning_effort "auto" (400, "reasoning
    // effort value is not supported by the current model"); they accept only
    // low/medium/high/xhigh/max/none. Translate so agent clients (e.g. dsh sending
    // THINK:auto) don't hard-fail: auto → high (keep reasoning; it's the gateway default).
    //
    // Priority when 11150 and 11155 could BOTH apply (DeepSeek + "auto" + a prior
    // unreasoned tool turn): DROP the field. Emitting "high" would clear 11150, but the
    // turn still fails 11155, so dropping is the only outcome satisfying both. The 11155
    // guard therefore deliberately WINS over the auto→high translation — hence
    // `!hasUnreasonedToolTurn` gates the DeepSeek branch below. Every other combination
    // falls through to the guard unchanged.
    const isDeepSeek = typeof model === "string" && /deepseek/i.test(model);
    if (isDeepSeek && eff === "auto" && !hasUnreasonedToolTurn) {
      transformed.reasoning_effort = "high";
      transformed.reasoning_summary = "auto";
    } else if (hasUnreasonedToolTurn || eff === "none" || eff === "off") {
      delete transformed.reasoning_effort;
      delete transformed.reasoning_summary;
    } else if (eff) {
      transformed.reasoning_summary = "auto";
    }

    // CodeBuddy rejects plain OpenAI shape (11101 invalid request): needs a
    // leading system prompt + user content as typed blocks, not a bare string.
    const sanitizeDshText = (s) => (typeof s === "string" ? s.replace(/DeepSeek([ \-_]*)Harness/gi, "DeepSeek​$1Harness") : s);
    const sanitizeMessageContent = (content) => {
      if (typeof content === "string") return sanitizeDshText(content);
      if (Array.isArray(content)) {
        return content.map((part) => {
          if (part && typeof part.text === "string") {
            return { ...part, text: sanitizeDshText(part.text) };
          }
          return part;
        });
      }
      return content;
    };

    transformed.messages = [{ role: "system", content: "You are CodeBuddy Code." }];
    for (const message of source) {
      if (!message || typeof message !== "object" || ["system", "developer"].includes(message.role)) continue;
      if (message.role === "user" && typeof message.content === "string") {
        transformed.messages.push({ ...message, content: [{ type: "text", text: sanitizeDshText(message.content) }] });
      } else {
        transformed.messages.push({ ...message, content: sanitizeMessageContent(message.content) });
      }
    }

    // Forward the conversation-identity fields the gateway tracks (the same
    // sources the X-Conversation-ID header derives from) instead of consuming
    // them header-side only — dropping them breaks upstream conversation
    // association even when the headers are right.
    for (const key of ["session_id", "prompt_cache_key", "conversation_id"]) {
      if (typeof body?.[key] === "string" && body[key]) transformed[key] = body[key];
    }

    return transformed;
  }

  // 与 codebuddy-cn 同一套 6004 频率限制解析（两站错误体同构）：提取精确重置
  // 时间 resetsAtMs 走精确冷却通道；其他错误回退默认解析。
  parseError(response, bodyText) {
    const frequencyLimit = parseCodeBuddyFrequencyLimit(bodyText);
    if (frequencyLimit) return frequencyLimit;
    return super.parseError(response, bodyText);
  }
}

export default CodeBuddyIntlExecutor;
