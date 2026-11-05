import { describe, expect, it } from "vitest";
import entry from "../../open-sse/providers/registry/codebuddy-intl.js";
import cnEntry from "../../open-sse/providers/registry/codebuddy-cn.js";

// 2026-11-05（第三版）：以带徽章的客户端清单为准（用户截图）。
// 徽章语义：Free now = 限时免费窗口（每日赠送额度）；Pro Only = 仅 Pro 订阅
// 可用；无徽章 = 所有人可用。同日早先那版「无徽章网页版截图」（5.5/5.4/
// 5.3-Codex 等仍在）被这一版取代。
describe("CodeBuddy international static model catalog", () => {
  it("lists exactly the models the client publishes (2026-11-05 badged screenshot)", () => {
    expect(entry.models.map((model) => model.id)).toEqual([
      "auto",
      "hy4-preview",
      "hy3",
      "deepseek-v4.1-flash",
      "gpt-6-astra",
      "gpt-6.1-sol",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "grok-4.7",
      "gemini-3.8-flash",
      "glm-5.3",
      "glm-5.3-flash",
      "kimi-k3.1-pro",
      "kimi-k3.1-pro-highspeed",
      "kimi-k3",
      "minimax-m3.1-flash",
    ]);
  });

  it("carries the client's published credit multiplier on every model", () => {
    const rates = Object.fromEntries(entry.models.map((m) => [m.id, m.rateMultiplier]));
    expect(rates).toEqual({
      auto: 0.15,
      "hy4-preview": 0,
      hy3: 0,
      "deepseek-v4.1-flash": 0.11,
      "gpt-6-astra": 6.67,
      "gpt-6.1-sol": 1.33,
      "gpt-6-sol": 1.33,
      "gpt-6-luna": 0.07,
      "gpt-5.6-sol": 3.47,
      "gpt-5.6-terra": 1.39,
      "gpt-5.6-luna": 0.14,
      "grok-4.7": 1.90,
      "gemini-3.8-flash": 0.95,
      "glm-5.3": 0.69,
      "glm-5.3-flash": 0.08,
      "kimi-k3.1-pro": 0.97,
      "kimi-k3.1-pro-highspeed": 1.56,
      "kimi-k3": 1.62,
      "minimax-m3.1-flash": 0.08,
    });
  });

  it("marks the Free-now windows on Hy4/Hy3 with the daily-allowance note", () => {
    // 「Free now」是限时免费（每日赠送额度），不是永久 0 —— 原价 0 但窗口与
    // 口径必须可见。Hy4 窗口 Nov 4-15，Hy3 是 Jul 6 起至 Nov 15。
    for (const id of ["hy4-preview", "hy3"]) {
      const m = entry.models.find((x) => x.id === id);
      expect(m.promoFreeUntil).toBe("2026-11-15T00:00:00+08:00");
      expect(m.promoFreeNote).toMatch(/每日赠送/);
    }
  });

  it("flags the Pro-Only models", () => {
    const proOnly = entry.models.filter((m) => m.proOnly).map((m) => m.id);
    expect(proOnly).toEqual([
      "gpt-6-astra",
      "gpt-6.1-sol",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "grok-4.7",
      "gemini-3.8-flash",
      "kimi-k3.1-pro",
      "kimi-k3.1-pro-highspeed",
    ]);
    // 无徽章模型不得带 proOnly。
    for (const id of ["auto", "hy4-preview", "hy3", "deepseek-v4.1-flash", "glm-5.3", "glm-5.3-flash", "kimi-k3", "minimax-m3.1-flash"]) {
      expect(entry.models.find((m) => m.id === id).proOnly).toBeUndefined();
    }
  });

  it("gpt-6.1-sol finally has a published multiplier (was blank through 10-08)", () => {
    // 2026-10-08 那批 6.x 行因「积分页无数字、禁推算」而留空；本版客户端
    // 直接给出 1.33 —— 推算禁令解除，但只允许用页面值，仍不许从别的行推导。
    expect(entry.models.find((m) => m.id === "gpt-6.1-sol").rateMultiplier).toBe(1.33);
  });

  it("does not carry ids the client dropped", () => {
    const ids = entry.models.map((model) => model.id);
    for (const retired of [
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.3-codex",
      "gemini-3.5-flash",
      "glm-5.2",
      "glm-5.1",
      "kimi-k2.6",
      "kimi-k2.7",
      "kimi-k2.8-preview",
      "minimax-m3",
      "space-bunny",
      "glm-5v-turbo",
      "claude-opus-5.5",
      "claude-sonnet-4.6",
    ]) {
      expect(ids, retired).not.toContain(retired);
    }
  });

  it("records the agent presets as reference data, never as model rows", () => {
    const byId = Object.fromEntries(entry.models.map((model) => [model.id, model]));
    for (const preset of ["fast", "balanced", "primary", "deep"]) {
      expect(byId[preset]).toBeUndefined();
    }
    // `auto` 在本版清单里是真实模型行（自动 0.15x），不再是纯预设档；
    // 其余预设档仍只作倍率参考。
    expect(byId["auto"]).toBeDefined();
    expect(entry.presets.map((p) => p.id)).toEqual(["auto", "fast", "balanced", "primary"]);
  });

  it("treats CN and intl as fully independent catalogs and rate cards", () => {
    // 用户 2026-11-05 两次确认。glm-5.3 本版两侧同步到 0.69 属巧合级别的一致
    // （各自独立调价后暂同值），不构成「必须一致」的依据。
    const cnById = Object.fromEntries(cnEntry.models.map((model) => [model.id, model]));
    expect(entry.models.find((m) => m.id === "glm-5.3").rateMultiplier).toBe(0.69);
    expect(cnById["glm-5.3"].rateMultiplier).toBe(0.69);
    // hy3：intl 永久免费口径（0 + Free now 窗口），CN 是 0.05 原价 + 同期窗口。
    expect(entry.models.find((m) => m.id === "hy3").rateMultiplier).toBe(0);
    expect(cnById.hy3.rateMultiplier).toBe(0.05);
  });
});
