import { FORMATS } from "../translator/formats.js";

const ACCEPTED_OPENAI_FINISH = new Set(["stop", "tool_calls"]);
const ACCEPTED_CLAUDE_STOP = new Set(["end_turn", "stop_sequence", "tool_use"]);

/**
 * A Croli chat event means one user request reached a provider-authored terminal.
 * Never infer completion from HTTP 200, EOF, or a parser's default stop reason.
 */
export function isCompletedChatResponse(body, upstreamFormat) {
  if (!body || typeof body !== "object" || body.error) return false;
  if (upstreamFormat === FORMATS.OPENAI_RESPONSES || body.object === "response") {
    return body.status === "completed";
  }
  if (upstreamFormat === FORMATS.CLAUDE || body.type === "message") {
    return ACCEPTED_CLAUDE_STOP.has(body.stop_reason);
  }
  if (upstreamFormat === FORMATS.GEMINI || upstreamFormat === FORMATS.ANTIGRAVITY || upstreamFormat === FORMATS.GEMINI_CLI) {
    return body?.response?.candidates?.[0]?.finishReason === "STOP"
      || body?.candidates?.[0]?.finishReason === "STOP";
  }
  const finish = body?.choices?.[0]?.finish_reason;
  return ACCEPTED_OPENAI_FINISH.has(finish);
}

/** Inspect raw SSE frames; EOF or a synthesized [DONE] alone is not success. */
export function hasCompletedSSEChatTurn(rawSSE, upstreamFormat) {
  let eventName = "";
  for (const line of String(rawSSE || "").split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
      continue;
    }
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let frame;
    try { frame = JSON.parse(payload); } catch { continue; }
    if (upstreamFormat === FORMATS.OPENAI_RESPONSES || eventName.startsWith("response.")) {
      if (eventName === "response.completed" || frame.type === "response.completed" || frame.response?.status === "completed") return true;
      if (eventName === "response.failed" || frame.type === "response.failed" || frame.response?.status === "failed") return false;
      continue;
    }
    if (upstreamFormat === FORMATS.CLAUDE) {
      if (frame.type === "message_delta" && ACCEPTED_CLAUDE_STOP.has(frame.delta?.stop_reason)) return true;
      continue;
    }
    if ([FORMATS.GEMINI, FORMATS.ANTIGRAVITY, FORMATS.GEMINI_CLI].includes(upstreamFormat)) {
      if ((frame.response?.candidates?.[0]?.finishReason || frame.candidates?.[0]?.finishReason) === "STOP") return true;
      continue;
    }
    if (ACCEPTED_OPENAI_FINISH.has(frame.choices?.[0]?.finish_reason)) return true;
  }
  return false;
}
