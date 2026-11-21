import { describe, expect, it } from "vitest";
import { hasCompletedSSEChatTurn, isCompletedChatResponse } from "../../open-sse/utils/completedChatTurn.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const sse = (frames) => frames.map((f) => `data: ${typeof f === "string" ? f : JSON.stringify(f)}`).join("\n\n") + "\n\ndata: [DONE]\n\n";

describe("isCompletedChatResponse", () => {
  it.each(["stop", "tool_calls"])("accepts OpenAI finish_reason %s", (finish) => {
    expect(isCompletedChatResponse({ choices: [{ finish_reason: finish }] }, FORMATS.OPENAI)).toBe(true);
  });
  it.each(["length", "content_filter", null, undefined])("rejects OpenAI finish_reason %s", (finish) => {
    expect(isCompletedChatResponse({ choices: [{ finish_reason: finish }] }, FORMATS.OPENAI)).toBe(false);
  });
  it("rejects an error body and empty input", () => {
    expect(isCompletedChatResponse({ error: { message: "denied" } }, FORMATS.OPENAI)).toBe(false);
    expect(isCompletedChatResponse(null, FORMATS.OPENAI)).toBe(false);
  });
  it.each(["end_turn", "stop_sequence", "tool_use"])("accepts Claude stop_reason %s", (reason) => {
    expect(isCompletedChatResponse({ type: "message", stop_reason: reason }, FORMATS.CLAUDE)).toBe(true);
  });
  it("rejects Claude max_tokens", () => {
    expect(isCompletedChatResponse({ type: "message", stop_reason: "max_tokens" }, FORMATS.CLAUDE)).toBe(false);
  });
  it("accepts Responses API status completed and rejects failed", () => {
    expect(isCompletedChatResponse({ object: "response", status: "completed" }, FORMATS.OPENAI_RESPONSES)).toBe(true);
    expect(isCompletedChatResponse({ object: "response", status: "failed" }, FORMATS.OPENAI_RESPONSES)).toBe(false);
  });
});

describe("hasCompletedSSEChatTurn", () => {
  it("accepts a standard finish_reason frame", () => {
    expect(hasCompletedSSEChatTurn(sse([{ choices: [{ delta: { content: "hi" } }] }, { choices: [{ finish_reason: "stop" }] }]), FORMATS.OPENAI)).toBe(true);
  });
  it("rejects a stream that ends with [DONE] but no finish frame", () => {
    expect(hasCompletedSSEChatTurn(sse([{ choices: [{ delta: { content: "hi" } }] }]), FORMATS.OPENAI)).toBe(false);
  });
  it("rejects a length finish_reason", () => {
    expect(hasCompletedSSEChatTurn(sse([{ choices: [{ finish_reason: "length" }] }]), FORMATS.OPENAI)).toBe(false);
  });
  it("accepts a Responses API response.completed event", () => {
    const raw = "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\ndata: [DONE]\n\n";
    expect(hasCompletedSSEChatTurn(raw, FORMATS.OPENAI_RESPONSES)).toBe(true);
  });
  it("rejects a Responses API response.failed event", () => {
    const raw = "event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\"}}\n\n";
    expect(hasCompletedSSEChatTurn(raw, FORMATS.OPENAI_RESPONSES)).toBe(false);
  });
  it("accepts a Claude message_delta with end_turn", () => {
    expect(hasCompletedSSEChatTurn(sse([{ type: "message_delta", delta: { stop_reason: "end_turn" } }]), FORMATS.CLAUDE)).toBe(true);
  });
  it("ignores malformed data frames instead of guessing", () => {
    expect(hasCompletedSSEChatTurn("data: {not-json}\n\n<html>error</html>\ndata: [DONE]\n\n", FORMATS.OPENAI)).toBe(false);
  });
});
