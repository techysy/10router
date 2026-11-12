import { describe, expect, it } from "vitest";

import { getModelUpstreamId } from "../../open-sse/config/providerModels.js";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { applyThinking, stripThinkingSuffix } from "../../open-sse/translator/concerns/thinkingUnified.js";

describe("Gemini 4 Argon capabilities", () => {
  it.each(["gemini", "vertex", "antigravity"])("declares level-based always-on reasoning on %s", (provider) => {
    const model = provider === "antigravity" ? "gemini-4-argon-high" : "gemini-4-argon";
    const caps = getCapabilitiesForModel(provider, model);
    expect(caps.reasoning).toBe(true);
    expect(caps.thinkingFormat).toBe("gemini-level");
    expect(caps.thinkingCanDisable).toBe(false);
    expect(caps.contextWindow).toBe(1048576);
    // 本仓锁定的 Argon 规格：1M output（早期移植 e578dcd0 的判定），无 3 系 A/V 尾部。
    expect(caps.maxOutput).toBe(1048576);
    expect(caps.audioInput).toBe(false);
    expect(caps.videoInput).toBe(false);
    expect(getThinkingLevels(provider, model)).toEqual(["low", "medium", "high"]);
  });
});

describe("Gemini 4 Argon thinking clamp", () => {
  // Argon rejects thinkingLevel "minimal" (and thinkingBudget) with HTTP 400 —
  // every path that would emit "minimal" must clamp to the lowest supported level.
  it("clamps an explicit reasoning_effort none to low", () => {
    const body = { reasoning_effort: "none" };
    applyThinking("gemini", "gemini-4-argon", body, "vertex");
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low", includeThoughts: true });
  });

  it("clamps a small thinking budget (minimal after conversion) to low", () => {
    const body = { thinking: { type: "enabled", budget_tokens: 512 } };
    applyThinking("gemini", "gemini-4-argon", body, "vertex");
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low", includeThoughts: true });
  });

  it("passes supported levels through untouched", () => {
    const body = { reasoning_effort: "high" };
    applyThinking("gemini", "gemini-4-argon", body, "vertex");
    expect(body.generationConfig.thinkingConfig.thinkingLevel).toBe("high");
  });

  it("keeps minimal for original Gemini 3 models (regression guard)", () => {
    // gemini-3-flash-preview is a true original Gemini 3 model with a real MINIMAL
    // tier. gemini-3.8/3.7/3.6 tiered models have no MINIMAL tier (upstream PR #5355)
    // and are floored to low — covered in gemini-tiered-thinking.test.js.
    const body = { reasoning_effort: "none" };
    applyThinking("gemini", "gemini-3-flash-preview", body, "gemini");
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "minimal", includeThoughts: false });
  });
});

describe("Gemini 4 Argon Antigravity tier", () => {
  it("maps the high tier to the wire model with a high thinking level", () => {
    const upstreamModel = getModelUpstreamId("ag", "gemini-4-argon-high");
    expect(upstreamModel).toBe("gemini-4-argon-high(high)");

    const body = {
      model: stripThinkingSuffix(upstreamModel),
      request: {
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
        generationConfig: {},
      },
    };

    applyThinking("antigravity", upstreamModel, body, "antigravity");
    const finalBody = new AntigravityExecutor().transformRequest(
      "gemini-4-argon-high",
      body,
      true,
      { projectId: "project", connectionId: "connection" }
    );

    expect(finalBody.model).toBe("gemini-4-argon-high");
    expect(finalBody.request.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "high", includeThoughts: true });
  });
});

// gemini-4-* 计价（借上游 9router v0.5.119 的记账错误修复，2026-11-12）：
// 没有 gemini-4-* 模式时 -high/-medium/-low 后缀落到 generic gemini-*
// （$0.50/$3.00），而实际是 $2/$10 —— 修复后被 tier 前缀无差别命中。
describe("Gemini 4 pricing", () => {
  it.each([
    ["antigravity", "gemini-4-argon-high"],
    ["antigravity", "gemini-4-argon"],
    ["google", "gemini-4-carbon"],
    ["google", "gemini-4-carbon-high"],
    ["commandcode", "google/gemini-4-carbon"],
    ["vertex", "gemini-4-argon-medium"],
  ])("bills %s %s at the real Gemini 4 rate ($2/$10)", (provider, model) => {
    const p = getPricingForModel(provider, model);
    expect(p).not.toBeNull();
    expect(p.input).toBe(2.0);
    expect(p.output).toBe(10.0);
  });

  it("leaves older gemini families untouched (no regression)", () => {
    expect(getPricingForModel("google", "gemini-2.5-pro").input).toBe(2.0);
    expect(getPricingForModel("google", "gemini-2.5-flash").input).toBe(0.30);
    expect(getPricingForModel("google", "gemini-3-flash").input).toBe(0.50);
    expect(getPricingForModel("antigravity", "gemini-3.8-flash").input).toBe(1.50);
  });
});
