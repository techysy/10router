// Trae 两条线（CN = trae-cn.js，国际 = trae.js）的静态模型目录契约。
// 权威源 = 官方客户端模型下拉实拍（CN 四张 / INTL 五张，2026-11-27）。
// Trae **没有可用的模型目录端点**（INTL model_list 403 no schema found，#99 情报二；
// CN 侧无读取通道，CD 网关只暴露 POST /gateway/trae/v1/messages），所以本文件钉的是
// 「客户端公布的状态」，不是 live 实测结论 —— 与 codebuddy-cn-models.test.js 同一口径。
import { describe, expect, it } from "vitest";
import cn from "../../open-sse/providers/registry/trae-cn.js";
import intl from "../../open-sse/providers/registry/trae.js";

describe("Trae CN static model catalog", () => {
  it("lists exactly the models the CN client picker shows, in the client's order", () => {
    // 顺序 = 官方下拉自上而下（详情页照此渲染）。
    expect(cn.models.map((m) => m.id)).toEqual([
      "Doubao-Seed-2.1-Turbo",
      "Doubao-Seed-2.1-Pro",
      "Doubao-Seed-Evolving",
      "Doubao-Seed-Code",
      "glm-5.4",
      "glm-5.3-flash",
      "glm-5.3-flashx",
      "glm-5.3",
      "deepseek-v4.1-flash",
      "DeepSeek-V4-Pro-Official",
      "kimi-k3.1-pro-highspeed",
      "kimi-k3.1-pro",
      "kimi-k3",
      "mimo-v2.6-flash",
      "mimo-v2.6-pro",
      "minimax-m3.1-flash",
      "minimax-m3",
      "step-5-preview",
      "qwen4-max",
      "qwen3.8-flash",
      "qwen3.8-max",
    ]);
  });

  it("keeps the ids stable while the display names follow the client", () => {
    // 显示名去厂商前缀（官方就叫 Seed-2.1-Turbo），但 id 一律不动 —— 老 combo /
    // 连接引用靠 id（历史明确要求过）。
    const name = (id) => cn.models.find((m) => m.id === id)?.name;
    expect(name("Doubao-Seed-2.1-Turbo")).toBe("Seed-2.1-Turbo");
    expect(name("Doubao-Seed-2.1-Pro")).toBe("Seed-2.1-Pro-0915");
    expect(name("glm-5.4")).toBe("GLM-5.4");
    expect(name("kimi-k3.1-pro-highspeed")).toBe("Kimi-K3.1-Pro-Highspeed");
    expect(name("qwen4-max")).toBe("Qwen4-Max");
  });

  it("carries the client's published credit multiplier, and none on locked rows", () => {
    // 倍率 = 官方「积分消耗速度」。带锁行官方**不显示**倍率 → 一律不放
    // （不编价，与 codebuddy-intl 的 proOnly 行同法）。
    const rates = Object.fromEntries(cn.models.map((m) => [m.id, m.rateMultiplier]));
    expect(rates).toEqual({
      "Doubao-Seed-2.1-Turbo": 0.20,
      "Doubao-Seed-2.1-Pro": 0.80,
      "Doubao-Seed-Evolving": 0.80,
      "Doubao-Seed-Code": 0.06,
      "glm-5.4": undefined,
      "glm-5.3-flash": 0.08,
      "glm-5.3-flashx": 0.31,
      "glm-5.3": 0.78,
      "deepseek-v4.1-flash": 0.12,
      "DeepSeek-V4-Pro-Official": 0.72,
      "kimi-k3.1-pro-highspeed": undefined,
      "kimi-k3.1-pro": undefined,
      "kimi-k3": 1.83,
      "mimo-v2.6-flash": 0.06,
      "mimo-v2.6-pro": 0.15,
      "minimax-m3.1-flash": 0.09,
      "minimax-m3": 0.26,
      "step-5-preview": 0.48,
      "qwen4-max": undefined,
      "qwen3.8-flash": 0.08,
      "qwen3.8-max": 1.50,
    });
  });

  it("badges exactly the four rows the client shows with a lock as paidTier", () => {
    // 解锁说明原文：「该模型仅限 会员 Lite, 会员 Pro, 会员 Pro+, 会员 Ultra,
    // 会员 Express 用户，升级后即可解锁。」CN 档位含 Express（国际线没有）。
    expect(cn.models.filter((m) => m.paidTier).map((m) => m.id).sort()).toEqual([
      "glm-5.4", "kimi-k3.1-pro", "kimi-k3.1-pro-highspeed", "qwen4-max",
    ]);
  });

  it("states discount rules in discountNote, never as a free badge", () => {
    // 专属补贴 / 闲时折扣 都是**折扣型**（倍率非 0）：promoFree* / nightFree 会亮
    // green free 徽章 = 夸大，所以只能用 discountNote 承载规则说明。
    for (const id of ["Doubao-Seed-2.1-Turbo", "Doubao-Seed-Code", "deepseek-v4.1-flash", "DeepSeek-V4-Pro-Official"]) {
      const m = cn.models.find((x) => x.id === id);
      expect(m.promoFreeUntil).toBeUndefined();
      expect(m.nightFree).toBeUndefined();
      expect(m.discountNote).toBeTruthy();
    }
    // Seed-2.1-Turbo 侧栏把三档价都给全了（原价 / 当前补贴 / 会员专享）。
    const turbo = cn.models.find((m) => m.id === "Doubao-Seed-2.1-Turbo");
    expect(turbo.discountNote).toContain("0.40");
    expect(turbo.discountNote).toContain("0.20");
    expect(turbo.discountNote).toContain("0.10");
    // DeepSeek-V4-Pro：闲时窗是「每日 22:00-次日 8:00」，不是旧的「周一至周五忙时」
    // 口径（那是错的，已作废）；Max 开关=1M 上下文、更多消耗，也要说清。
    const dsPro = cn.models.find((m) => m.id === "DeepSeek-V4-Pro-Official");
    expect(dsPro.discountNote).toMatch(/22:00.*8:00/);
    expect(dsPro.discountNote).not.toMatch(/周一至周五/);
    expect(dsPro.discountNote).toMatch(/1M/);
    // V4.1-Flash 官方只挂「闲时折扣」标签、侧栏未拍 → 如实说幅度未知，不编折扣数。
    expect(cn.models.find((m) => m.id === "deepseek-v4.1-flash").discountNote).toMatch(/未公布/);
  });

  it("drops the expired 会员限时优惠 notes", () => {
    // 上一轮 glm-5.3 / deepseek-v4.1-flash 写着「生效至 11-16」，2026-11-27 已过期，
    // 且官方现状是 GLM-5.3 无标签、V4.1-Flash 挂闲时折扣。留过期日期 = 谎报。
    for (const m of cn.models) {
      expect(m.discountNote || "").not.toMatch(/11-16/);
    }
  });

  it("does not carry Kimi-K2.5 — that row belongs to the international picker", () => {
    // 判读陷阱：CN 第 3 张滚到底就是 Qwen3.8-Max + 「添加模型」，末尾没有 K2.5；
    // K2.5 只出现在国际线清单里。
    expect(cn.models.map((m) => m.id)).not.toContain("kimi-k2.5");
    expect(cn.models.map((m) => m.name)).not.toContain("Kimi-K2.5");
  });

  it("names the 0.12x row DeepSeek-V4.1-Flash, not V4.1-Hash", () => {
    // 低分辨率下 `Fl` 粘连看着像 `H`，第 4 张因此被读成「DeepSeek-V4.1-Hash」；
    // 第 1 张同位置写 Flash，且 Trae 全线（含国际线）都没有叫 Hash 的模型。
    const row = cn.models.find((m) => m.rateMultiplier === 0.12);
    expect(row.name).toBe("DeepSeek-V4.1-Flash");
    expect(cn.models.some((m) => /Hash/i.test(m.name || ""))).toBe(false);
  });
});

