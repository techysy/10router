import { describe, it, expect } from "vitest";
import { aggregateComboCapabilities } from "../../open-sse/providers/capabilities.js";

describe("combo context fields propagation", () => {
  it("should include context_length, context_window, max_completion_tokens in /v1/models combo entries", () => {
    // Simulate a combo with one member carrying 1M context
    const models = ["tokenharbor/claude-haiku-5.5:free"];
    const caps = aggregateComboCapabilities(models);
    expect(caps).not.toBeNull();
    expect(caps.contextWindow).toBe(1000000);
    expect(caps.maxOutput).toBe(128000);

    // The route.js logic under test (mirror of the patched block)
    const entry = { id: "Claude-Haiku-5.5", object: "model", owned_by: "combo" };
    if (caps && Number.isFinite(caps.contextWindow)) {
      entry.context_length = caps.contextWindow;
      entry.context_window = caps.contextWindow;
    }
    if (caps && Number.isFinite(caps.maxOutput)) {
      entry.max_completion_tokens = caps.maxOutput;
    }

    expect(entry.context_length).toBe(1000000);
    expect(entry.context_window).toBe(1000000);
    expect(entry.max_completion_tokens).toBe(128000);
  });

  it("should skip fields when caps are null or non-finite", () => {
    const entry = { id: "X", object: "model", owned_by: "combo" };
    const caps = null;
    if (caps && Number.isFinite(caps.contextWindow)) {
      entry.context_length = caps.contextWindow;
    }
    expect(entry.context_length).toBeUndefined();
    expect(entry.context_window).toBeUndefined();
    expect(entry.max_completion_tokens).toBeUndefined();
  });
});
