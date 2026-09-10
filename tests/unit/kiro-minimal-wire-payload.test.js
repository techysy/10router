// Kiro wire shape: the runtime rejects the retired agent fields, and it answers any
// body carrying a top-level `systemPrompt` with
//   400 {"message":"Improperly formed request.","reason":"REQUEST_BODY_INVALID"}
// Both direct translators must therefore stay minimal — the system text travels
// inside the first user turn's content (contentPrefix) instead.
import { describe, expect, it } from "vitest";
import { openaiToKiroRequest } from "../../open-sse/translator/request/openai-to-kiro.js";
import { claudeToKiroRequest } from "../../open-sse/translator/request/claude-to-kiro.js";

const CASES = [
  [
    "openai → kiro",
    openaiToKiroRequest,
    { messages: [{ role: "system", content: "sys-here" }, { role: "user", content: "hello" }] },
  ],
  [
    "claude → kiro",
    claudeToKiroRequest,
    { system: "sys-here", messages: [{ role: "user", content: "hello" }] },
  ],
];

describe.each(CASES)("%s minimal wire payload", (_name, translate, body) => {
  const payload = () => translate("claude-sonnet-4.5", body, true, {});

  it("omits the retired top-level agent fields", () => {
    const out = payload();

    expect(out).not.toHaveProperty("agentMode");
    expect(out.conversationState).not.toHaveProperty("agentContinuationId");
    expect(out.conversationState).not.toHaveProperty("agentTaskType");
  });

  it("never emits a top-level systemPrompt", () => {
    expect(payload()).not.toHaveProperty("systemPrompt");
  });

  it("keeps the required conversation markers", () => {
    const out = payload();

    expect(out.conversationState.chatTriggerType).toBe("MANUAL");
    expect(out.conversationState.currentMessage.userInputMessage.origin).toBe("AI_EDITOR");
    expect(out.conversationState.currentMessage.userInputMessage.modelId).toBe("claude-sonnet-4.5");
  });

  it("carries the system text in the first user turn instead", () => {
    const content = payload().conversationState.currentMessage.userInputMessage.content;

    expect(content).toContain("sys-here");
    expect(content).toContain("hello");
  });
});
