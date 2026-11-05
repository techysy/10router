// Combo "retry on empty content-filtered stream" (issue #10).
//
// Some providers (Z.ai / GLM family, and others) signal a content-safety kill
// with a *successful* HTTP 200: the stream opens normally, then terminates with
// a filtered finish reason and ZERO output tokens. Because the status is 2xx,
// the combo loop's `result.ok` short-circuits and returns the empty answer —
// the client sees a blank response and its own retry hits the same filter.
//
// This module provides the decision + a head-of-line gate that lets the combo
// *see inside* a 2xx stream before committing bytes to the client:
//   - buffer the stream head,
//   - release on the FIRST non-empty content/reasoning/tool-call delta (commit),
//   - or, if the stream ends with no valuable content at all, report "retry" so
//     the combo can fall through to the next model.
//
// The finish reason is normalized away by the response translator
// (`toOpenAIFinish`/`fromOpenAIFinish` map `content_filter`/`sensitive` to a
// plain stop/end_turn in the client format), so the reliable, format-agnostic
// signal is *emptiness at terminal* — which is exactly the client-visible
// failure and a superset of the reporter's sensitive case. Raw filtered tokens
// are also recognised opportunistically when they survive (OpenAI passthrough).
//
// Default OFF: callers must opt in per combo (`comboStrategies[name].retryOnEmpty`)
// or globally (`settings.comboRetryOnEmpty`). When enabled and the gate fires,
// the abandoned upstream still billed its input tokens (a stream is consumed to
// its terminal to log usage), so a replay doubles input cost for that request —
// which is why it is opt-in and only engages when a fallback model remains.

// Upstream finish/stop reasons that indicate a content-safety / policy kill.
// Compared case-insensitively after trimming.
const FILTER_FINISH_TOKENS = new Set([
  "content_filter",
  "content-filter",
  "sensitive",
  "refusal",
  "safety",
  "security",
  "blocked",
  "filtered",
  "flagged",
  "blocklist",
  "prohibited_content",
  "recitation",
]);

export function isFilterFinishReason(reason) {
  if (typeof reason !== "string") return false;
  return FILTER_FINISH_TOKENS.has(reason.trim().toLowerCase());
}

// Inspect one already-parsed SSE data object (client format) and classify its
// contribution. Returns { valuable, terminal, filtered }:
//   - valuable: this chunk carries real content the client would see
//   - terminal: this chunk finishes the message (stop/length/filter/…)
//   - filtered: the terminal reason is a content-safety kill
function classifyParsedChunk(parsed) {
  if (!parsed || typeof parsed !== "object") return { valuable: false, terminal: false, filtered: false };

  // OpenAI chat completions chunk
  const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
  if (choice) {
    const delta = choice.delta || {};
    const content = typeof delta.content === "string" && delta.content !== "";
    // `reasoning_content` (DeepSeek/most) and `reasoning` (OpenRouter/xAI) are two
    // spellings of the same thing; missing the second made a reasoning-only head
    // look empty and stall the whole thinking phase in the buffer.
    const reasoning =
      (typeof delta.reasoning_content === "string" && delta.reasoning_content !== "") ||
      (typeof delta.reasoning === "string" && delta.reasoning !== "");
    const toolCalls =
      Array.isArray(delta.tool_calls) &&
      delta.tool_calls.some((t) => (t?.function?.arguments && t.function.arguments !== "") || t?.function?.name || t?.id);
    // delta.audio（acemusic 整曲单帧）：音乐到达即是有价值内容——否则 retryOnEmpty
    // 的门禁会一直缓冲到 finish、把一首成功的歌误判成空回答顺延掉。
    const audio = Array.isArray(delta.audio) && delta.audio.length > 0;
    const valuable = content || reasoning || toolCalls || audio;
    if (choice.finish_reason) {
      return { valuable, terminal: true, filtered: isFilterFinishReason(choice.finish_reason) };
    }
    return { valuable, terminal: false, filtered: false };
  }

  // OpenAI Responses API chunk
  if (parsed.type === "response.completed" || parsed.type === "response.incomplete") {
    const outputs = Array.isArray(parsed.response?.output) ? parsed.response.output : [];
    const hasText =
      (Array.isArray(parsed.response?.output_text) && parsed.response.output_text.join("") !== "") ||
      outputs.some((o) =>
        Array.isArray(o?.content) ? o.content.some((c) => c?.text) : typeof o?.text === "string" && o.text !== ""
      );
    // A response whose only output is a tool call is NOT empty — retrying it
    // (and re-billing the whole input) is the bug this closes.
    const hasCall = outputs.some((o) => o?.type === "function_call" || o?.type === "custom_tool_call");
    return { valuable: hasText || hasCall, terminal: true, filtered: false };
  }
  if (
    parsed.type === "response.output_text.delta" ||
    parsed.type === "response.reasoning_summary_text.delta" ||
    parsed.type === "response.reason_summary_text.delta" || // tolerate the earlier misspelling
    parsed.type === "response.function_call_arguments.delta"
  ) {
    return { valuable: typeof parsed.delta === "string" && parsed.delta !== "", terminal: false, filtered: false };
  }
  if (parsed.type === "response.output_item.added") {
    const t = parsed.item?.type;
    return {
      valuable: t === "function_call" || t === "custom_tool_call" || t === "reasoning",
      terminal: false,
      filtered: false,
    };
  }

  // Claude Messages stream chunk
  if (parsed.type === "content_block_delta") {
    const d = parsed.delta || {};
    const valuable = (typeof d.text === "string" && d.text !== "") || (typeof d.thinking === "string" && d.thinking !== "") ||
      (typeof d.partial_json === "string" && d.partial_json !== "");
    return { valuable, terminal: false, filtered: false };
  }
  if (parsed.type === "message_delta") {
    const stop = parsed.delta?.stop_reason;
    return { valuable: false, terminal: true, filtered: isFilterFinishReason(stop) };
  }

  // Gemini / Antigravity chunk
  const cand = Array.isArray(parsed.candidates) ? parsed.candidates[0] : undefined;
  if (cand) {
    const parts = cand.content?.parts;
    // Text, a function call, or inline binary (image/audio) all count — a
    // functionCall-only turn is a real answer, not an empty filtered one.
    const valuable =
      Array.isArray(parts) &&
      parts.some(
        (p) => (typeof p?.text === "string" && p.text !== "") || p?.functionCall || p?.inlineData || p?.executableCode
      );
    if (cand.finishReason) {
      return { valuable, terminal: true, filtered: isFilterFinishReason(cand.finishReason) };
    }
    return { valuable, terminal: false, filtered: false };
  }

  return { valuable: false, terminal: false, filtered: false };
}

