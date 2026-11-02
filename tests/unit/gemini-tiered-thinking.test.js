import { describe, it, expect } from "vitest";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";

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
});
