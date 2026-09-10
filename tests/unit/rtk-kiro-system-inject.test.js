// RTK system-prompt injection into a Kiro body. kiro.dev answers any body carrying a
// top-level `systemPrompt` with 400 REQUEST_BODY_INVALID, so the injector has to write
// into the conversation turns instead — writing to `body.systemPrompt` is what made
// every kr/ model fail whenever an RTK prompt (caveman, ponytail) was active.
import { describe, expect, it } from "vitest";
import { injectSystemPrompt } from "../../open-sse/rtk/systemInject.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const PROMPT = "CAVEMAN: answer short";

const userTurn = (content) => ({ userInputMessage: { content, modelId: "m", origin: "AI_EDITOR" } });

const kiroBody = (history = []) => ({
  conversationState: {
    chatTriggerType: "MANUAL",
    currentMessage: userTurn("current turn"),
    history,
  },
});

const kiroHistory = (content) => [
  { userInputMessage: { content, modelId: "m", origin: "AI_EDITOR" } },
  { assistantResponseMessage: { content: "earlier answer" } },
];

describe("injectSystemPrompt into a Kiro body", () => {
  it("appends to the current user turn when there is no history", () => {
    const body = kiroBody();

    injectSystemPrompt(body, FORMATS.KIRO, PROMPT);

    expect(body.conversationState.currentMessage.userInputMessage.content).toBe(
      `current turn\n\n${PROMPT}`
    );
  });

  it("appends to the first history user turn once history exists", () => {
    const body = kiroBody(kiroHistory("first turn"));

    injectSystemPrompt(body, FORMATS.KIRO, PROMPT);

    expect(body.conversationState.history[0].userInputMessage.content).toBe(
      `first turn\n\n${PROMPT}`
    );
    expect(body.conversationState.currentMessage.userInputMessage.content).toBe("current turn");
  });

  it("never writes a top-level systemPrompt", () => {
    const body = kiroBody();

    injectSystemPrompt(body, FORMATS.KIRO, PROMPT);

    expect(body).not.toHaveProperty("systemPrompt");
  });

  it("is idempotent across retries", () => {
    const body = kiroBody(kiroHistory("first turn"));

    injectSystemPrompt(body, FORMATS.KIRO, PROMPT);
    injectSystemPrompt(body, FORMATS.KIRO, PROMPT);

    const content = body.conversationState.history[0].userInputMessage.content;
    expect(content.match(/CAVEMAN: answer short/g)).toHaveLength(1);
  });

  it("replaces a non-string turn content with the prompt", () => {
    const body = kiroBody();
    body.conversationState.currentMessage.userInputMessage.content = undefined;

    injectSystemPrompt(body, FORMATS.KIRO, PROMPT);

    expect(body.conversationState.currentMessage.userInputMessage.content).toBe(PROMPT);
  });

  it("is a no-op when the body is not Kiro-shaped", () => {
    const body = { messages: [{ role: "user", content: "hello" }] };

    injectSystemPrompt(body, FORMATS.KIRO, PROMPT);

    expect(body).not.toHaveProperty("systemPrompt");
    expect(body.messages).toHaveLength(1);
  });

  it("fails open on a frozen body", () => {
    const body = kiroBody();
    Object.freeze(body.conversationState.currentMessage.userInputMessage);

    expect(() => injectSystemPrompt(body, FORMATS.KIRO, PROMPT)).not.toThrow();
  });

  it("keeps injecting into OpenAI-shaped bodies", () => {
    const body = { messages: [{ role: "system", content: "base" }, { role: "user", content: "hi" }] };

    injectSystemPrompt(body, FORMATS.OPENAI, PROMPT);

    expect(body.messages[0].content).toContain(PROMPT);
  });

  it("leaves a Claude body alone when the format is Kiro", () => {
    const body = { system: "base", messages: [{ role: "user", content: "hi" }] };

    injectSystemPrompt(body, FORMATS.KIRO, PROMPT);

    expect(body.system).toBe("base");
    expect(body.messages).toHaveLength(1);
  });
});