// Incrementally scan a stream of SSE text chunks and decide commit/retry.
// Feed raw string chunks via push(); returns the running decision.
export function createStreamScanner() {
  let buf = "";
  let sawValuable = false;
  let sawTerminal = false;
  let sawFiltered = false;
  let committed = false; // released early on first content
  const enc = new TextEncoder();
  // One decoder for the whole stream: a fresh TextDecoder per push() would
  // mis-decode multi-byte UTF-8 (CJK!) split across chunk boundaries, corrupt
  // the line, and make the scanner blind to real content.
  const dec = new TextDecoder();
  const head = []; // buffered Uint8Array chunks (raw, pre-decode) until a decision

  function processLine(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload) return;
    if (payload === "[DONE]") {
      sawTerminal = true;
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return; // partial/non-json line — ignore, passthrough keeps bytes intact
    }
    const c = classifyParsedChunk(parsed);
    if (c.valuable) sawValuable = true;
    if (c.terminal) {
      sawTerminal = true;
      if (c.filtered) sawFiltered = true;
    }
  }

  return {
    // Push a raw byte chunk. Returns:
    //   { kind: "buffered" }  — need more (nothing to commit yet)
    //   { kind: "commit" }    — first content seen; release all buffered + continue passthrough
    //   { kind: "retry" }     — terminal with no content (empty) → fall through to next model
    //   { kind: "commit-empty"} — terminal, not filtered, still empty; commit (return empty) unless caller wants retry
    push(chunkBytes) {
      if (committed) return { kind: "passthrough" };
      const bytes = typeof chunkBytes === "string" ? enc.encode(chunkBytes) : chunkBytes;
      head.push(bytes);
      buf += dec.decode(bytes, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) processLine(line);

      if (sawValuable) {
        committed = true;
        return { kind: "commit" };
      }
      if (sawTerminal) {
        // End with zero valuable content. Treat empty output as retryable.
        committed = true;
        return { kind: "retry" };
      }
      return { kind: "buffered" };
    },
    // Called when the upstream reader is done without an explicit terminal.
    finish() {
      // flush the decoder tail + any trailing buffered line
      buf += dec.decode();
      if (buf) {
        processLine(buf);
        buf = "";
      }
      if (committed) return { kind: "passthrough" };
      committed = true;
      // Never saw content, never saw a terminal — the model produced nothing
      // usable (abrupt close or silent filter). Retryable.
      return sawValuable ? { kind: "commit" } : { kind: "retry" };
    },
    get bufferedBytes() {
      return head;
    },
  };
}

