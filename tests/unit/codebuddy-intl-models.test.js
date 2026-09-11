import { describe, expect, it } from "vitest";
import entry from "../../open-sse/providers/registry/codebuddy-intl.js";
import cnEntry from "../../open-sse/providers/registry/codebuddy-cn.js";

describe("CodeBuddy international static model catalog", () => {
  it("does not advertise models confirmed by the intl gateway as 11102", () => {
    const ids = entry.models.map((model) => model.id);
    expect(ids).not.toEqual(expect.arrayContaining([
      // rejected with 11102 "model service info not found" on a live probe
      "glm-5.0-turbo",
      "glm-4.7",
      "glm-4.6",
      "glm-4.5",
      "minimax-m2.7",
      "hy3-preview",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "deepseek-v4.1-pro",
      "deepseek-v3.2",
      "deepseek-v3-2-volc",
      "kimi-k2-thinking",
      "gpt-5.2",
      "gpt-5.1",
      "gpt-5.6",
      "gemini-3.5-pro",
      "gemini-3-flash",
      "qwen3-max",
      "claude-sonnet-4.5",
      "hy4",
      // answers 200 on a live probe but is absent from the published credit
      // list, so it is kept out — same reason the CN catalog drops it.
      "kimi-k2.5",
    ]));
  });

  it("advertises the models the live intl gateway answers", () => {
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
      "glm-5v-turbo",
      "glm-5.3",
      "glm-5.2",
      "glm-5.1",
      "minimax-m3",
      "kimi-k3",
      "kimi-k2.7",
      "kimi-k2.6",
      "deepseek-v4.1-flash",
    ]);
  });

  it("carries the published name and credit multiplier for the probed additions", () => {
    const byId = Object.fromEntries(entry.models.map((model) => [model.id, model]));
    // every one of these answered 200 on a live request through the gateway
    expect(byId["deepseek-v4.1-flash"]).toMatchObject({ name: "DeepSeek-V4.1-Flash", rateMultiplier: 0.03 });
    expect(byId["glm-5.1"]).toMatchObject({ name: "GLM-5.1", rateMultiplier: 0.79 });
    expect(byId["glm-5v-turbo"]).toMatchObject({ name: "GLM-5v-Turbo", rateMultiplier: 0.71 });
    expect(byId["minimax-m3"]).toMatchObject({ name: "MiniMax-M3", rateMultiplier: 0.25 });
    expect(byId["kimi-k2.7"]).toMatchObject({ name: "Kimi-K2.7-Code", rateMultiplier: 0.57 });
  });

  it("keeps a shared CN/intl model at the same credit multiplier", () => {
    // CN and intl bill from one credit system, so an id present on both sides
    // must not drift apart — this is what lets a new intl model inherit the CN
    // multiplier instead of guessing one.
    const cnById = Object.fromEntries(cnEntry.models.map((model) => [model.id, model]));
    const shared = entry.models.filter((model) => cnById[model.id]);
    expect(shared.length).toBeGreaterThanOrEqual(10);
    for (const model of shared) {
      expect([model.id, model.rateMultiplier]).toEqual([model.id, cnById[model.id].rateMultiplier]);
    }
  });
});
