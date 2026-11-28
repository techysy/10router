import { SESSION_ROUTING as CFG } from "../config/routingStrategies.js";
import { CLAUDE_BLOCK, RESPONSES_ITEM } from "../translator/schema/blocks.js";
import { OPENAI_FINISH, CLAUDE_STOP, GEMINI_FINISH } from "../translator/schema/finishReasons.js";

// Track the selected attempts, but observe only the final client-facing response.
// In particular, a discarded combo candidate must never pin its account.
const observers = new WeakMap();

export function onSessionResponse(response, callback, original = response) {
  const callbacks = observers.get(original) || [];
  observers.set(response, callback ? [...callbacks, callback] : callbacks);
}

export function observeSessionResponse(response) {
  const callbacks = observers.get(response);
  const contentType = response.headers.get("content-type") || "";
  const stream = contentType.includes("text/event-stream");
  if (!callbacks?.length || !response.body || (!stream && !contentType.includes("json"))) return response;

  const ids = new Set();
  const decoder = new TextDecoder();
  let buffer = "";
  let dropping = false;
  let finished = false;
  let accepted = false;
  let claudeStop = false;
  const add = (value) => {
    if (typeof value === "string" && value.length <= CFG.maxIdLength && ids.size < CFG.maxToolIds) ids.add(value);
  };
  function inspect(data) {
    if (!data || typeof data !== "object") return;
    if (data.error || data.type === "error" || data.type === "response.failed") {
      accepted = false;
      finished = true;
      return;
    }
    const responseBody = data.response || data;
    for (const choice of data.choices?.slice?.(0, CFG.maxToolIds) || []) {
      const message = choice.message || choice.delta;
      for (const call of message?.tool_calls?.slice?.(0, CFG.maxToolIds) || []) add(call?.id);
      if ([OPENAI_FINISH.STOP, OPENAI_FINISH.LENGTH, OPENAI_FINISH.TOOL_CALLS, "function_call"].includes(choice.finish_reason)) accepted = true;
    }
    for (const block of data.content?.slice?.(0, CFG.maxToolIds) || []) {
      if (block?.type === CLAUDE_BLOCK.TOOL_USE) add(block.id);
    }
    if (data.content_block?.type === CLAUDE_BLOCK.TOOL_USE) add(data.content_block.id);
    const outputs = data.item ? [data.item] : responseBody.output;
    for (const item of outputs?.slice?.(0, CFG.maxToolIds) || []) {
      if ([RESPONSES_ITEM.FUNCTION_CALL, RESPONSES_ITEM.CUSTOM_TOOL_CALL].includes(item?.type)) add(item.call_id);
    }
    const stop = data.delta?.stop_reason || data.stop_reason;
    if ([CLAUDE_STOP.END_TURN, CLAUDE_STOP.STOP_SEQUENCE, CLAUDE_STOP.MAX_TOKENS, CLAUDE_STOP.TOOL_USE].includes(stop)) claudeStop = true;
    if ((!stream && claudeStop) || (data.type === "message_stop" && claudeStop)
      || data.type === "response.completed" || responseBody.status === "completed"
      || [GEMINI_FINISH.STOP, GEMINI_FINISH.MAX_TOKENS].includes(responseBody.candidates?.[0]?.finishReason)
      || (data.done === true && !data.error)) accepted = true;
  }
  function parse(text) {
    try { inspect(JSON.parse(text)); } catch { /* inspection never changes the response */ }
  }
  function line(text) {
    if (!text.startsWith("data:")) return;
    const payload = text.slice(5).trim();
    if (payload !== "[DONE]") parse(payload);
  }
  const body = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      if (!finished) {
        const text = decoder.decode(chunk, { stream: true });
        let start = 0;
        do {
          const end = stream ? text.indexOf("\n", start) : -1;
          const length = (end < 0 ? text.length : end) - start;
          if (!dropping && buffer.length + length <= CFG.maxFrameBytes) buffer += text.slice(start, start + length);
          else { dropping = true; buffer = ""; }
          if (end < 0) break;
          if (!dropping) line(buffer);
          dropping = false;
          buffer = "";
          start = end + 1;
        } while (!finished);
      }
      controller.enqueue(chunk);
    },
    flush() {
      if (!finished && !dropping) {
        if (stream) line(buffer); else parse(buffer);
      }
      if (accepted) for (const callback of callbacks) callback(ids);
    },
  }));
  return new Response(body, response);
}
