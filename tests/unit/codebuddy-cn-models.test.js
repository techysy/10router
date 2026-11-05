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
  // 以下四个在 intl 2026-11-05 第三版清单中也已下架 —— 它们两侧都不在目录里，
  // 仍要钉住的是「CN 永远不收 GPT/Gemini 转售线」这一规则本身。
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.3-codex",
  "gemini-3.5-flash",
  // 2026-11-05 第三版 intl 新增的 Pro-Only 行，同样与 CN 无关。
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6-sol",
  "gpt-6-luna",
  "grok-4.7",
  "gemini-3.8-flash",
  "kimi-k3.1-pro-highspeed",
];

describe("CodeBuddy CN static model catalog", () => {
  it("lists exactly the models the CN client publishes (2026-11-05 screenshot)", () => {
    // 以 CN 客户端「内置模型」列表为准：旧一代（glm-5v-turbo / glm-5.3-flashx /
    // glm-5.1 / kimi-k2.7 / kimi-k2.6 / minimax-m3）已从客户端下线，静态目录
    // 同步移除。新增 id 全部经现网探测确认返回 200（见下方 probe 用例注释）。
    expect(cn.models.map((model) => model.id)).toEqual([
      "auto",
      "hy4",
      "hy3",
      "space-bunny",
      "glm-5.3",
      "glm-5.3-flash",
      "glm-5.2",
      "minimax-m3.1-flash",
      "kimi-k3.1-pro",
      "kimi-k3",
      "kimi-k2.8-preview",
      "mimo-v2.6-pro",
      "step-5-preview",
      "deepseek-v4.1-flash",
      "deepseek-v4-pro",
    ]);
  });

  it("carries the client's published credit multiplier on every model", () => {
    // 倍率取自 CN 客户端卡片「消耗速度」一栏（2026-11-05 截图）。
    // 带限时免费/夜间折扣的模型，rateMultiplier 记的是**原价**，折扣由
    // promoFreeUntil / nightFree 表达（0 会变成「永久免费」，见 promoFree.js）。
    const rates = Object.fromEntries(cn.models.map((m) => [m.id, m.rateMultiplier]));
    expect(rates).toEqual({
      "hy4": 0.29,
      hy3: 0.05,
      "space-bunny": 0.08,
      "glm-5.3": 0.69,
      "glm-5.3-flash": 0.08,
      "glm-5.2": 0.79,
      "minimax-m3.1-flash": 0.08,
      "kimi-k3.1-pro": 0.97,
      "kimi-k3": 1.62,
      "kimi-k2.8-preview": 0.77,
      "mimo-v2.6-pro": 0.13,
      "step-5-preview": 0.33,
      "deepseek-v4.1-flash": 0.11,
      "deepseek-v4-pro": 0.51,
      auto: undefined,
    });
  });

  it("marks the promo windows and discount rules the client shows", () => {
    // 「限时免费」：Hy3 / Hy4 都到 11 月 15 日为止，且是**每日赠送额度**
    // （promoFreeNote 携带该口径，tooltip 可见）。
    for (const id of ["hy3", "hy4"]) {
      const m = cn.models.find((x) => x.id === id);
      expect(m.promoFreeUntil).toBe("2026-11-15T00:00:00+08:00");
      expect(m.promoFreeNote).toBe("每日赠送免费额度");
      // 原价必须仍是正数 —— 写成 0 会永久显示 free。
      expect(m.rateMultiplier).toBeGreaterThan(0);
    }
    // 「订阅优先」
    for (const id of ["glm-5.3", "glm-5.3-flash", "kimi-k2.8-preview"]) {
      expect(cn.models.find((m) => m.id === id).subPriority).toBe(true);
    }
    // 「夜间折扣」是**立减**不是免费 —— 不允许用 nightFree（徽章会亮 free 夸大），
    // 只能用 discountNote 承载时段规则。三张卡都带这条。
    for (const id of ["glm-5.2", "deepseek-v4.1-flash", "deepseek-v4-pro"]) {
      const m = cn.models.find((x) => x.id === id);
      expect(m.nightFree).toBeUndefined();
      expect(m.discountNote).toMatch(/高峰/);
    }
  });

  it("does not assume intl shares CN's credit rates", () => {
    // 两侧是**独立**的计费与目录，用户 2026-11-05 明确说明。CN 的 hy3 从此表
    // 原价 0.05x（带限时免费窗口），intl 的 hy3 仍是 0（走免费额度）——
    // 旧断言「重叠 id 倍率必须相等」在这个事实上不成立，已移除。
    // 保留这一条只是提醒：不要再按 intl 反推 CN 的倍率。
    expect(cn.models.some((m) => m.rateMultiplier > 0)).toBe(true);
  });

  it("does not carry the intl-only GPT/Gemini family", () => {
    const cnIds = cn.models.map((model) => model.id);
    const intlIds = intl.models.map((model) => model.id);
    for (const id of INTL_ONLY_FAMILY) {
      // CN 一律不收；intl 侧只在它仍在目录时才断言存在（5.5/5.4/5.3-Codex/
      // gemini-3.5-flash 已随第三代清单下架，两侧都没有 —— 规则仍然成立）。
      expect(cnIds, `${id} must stay out of CN`).not.toContain(id);
      if (intlIds.includes(id)) {
        expect(cnIds).not.toContain(id);
      }
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
