import { describe, expect, it, vi } from "vitest";
import { handleComboChat, isZeroContentResponse } from "../../open-sse/services/combo.js";
import { createSSEStream } from "../../open-sse/utils/stream.js";
import { translateNonStreamingResponse } from "../../open-sse/handlers/chatCore/nonStreamingHandler.js";

function drain(stream) {
  const reader = stream.getReader();
  return (async () => {
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
    return out;
  })();
}

function feed(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
}

describe("Issue #96: reasoning-only response handling", () => {
  it("combo recognizes reasoning-only response (content is empty) as zero content and falls back", async () => {
    // 1. isZeroContentResponse returns true for choices with only reasoning_content
    const emptyWithReasoning = {
      choices: [{
        index: 0,
        message: { role: "assistant", content: "", reasoning_content: "Thought process of GLM-5.3..." },
        finish_reason: "stop",
      }],
    };
    expect(isZeroContentResponse(emptyWithReasoning)).toBe(true);

    // 2. handleComboChat falls back to the next model in the combo
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(emptyWithReasoning), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{
          index: 0,
          message: { role: "assistant", content: "Normal answer from DeepSeek-Flash" },
          finish_reason: "stop",
        }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));

    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "hello" }] },
      models: ["river/zai-org/GLM-5.3-Flash", "river/deepseek-ai/DeepSeek-V4.1-Flash"],
      handleSingleModel,
      log,
      autoSwitch: false,
    });

    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    const body = await result.json();
    expect(body.choices[0].message.content).toBe("Normal answer from DeepSeek-Flash");
  });

  it("streaming passthrough promotes reasoning to content when stream ends with empty content (issue #96)", async () => {
    const stream = createSSEStream({
      mode: "passthrough",
      model: "river/zai-org/GLM-5.3-Flash",
    });

    // Push chunks that only carry reasoning_content and an empty finish chunk
    const chunks = [
      'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
      'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"reasoning_content":"Step 1: Analyzing issue... "}}]}\n\n',
      'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"reasoning_content":"Step 2: Conclusion."}}]}\n\n',
      'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const fullOutput = await drain(feed(chunks).pipeThrough(stream));

    // 验证：在最终输出给客户端的数据中，包含了一个将思考内容作为 content 发送的 delta 块
    expect(fullOutput).toContain('"delta":{"content":"Step 1: Analyzing issue... Step 2: Conclusion."}');
    // 并且原有的 reasoning_content 也没有被剥离
    expect(fullOutput).toContain('"reasoning_content":"Step 1: Analyzing issue... "');
    expect(fullOutput).toContain("data: [DONE]");
  });

  it("does not synthesize content delta if stream already emitted non-empty content", async () => {
    const stream = createSSEStream({
      mode: "passthrough",
      model: "test-model",
    });

    const chunks = [
      'data: {"id":"2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"reasoning_content":"thinking"}}]}\n\n',
      'data: {"id":"2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"real content"}}]}\n\n',
      'data: {"id":"2","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const fullOutput = await drain(feed(chunks).pipeThrough(stream));

    // Since content was emitted, reasoning should NOT be promoted to content
    expect(fullOutput).not.toContain('"delta":{"content":"thinking"}');
    expect(fullOutput).toContain('"delta":{"content":"real content"}');
  });

  it("does not synthesize content delta if tool_calls were emitted", async () => {
    const stream = createSSEStream({
      mode: "passthrough",
      model: "test-model",
    });

    const chunks = [
      'data: {"id":"3","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"reasoning_content":"thinking about calling tool"}}]}\n\n',
      'data: {"id":"3","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"search","arguments":"{}"}}]}}]}\n\n',
      'data: {"id":"3","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const fullOutput = await drain(feed(chunks).pipeThrough(stream));

    // A tool call turn has empty content by design — must NOT promote reasoning to content
    expect(fullOutput).not.toContain('"delta":{"content":"thinking about calling tool"}');
    expect(fullOutput).toContain('"tool_calls"');
  });

  it("non-streaming response promotes reasoning to content when content is empty and no tool_calls (issue #96)", () => {
    const rawResponse = {
      id: "chatcmpl-123",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "",
            reasoning_content: "Deep thinking breakdown...",
          },
          finish_reason: "stop",
        },
      ],
    };

    const translated = translateNonStreamingResponse(rawResponse, "openai", "openai");
    // content should be promoted from reasoning_content so client sees actual text
    expect(translated.choices[0].message.content).toBe("Deep thinking breakdown...");
    // reasoning_content should also be preserved
    expect(translated.choices[0].message.reasoning_content).toBe("Deep thinking breakdown...");
  });
});
