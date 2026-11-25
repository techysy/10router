// Antigravity 账号烧穿（用户口中的「小黑屋」）：7 个模型全部 1000/1000、
// remainingPercentage 0。卡片此前的问题：
//   1. image/other 行 recurring 标 false（上游不回该字段），被当成一次性
//      资源包入池，聚合头条显示 0/1,000；
//   2. 池子全耗尽时 QuotaPackBar 的 meta 行直接 return null —— 卡片以裸
//      「0 / 1,000」空条收尾，看起来像数据异常（2026-11-06 用户报告）。
// 修复：行带 recycles:true（resetAt 到点回血），QuotaPackBar 耗尽分支据此
// 渲染「N 个资源包已耗尽 + 重置倒计时」。本测试钉住行构造与分类两端的判定。
import { describe, it, expect } from "vitest";
import { parseQuotaData } from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";
import { joinsPackPool, isRecurringQuotaRow } from "@/shared/utils/quotaRows.js";

// 2026-11-06 NAS 实测 payload（谷歌#i，全模型烧穿态）的形状与数值。
const DEPLETED = {
  plan: "Antigravity",
  quotas: {
    "gpt-oss-120b-medium": { used: 1000, total: 1000, resetAt: "2026-11-08T18:15:47.000Z", remainingPercentage: 0, displayName: "GPT-OSS 120B (Medium)" },
    "claude-sonnet-4-6": { used: 1000, total: 1000, resetAt: "2026-11-08T18:15:47.000Z", remainingPercentage: 0, displayName: "Claude Sonnet 4.6 (Thinking)" },
    "claude-opus-4-6-thinking": { used: 1000, total: 1000, resetAt: "2026-11-08T18:15:47.000Z", remainingPercentage: 0, displayName: "Claude Opus 4.6 (Thinking)" },
    "gemini-3.8-flash-medium": { used: 1000, total: 1000, resetAt: "2026-11-09T09:25:47.000Z", remainingPercentage: 0, displayName: "Gemini 3.8 Flash (Medium)" },
    "gemini-3.8-flash-high": { used: 1000, total: 1000, resetAt: "2026-11-09T09:25:47.000Z", remainingPercentage: 0, displayName: "Gemini 3.8 Flash (High)" },
    "gemini-3.8-flash-low": { used: 1000, total: 1000, resetAt: "2026-11-09T09:25:47.000Z", remainingPercentage: 0, displayName: "Gemini 3.8 Flash (Low)" },
    "gemini-3.1-flash-image": { used: 1000, total: 1000, resetAt: "2026-11-09T09:25:47.000Z", remainingPercentage: 0, displayName: "Gemini 3.1 Flash Image" },
  },
  subscriptionInfo: null,
};

describe("antigravity depleted pool meta（#小黑屋卡裸 0/1,000）", () => {
  const rows = parseQuotaData("antigravity", DEPLETED);

  it("仍产出 3 行（两个家族行 + Image），数据不因烧穿而丢失", () => {
    expect(rows).toHaveLength(3);
    // 行序随 payload 的 Object.entries 序（image 的位置不固定），只断集合。
    // （sort 按字符码：'(' < '3'，"(Flash / Pro)" 在 "3.1" 前。）
    expect([...rows.map((r) => r.name)].sort()).toEqual([
      "Claude (Sonnet / Opus / GPT)",
      "Gemini (Flash / Pro)",
      "Gemini 3.1 Flash Image",
    ]);
    for (const r of rows) {
      expect(r.remainingPercentage).toBe(0);
      expect(r.used).toBe(r.total);
    }
  });

  it("带 resetAt 的 image 行标 recycles:true（窗口回血，非一次性烧断）", () => {
    const image = rows.find((r) => r.name === "Gemini 3.1 Flash Image");
    expect(image.recycles).toBe(true);
    expect(image.resetAt).toBeTruthy();
    // 入池判定：recurring:false 的行靠 recycles 仍是池成员，
    // QuotaPackBar 的耗尽 meta 行靠这个标记渲染重置倒计时。
    expect(joinsPackPool(image)).toBe(true);
  });

  it("无 resetAt 的行不标 recycles（真一次性包保持静默耗尽语义）", () => {
    const noReset = parseQuotaData("antigravity", {
      quotas: { "gemini-3.1-flash-image": { used: 1000, total: 1000, remainingPercentage: 0, resetAt: null, displayName: "Gemini 3.1 Flash Image" } },
    });
    expect(noReset[0].recycles).toBeUndefined();
  });

  it("家族行保持 recurring:true（滚动窗口语义，走 cycle 行渲染）", () => {
    for (const name of ["Gemini (Flash / Pro)", "Claude (Sonnet / Opus / GPT)"]) {
      const row = rows.find((r) => r.name === name);
      expect(row.recurring).toBe(true);
      expect(isRecurringQuotaRow(row)).toBe(true);
      // cycle 行不入积分池 —— 聚合头条只数 image 这一项。
      expect(joinsPackPool(row)).toBe(false);
    }
  });

  it("健康态同样带 recycles（标记描述的是窗口性质，不是耗尽状态）", () => {
    const healthy = parseQuotaData("antigravity", {
      quotas: { "gemini-3.1-flash-image": { used: 100, total: 1000, remainingPercentage: 90, resetAt: "2026-11-09T09:25:47.000Z", displayName: "Gemini 3.1 Flash Image" } },
    });
    expect(healthy[0].recycles).toBe(true);
  });
});