describe("Trae international static model catalog", () => {
  it("lists exactly the models the intl client picker shows, in the client's order", () => {
    expect(intl.models.map((m) => m.id)).toEqual([
      "auto",
      "Doubao-Seed-2.1-Turbo",
      "gpt-6.2-astra",
      "gpt-6.2-sol",
      "gpt-6.1-sol",
      "gpt-6.1-terra",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.2",
      "glm-5.2",
      "deepseek-v4.1-flash",
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "kimi-k3",
      "kimi-k2.7-code",
      "kimi-k2.5",
      "gemini-4-neon",
      "gemini-3.1-pro-preview",
      "gemini-3-flash-preview",
      "minimax-m3",
      "minimax-m2.7",
    ]);
  });

  it("leaves only Auto Mode and Doubao unlocked — free accounts get nothing else", () => {
    // 用户口径原话：「国际线：free 只有豆包可以用」。解锁说明原文「该模型仅限
    // Lite、Pro、Pro+、Ultra 用户使用」（国际线**没有** CN 的 Express 档）。
    const unlocked = intl.models.filter((m) => !m.paidTier).map((m) => m.id);
    expect(unlocked).toEqual(["auto", "Doubao-Seed-2.1-Turbo"]);
  });

  it("carries no multipliers, because intl publishes none", () => {
    // INTL pay 端点实测 404（套餐数据只在 dashboard 可见），无倍率可抄 → 不放。
    expect(intl.models.some((m) => typeof m.rateMultiplier === "number")).toBe(false);
  });

  it("keeps CN-only rows out of the international list", () => {
    // 两条线是各自独立的目录：CN 的 GLM-5.3 系 / Kimi-K3.1-Pro / Qwen 系不在国际
    // 客户端下拉里，反之国际线的 GPT/Gemini 家族不进 CN（同 codebuddy 的双向规则）。
    for (const id of ["glm-5.3", "glm-5.4", "kimi-k3.1-pro", "qwen4-max", "step-5-preview"]) {
      expect(intl.models.map((m) => m.id)).not.toContain(id);
    }
    for (const id of ["gpt-6.2-astra", "gpt-6.2-sol", "gpt-6-luna", "gemini-4-neon"]) {
      expect(intl.models.map((m) => m.id)).toContain(id);
      expect(cn.models.map((m) => m.id)).not.toContain(id);
    }
  });
});

