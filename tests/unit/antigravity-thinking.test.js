import { describe, expect, it } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

describe("Antigravity Gemini thinking models", () => {
  it("recognizes gemini-pro-agent as a reasoning model", () => {
    const caps = getCapabilitiesForModel("antigravity", "gemini-pro-agent");
    expect(caps.reasoning).toBe(true);
    expect(caps.thinkingFormat).toBe("gemini-level");
    expect(getThinkingLevels("antigravity", "gemini-pro-agent")).toEqual([
      "minimal", "low", "medium", "high",
    ]);
  });

  it("keeps the OpenAI reasoning intent when translating to Antigravity", () => {
    const out = translateRequest(
      FORMATS.OPENAI,
      FORMATS.ANTIGRAVITY,
      "gemini-pro-agent",
      {
        model: "gemini-pro-agent",
        reasoning_effort: "high",
        messages: [{ role: "user", content: "hello" }],
      },
      true,
      {},
      "antigravity",
    );

    expect(out.request.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: "high",
      includeThoughts: true,
    });
  });
});
