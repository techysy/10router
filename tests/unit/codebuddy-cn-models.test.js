import { describe, expect, it } from "vitest";
import cn from "../../open-sse/providers/registry/codebuddy-cn.js";
import intl from "../../open-sse/providers/registry/codebuddy-intl.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

// Models CodeBuddy *international* (codebuddy.ai) resells. copilot.tencent.com
// never published them, and open-sse/providers/capabilities.js has no
// "codebuddy-cn" entry for any of them. They were once copied into the CN
// registry by mistake (53c255b7) — keep them out.
const INTL_ONLY_FAMILY = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.3-codex",
  "gemini-3.5-flash",
];

describe("CodeBuddy CN static model catalog", () => {
  it("lists exactly the models copilot.tencent.com publishes", () => {
    expect(cn.models.map((model) => model.id)).toEqual([
      "hy4-preview",
      "hy3",
      "glm-5v-turbo",
      "glm-5.3",
      "glm-5.3-flash",
      "glm-5.2",
      "glm-5.1",
      "minimax-m3",
      "kimi-k3",
      "kimi-k2.7",
      "kimi-k2.6",
      "deepseek-v4.1-flash",
      "deepseek-v4-pro",
    ]);
  });

  it("carries the published credit multiplier on every model", () => {
    // Rate card published by the CN credit page. 0 = rides the free quota.
    const rates = Object.fromEntries(cn.models.map((m) => [m.id, m.rateMultiplier]));
    expect(rates).toEqual({
      "hy4-preview": 0,
      hy3: 0,
      "glm-5v-turbo": 0.71,
      "glm-5.3": 0.79,
      "glm-5.3-flash": 0.06,
      "glm-5.2": 0.79,
      "glm-5.1": 0.79,
      "minimax-m3": 0.25,
      "kimi-k3": 1.62,
      "kimi-k2.7": 0.57,
      "kimi-k2.6": 0.52,
      "deepseek-v4.1-flash": 0.03,
      "deepseek-v4-pro": 0.51,
    });
  });

  it("shares the credit rate with intl on models both gateways serve", () => {
    const intlRates = Object.fromEntries(intl.models.map((m) => [m.id, m.rateMultiplier]));
    for (const m of cn.models) {
      if (m.id in intlRates) expect(m.rateMultiplier).toBe(intlRates[m.id]);
    }
  });

  it("does not carry the intl-only GPT/Gemini family", () => {
    const cnIds = cn.models.map((model) => model.id);
    const intlIds = intl.models.map((model) => model.id);
    for (const id of INTL_ONLY_FAMILY) {
      expect(cnIds).not.toContain(id);
      expect(intlIds).toContain(id);
    }
  });

  it("does not carry retired or spurious ids", () => {
    const ids = cn.models.map((model) => model.id);
    // kimi-k3-1 was a spurious duplicate slot; deepseek-v4-flash is superseded
    // by deepseek-v4.1-flash.
    expect(ids).not.toContain("kimi-k3-1");
    expect(ids).not.toContain("deepseek-v4-flash");
  });

  it("carries DeepSeek-V4.1-Flash's published capabilities", () => {
    // Model card for V4.1-Flash: 1M in / 384K out, text+image in, reasoning on
    // by default but switchable (High default, plus a normal/no-thinking mode).
    // The 384K ceiling matters: claude.js adjustMaxTokens clamps max_tokens to
    // caps.maxOutput, so the old 50000 cut client requests down 7x.
    expect(getCapabilitiesForModel("codebuddy-cn", "deepseek-v4.1-flash")).toMatchObject({
      vision: true,
      reasoning: true,
      thinkingFormat: "openai",
      thinkingCanDisable: true,
      contextWindow: 1000000,
      maxOutput: 384000,
    });
  });

  it("resolves the V4.1-Flash alias ids to the same caps", () => {
    // deepseek-v4-flash / deepseek-v4-flash-vision-exp are aliases of the same
    // model (compatible routes for the retired V4-Flash ids). Without their own
    // rows they fall through to the *deepseek-v4* pattern and lose vision.
    const canonical = getCapabilitiesForModel("codebuddy-cn", "deepseek-v4.1-flash");
    for (const alias of ["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]) {
      expect(getCapabilitiesForModel("codebuddy-cn", alias)).toEqual(canonical);
    }
  });
});
