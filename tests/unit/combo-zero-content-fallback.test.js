import { describe, expect, it, vi } from "vitest";
import { handleComboChat, isZeroContentResponse } from "../../open-sse/services/combo.js";

describe("isZeroContentResponse", () => {
  it("detects empty choices array", () => {
    expect(isZeroContentResponse({ choices: [] })).toBe(true);
  });

  it("detects empty content with in_progress or incomplete finish reason", () => {
    expect(isZeroContentResponse({
      choices: [{ message: { content: "" }, finish_reason: "in_progress" }]
    })).toBe(true);
    expect(isZeroContentResponse({
      choices: [{ message: { content: "   " }, finish_reason: "incomplete" }]
    })).toBe(true);
  });

  it("detects empty content without normal finish reason", () => {
    expect(isZeroContentResponse({
      choices: [{ message: { content: "" }, finish_reason: null }]
    })).toBe(true);
  });

  it("does not flag normal finish with content", () => {
    expect(isZeroContentResponse({
      choices: [{ message: { content: "Hello!" }, finish_reason: "stop" }]
    })).toBe(false);
  });

  it("does not flag responses with tool_calls", () => {
    expect(isZeroContentResponse({
      choices: [{
        message: { content: "", tool_calls: [{ id: "call_1", function: { name: "test" } }] },
        finish_reason: "tool_calls"
      }]
    })).toBe(false);
  });

  it("flags reasoning-only responses with empty content as zero content for combo fallback (issue #96)", () => {
    // When a model produces reasoning but ends with an empty content and no tool_calls,
    // clients like Hermes Agent reject it as empty. Combos should fall back to the next model.
    expect(isZeroContentResponse({
      choices: [{
        message: { content: "", reasoning_content: "thinking..." },
        finish_reason: "stop"
      }]
    })).toBe(true);
    // But if there is content alongside reasoning, it is not zero content
    expect(isZeroContentResponse({
      choices: [{
        message: { content: "Here is the answer", reasoning_content: "thinking..." },
        finish_reason: "stop"
      }]
    })).toBe(false);
  });

  it("detects Anthropic empty message with incomplete or missing stop_reason", () => {
    expect(isZeroContentResponse({
      content: [],
      stop_reason: null
    })).toBe(true);
    expect(isZeroContentResponse({
      content: [{ type: "text", text: "" }],
      stop_reason: "incomplete"
    })).toBe(true);
  });

  it("does not flag Anthropic response with text or tool_use", () => {
    expect(isZeroContentResponse({
      content: [{ type: "text", text: "Hi" }],
      stop_reason: "end_turn"
    })).toBe(false);
    expect(isZeroContentResponse({
      content: [{ type: "tool_use", id: "t1", name: "fn" }],
      stop_reason: "tool_use"
    })).toBe(false);
  });
});

describe("handleComboChat 200 zero content fallback", () => {
  it("falls back to next model when HTTP 200 JSON has zero usable content", async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "" }, finish_reason: "in_progress" }]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "Success from model 2" }, finish_reason: "stop" }]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));

    const result = await handleComboChat({
      body: { messages: [] },
      models: ["model-1", "model-2"],
      handleSingleModel,
      log,
      autoSwitch: false,
    });

    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    const body = await result.json();
    expect(body.choices[0].message.content).toBe("Success from model 2");
    expect(log.warn).toHaveBeenCalledWith(
      "COMBO",
      expect.stringContaining("returned HTTP 200 with zero usable content, falling back to next model")
    );
  });

  it("returns response as-is if last model returns HTTP 200 zero content", async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "" }, finish_reason: "in_progress" }]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));

    const result = await handleComboChat({
      body: { messages: [] },
      models: ["model-1"],
      handleSingleModel,
      log,
      autoSwitch: false,
    });

    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    const body = await result.json();
    expect(body.choices[0].message.content).toBe("");
  });

  it("falls back to next model when HTTP 200 JSON is reasoning-only with empty content (issue #96)", async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{
          message: { content: "", reasoning_content: "I am thinking through GLM-5.3..." },
          finish_reason: "stop"
        }]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{
          message: { content: "Final answer from DeepSeek-Flash" },
          finish_reason: "stop"
        }]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));

    const result = await handleComboChat({
      body: { messages: [] },
      models: ["river/zai-org/GLM-5.3-Flash", "river/deepseek-ai/DeepSeek-V4.1-Flash"],
      handleSingleModel,
      log,
      autoSwitch: false,
    });

    expect(handleSingleModel).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    const body = await result.json();
    expect(body.choices[0].message.content).toBe("Final answer from DeepSeek-Flash");
    expect(log.warn).toHaveBeenCalledWith(
      "COMBO",
      expect.stringContaining("returned HTTP 200 with zero usable content, falling back to next model")
    );
  });
});
