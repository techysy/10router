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
    expect(ids).toEqual(expect.arrayContaining([
      "glm-5.2",
      "glm-5.1",
      "glm-5.0",
      "glm-5v-turbo",
      "minimax-m3",
      "kimi-k2.7",
      "kimi-k2.6",
      "kimi-k2.5",
    ]));
  });
});
