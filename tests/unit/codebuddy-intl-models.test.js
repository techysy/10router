import { describe, expect, it } from "vitest";
import entry from "../../open-sse/providers/registry/codebuddy-intl.js";

describe("CodeBuddy international static model catalog", () => {
  it("does not advertise models confirmed by the intl gateway as 11102", () => {
    const ids = entry.models.map((model) => model.id);
    expect(ids).not.toEqual(expect.arrayContaining([
      "glm-5.0-turbo",
      "glm-4.7",
      "minimax-m2.7",
      "hy3-preview",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "deepseek-v3-2-volc",
    ]));
  });

  it("keeps models confirmed available or temporarily unavailable", () => {
    const ids = entry.models.map((model) => model.id);
    expect(ids).toEqual([
      "hy4-preview",
      "hy3",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.3-codex",
      "gemini-3.5-flash",
      "glm-5.3",
      "glm-5.2",
      "kimi-k3",
      "kimi-k2.6",
    ]);
  });
});
