import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  saveUsageStats: vi.fn(async () => {}),
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { handleNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");

function context({ model, body, responseBody, targetFormat = FORMATS.OPENAI }) {
  return {
    providerResponse: new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    provider: "openai-compatible-chat",
    model,
    sourceFormat: FORMATS.OPENAI,
    targetFormat,
    body,
    stream: false,
    translatedBody: body,
    finalBody: body,
    requestStartTime: Date.now(),
    connectionId: "test-connection",
    clientRawRequest: { endpoint: "/v1/chat/completions" },
    trackDone: vi.fn(),
    appendLog: vi.fn(),
    reqLogger: {
      logProviderResponse: vi.fn(),
      logConvertedResponse: vi.fn(),
    },
  };
}

const RESPONSE = {
  id: "chatcmpl-gemini",
  object: "chat.completion",
  model: "gemini-3.1-pro",
  choices: [{
    index: 0,
    message: {
      role: "assistant",
      content: "final answer",
      reasoning_content: "internal plan",
    },
    finish_reason: "stop",
  }],
  usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
};

describe("Gemini reasoning on non-streaming responses", () => {
  it("preserves reasoning_content for a Gemini model with visible content", async () => {
    const result = await handleNonStreamingResponse(context({
      model: "gemini-3.1-pro",
      body: { model: "gemini-3.1-pro", messages: [{ role: "user", content: "hi" }] },
      targetFormat: FORMATS.ANTIGRAVITY,
      responseBody: {
        response: {
          responseId: "resp-gemini",
          modelVersion: "gemini-3.1-pro",
          candidates: [{
            content: { parts: [
              { text: "internal plan", thought: true },
              { text: "final answer" },
            ] },
            finishReason: "STOP",
          }],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 },
        },
      },
    }));

    const json = await result.response.json();
    expect(json.choices[0].message).toMatchObject({
      content: "final answer",
      reasoning_content: "internal plan",
    });
  });

  it("keeps the historical omission for non-Gemini models", async () => {
    const result = await handleNonStreamingResponse(context({
      model: "deepseek-reasoner",
      body: {
        model: "deepseek-reasoner",
        reasoning_effort: "high",
        messages: [{ role: "user", content: "hi" }],
      },
      responseBody: { ...RESPONSE, model: "deepseek-reasoner" },
    }));

    const json = await result.response.json();
    expect(json.choices[0].message.reasoning_content).toBeUndefined();
  });

  it("keeps the historical omission for ordinary non-reasoning responses", async () => {
    const result = await handleNonStreamingResponse(context({
      model: "gpt-4o",
      body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      responseBody: { ...RESPONSE, model: "gpt-4o" },
    }));

    const json = await result.response.json();
    expect(json.choices[0].message.reasoning_content).toBeUndefined();
  });
});
