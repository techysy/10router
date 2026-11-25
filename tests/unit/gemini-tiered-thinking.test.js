import { describe, it, expect } from "vitest";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";

describe("Gemini tiered models thinking level clamp (PR #5355)", () => {
  it("declares low, medium, high (no minimal) for gemini-3.8 tiered models", () => {
    const levels = getThinkingLevels("antigravity", "gemini-3.8-flash-high");
    expect(levels).toEqual(["low", "medium", "high"]);
    expect(levels).not.toContain("minimal");
  });

  it("declares low, medium, high for gemini-3.7 tiered models", () => {
    const levels = getThinkingLevels("antigravity", "gemini-3.7-flash-high");
    expect(levels).toEqual(["low", "medium", "high"]);
    expect(levels).not.toContain("minimal");
  });

  it("declares low, medium, high for gemini-3.6 tiered models", () => {
    const levels = getThinkingLevels("antigravity", "gemini-3.6-flash-medium");
    expect(levels).toEqual(["low", "medium", "high"]);
    expect(levels).not.toContain("minimal");
  });

  it("floors reasoning_effort none to low on the wire for gemini-3.8-flash-high", () => {
    // The reported 400 (upstream PR #5355): "Thinking level MINIMAL is not
    // supported for this model" — none used to pass through as MINIMAL.
    const body = { reasoning_effort: "none" };
    applyThinking("gemini", "gemini-3.8-flash-high", body, "gemini");
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low", includeThoughts: true });
  });

  it("floors an explicit minimal intent to low on the wire", () => {
    const body = { reasoning_effort: "minimal" };
    applyThinking("gemini", "gemini-3.8-flash", body, "gemini");
    expect(body.generationConfig.thinkingConfig.thinkingLevel).toBe("low");
  });
});