describe("Trae executor wiring for the 2026-11-27 rows", () => {
  // 截图给的是客户端**显示名**，不是线上 ConfigName；新行一旦上游回 4001
  // config empty，必须按同族降档而不是直接失败（#109 既有机制）。
  it("maps the new CN ids to the family's capitalised ConfigName", async () => {
    const { canonicalTraeModel } = await import("../../open-sse/executors/trae.js");
    expect(canonicalTraeModel("glm-5.4")).toBe("GLM-5.4");
    expect(canonicalTraeModel("kimi-k3.1-pro-highspeed")).toBe("Kimi-K3.1-Pro-Highspeed");
    // qwen 系实证写法是小写原样透传（qwen3.8-flash / qwen3.8-max 同形）→ 不加映射。
    expect(canonicalTraeModel("qwen4-max")).toBe("qwen4-max");
  });

  it("degrades both new rows to a family name the catalog already knows", async () => {
    const { degradeTraeConfigName, canonicalTraeModel } = await import("../../open-sse/executors/trae.js");
    expect(degradeTraeConfigName("GLM-5.4")).toBe("GLM-5.3");
    expect(degradeTraeConfigName("Kimi-K3.1-Pro-Highspeed")).toBe("Kimi-K3.1-Pro");
    // 降级目标必须是目录已知名（否则降进未知名再 4001）。
    for (const to of ["GLM-5.3", "Kimi-K3.1-Pro"]) {
      expect(canonicalTraeModel(to.toLowerCase())).toBe(to);
    }
  });

  it("every CN catalog id resolves through the executor without throwing", async () => {
    const { canonicalTraeModel, isSoloAgentMode } = await import("../../open-sse/executors/trae.js");
    for (const m of cn.models) {
      expect(typeof canonicalTraeModel(m.id)).toBe("string");
      expect(canonicalTraeModel(m.id).length).toBeGreaterThan(0);
      // 豆包系仍归位 SOLO 沙箱（#109 As-Designed），其余走直连通道。
      expect(isSoloAgentMode(m.id)).toBe(m.id.startsWith("Doubao-"));
    }
  });
});