// Inspect a NON-streaming 2xx completion for "empty content-filtered answer".
// Returns { retryable, empty, filtered } from the response JSON across formats.
export function inspectNonStream(json) {
  if (!json || typeof json !== "object") return { retryable: false, empty: false, filtered: false };

  const choice = Array.isArray(json.choices) ? json.choices[0] : undefined;
  if (choice) {
    const msg = choice.message || {};
    // content may be a string or a multimodal parts array (Anthropic-in-OpenAI).
    const content =
      typeof msg.content === "string"
        ? msg.content !== ""
        : Array.isArray(msg.content) &&
          msg.content.some((p) => (typeof p === "string" ? p !== "" : typeof p?.text === "string" && p.text !== ""));
    const reasoning =
      (typeof msg.reasoning_content === "string" && msg.reasoning_content !== "") ||
      (typeof msg.reasoning === "string" && msg.reasoning !== "");
    const toolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
    const audio = Array.isArray(msg.audio) && msg.audio.length > 0;
    const empty = !content && !reasoning && !toolCalls && !audio;
    const filtered = isFilterFinishReason(choice.finish_reason);
    return { retryable: empty, empty, filtered };
  }
  if (Array.isArray(json.content)) {
    // Claude non-stream
    const text = json.content.some((b) => (b?.type === "text" && b.text) || (b?.type === "thinking" && b.thinking) || b?.type === "tool_use");
    const filtered = isFilterFinishReason(json.stop_reason);
    return { retryable: !text, empty: !text, filtered };
  }
  if (Array.isArray(json.candidates)) {
    const valuable = json.candidates.some((c) =>
      c?.content?.parts?.some(
        (p) => (typeof p?.text === "string" && p.text !== "") || p?.functionCall || p?.inlineData
      )
    );
    const filtered = isFilterFinishReason(json.candidates[0]?.finishReason);
    return { retryable: !valuable, empty: !valuable, filtered };
  }
  return { retryable: false, empty: false, filtered: false };
}

// Gate a 2xx Response. Returns { action: "retry" } when the (streaming) answer is
// empty at terminal, or { action: "commit", response } with a reconstructed
// Response whose body replays the buffered head then continues live.
export async function gateResponse(response) {
  const ct = (response.headers.get("content-type") || "").toLowerCase();

  // Non-streaming JSON: cheap, decide directly. Never consumes beyond what we
  // rebuild, so rebuild the Response from the read text.
  if (!ct.includes("text/event-stream") && !ct.includes("stream")) {
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* fall through to commit */
    }
    if (json) {
      const { retryable } = inspectNonStream(json);
      if (retryable) return { action: "retry", meta: inspectNonStream(json) };
    }
    return { action: "commit", response: rewrap(response, text) };
  }

  // Streaming: head-of-line scan.
  if (!response.body) return { action: "commit", response };
  const reader = response.body.getReader();
  const scanner = createStreamScanner();
  let decision = null;
  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      const r = scanner.push(value);
      if (r.kind === "commit") { decision = { kind: "commit" }; break; }
      if (r.kind === "retry") { decision = { kind: "retry" }; break; }
      continue;
    }
    if (done) {
      const r = scanner.finish();
      decision = { kind: r.kind === "retry" ? "retry" : "commit" };
      break;
    }
  }

  if (decision.kind === "retry") {
    // DRAIN the rest to completion — do NOT cancel. The underlying usage-metering
    // stream logs this attempt on its flush (when the body reaches terminal); a
    // reader.cancel() aborts that flush, so the attempt landed in the DB as a
    // client disconnect with zero usage — the opposite of "consumed to its
    // terminal". The retry decision was made at the terminal chunk, so only a
    // trailing usage frame + [DONE] remain; draining them is cheap. A mid-drain
    // upstream error just means there is nothing left to account for.
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      /* upstream errored while draining — nothing left to meter */
    }
    return { action: "retry" };
  }

  // Commit: replay buffered head, then pipe the remainder of the same reader.
  const headChunks = scanner.bufferedBytes;
  const body = new ReadableStream({
    async start(controller) {
      for (const c of headChunks) controller.enqueue(c);
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) controller.enqueue(value);
        }
      } catch (e) {
        controller.error(e);
        return;
      }
      controller.close();
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } catch {
        /* ignore */
      }
    },
  });
  return { action: "commit", response: new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }) };
}

function rewrap(response, text) {
  return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
}
