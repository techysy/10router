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
    // hy4-preview is the NIGHT-ONLY exception (23:00–08:00 local free, user-
    // verified 2026-09-13): daytime bills at 0.29x (user-provided), the badge
    // flips free/0.29x by `nightFree` instead of showing a misleading 0x.
    const rates = Object.fromEntries(cn.models.map((m) => [m.id, m.rateMultiplier]));
    expect(rates).toEqual({
      "hy4-preview": 0.29,
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
    // The night-free window itself, pinned (intl hy4 is free ALL DAY — separate).
    const hy4 = cn.models.find((m) => m.id === "hy4-preview");
    expect(hy4.nightFree).toEqual({ from: 23, to: 8 });
  });

  it("shares the credit rate with intl on models both gateways serve", () => {
    const intlRates = Object.fromEntries(intl.models.map((m) => [m.id, m.rateMultiplier]));
    for (const m of cn.models) {
      // hy4-preview is deliberately EXCLUDED: free-all-day on intl, night-only
      // free on CN — the multipliers diverged (user-verified 2026-09-13).
      if (m.id === "hy4-preview") continue;
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
    // The output ceiling is the server's 128000, not the model card's 384K: this
    // is the CN channel, whose product-config payload publishes maxOutputTokens
    // and whose gateway enforces it. maxOutput is a real clamp (claude.js
    // adjustMaxTokens), so over-declaring it would pass oversized max_tokens
    // straight through. The canonical row keeps 384K for direct/reseller ids.
    expect(getCapabilitiesForModel("codebuddy-cn", "deepseek-v4.1-flash")).toMatchObject({
      vision: true,
      reasoning: true,
      thinkingFormat: "openai",
      thinkingCanDisable: true,
      contextWindow: 1000000,
      maxOutput: 128000,
    });
  });

  it("carries DeepSeek-V4-Pro's published capabilities (pure text)", () => {
    // The V4.1-Flash model card describes V4-Pro as text→text, and models.dev
    // agrees across every one of its 124 deepseek-v4-pro entries (attach:false),
    // as does Ark's first-party deepseek-v4-pro-ga-260813. The row used to say
    // vision:true — that let images skip the modality strip and reach an upstream
    // that cannot read them — with a 50000 output ceiling inherited from the
    // pre-rename id, which clamped max_tokens 7x (claude.js adjustMaxTokens).
    expect(getCapabilitiesForModel("codebuddy-cn", "deepseek-v4-pro")).toMatchObject({
      vision: false,
      reasoning: true,
      thinkingFormat: "openai",
      contextWindow: 1000000,
      maxOutput: 384000,
    });
  });

  it("leaves no row for the retired V4-Flash ids", () => {
    // deepseek-v4-flash is a *different* (text-only) model, not an alias of
    // V4.1-Flash: it is no longer offered here, so the table must not carry a
    // row for it — the generic *deepseek-v4* pattern already resolves it as
    // pure text at 1M / 384K. The multimodal sibling lives in MODEL_CAPABILITIES
    // (five providers share that id, see deepseek-v4-capabilities.test.js).
    expect(getCapabilitiesForModel("codebuddy-cn", "deepseek-v4-flash")).toMatchObject({
      vision: false,
      contextWindow: 1000000,
      maxOutput: 384000,
    });
    expect(getCapabilitiesForModel("codebuddy-cn", "deepseek-v4-flash-vision-exp").vision).toBe(true);
  });
});
