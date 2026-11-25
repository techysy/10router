import { describe, it, expect } from "vitest";
import { __test__ as qoderInternals } from "../../open-sse/executors/qoder.js";
import { openaiToOpenAIResponsesResponse } from "../../open-sse/translator/response/openai-responses.js";
import { openaiToClaudeResponse } from "../../open-sse/translator/response/openai-to-claude.js";

const { wrapQoderSSE } = qoderInternals;

function makeResponse(lines, { status = 200 } = {}) {
  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
  return new Response(body, { status });
}

describe("Issue #88 - Qoder provider_error handling", () => {
  it("first-frame 429 provider_error returns HTTP 429 error response for failover", async () => {
    const errorEnv = JSON.stringify({
      statusCodeValue: 429,
      body: JSON.stringify({
        code: "provider_error",
        message: "All backends failed",
        type: "provider_error",
      }),
    });
    const upstream = `data: ${errorEnv}\n\n`;

    const res = await wrapQoderSSE(makeResponse([upstream]), "qoder-cn/kmodel_latest");

    expect(res.status).toBe(429);
    expect(res.ok).toBe(false);
    const data = await res.json();
    expect(data.error.message).toContain("All backends failed");
    expect(data.error.type).toBe("provider_error");
  });

  it("mid-stream error emits structured error chunk without fake choices or finish_reason: 'stop'", async () => {
    // Frame 1: successful delta
    const frame1 = `data: ${JSON.stringify({
      statusCodeValue: 200,
      body: JSON.stringify({ choices: [{ delta: { content: "1 2 3" } }] }),
    })}\n\n`;

    // Frame 2: mid-stream failure
    const frame2 = `data: ${JSON.stringify({
      statusCodeValue: 429,
      body: JSON.stringify({
        code: "provider_error",
        message: "All backends failed",
        type: "provider_error",
      }),
    })}\n\n`;

    const res = await wrapQoderSSE(makeResponse([frame1, frame2]), "qoder-cn/kmodel_latest");
    expect(res.status).toBe(200);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();

    // Verify it doesn't contain finish_reason: "stop" or fake text delta
    expect(text).not.toContain('"finish_reason":"stop"');
    expect(text).not.toContain('"delta":{"content":"\\n[qoder error');

    // Verify it contains a structured error chunk followed by [DONE]
    expect(text).toContain('"type":"provider_error"');
    expect(text).toContain("All backends failed");
    expect(text).toContain("data: [DONE]");
  });

  it("openaiToOpenAIResponsesResponse maps error chunk to response.failed (not response.completed)", () => {
    const state = { seq: 0, responseId: "resp_test123", created: 1700000000 };

    const errorChunk = {
      id: "qoder-error-123",
      error: {
        message: "All backends failed",
        type: "provider_error",
        code: 429,
      },
    };

    const events = openaiToOpenAIResponsesResponse(errorChunk, state);
    expect(events.length).toBeGreaterThan(0);

    const failedEvent = events.find((e) => e.event === "response.failed");
    expect(failedEvent).toBeDefined();
    expect(failedEvent.data.response.status).toBe("failed");
    expect(failedEvent.data.response.error.message).toBe("All backends failed");

    // Must NOT emit response.completed
    const completedEvent = events.find((e) => e.event === "response.completed");
    expect(completedEvent).toBeUndefined();
  });

  it("openaiToClaudeResponse maps error chunk to Anthropic error event", () => {
    const state = {};
    const errorChunk = {
      id: "qoder-error-123",
      error: {
        message: "All backends failed",
        type: "provider_error",
        code: 429,
      },
    };

    const events = openaiToClaudeResponse(errorChunk, state);
    expect(events).toEqual([
      {
        type: "error",
        error: {
          type: "provider_error",
          message: "All backends failed",
        },
      },
    ]);
  });
});
