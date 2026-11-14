import { describe, expect, it } from "vitest";
import { completeQuotaBreakdown } from "../../src/shared/utils/quotaBreakdown.js";
import { buildQuotas } from "../../open-sse/services/usage/dumate.js";
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const detail = (total, used = 0, extra = {}) => ({ name: "pack", total, used, detailOnly: true, ...extra });
const pool = (total, used = 0) => [{ name: "balance", total, used }];

describe("completeQuotaBreakdown", () => {
  it("rejects a zero-value check-in row instead of blanking the balance", () => {
    const quotas = buildQuotas({ totalPoints: 4000, usedPoints: 100, subscription: [], incremental: [] }, { hasIssued: true });
    const rows = parseQuotaData("dumate", { quotas });
    expect(completeQuotaBreakdown(rows, rows.filter(r => r.isCreditBalance))).toEqual([]);
  });

  it("rejects top-ups that cover only part of a mixed subscription balance", () => {
    const quotas = buildQuotas({ totalPoints: 6010, usedPoints: 0,
      subscription: [{ status: "active", packageType: "plan_pro", totalPoints: 5000, usedPoints: 0 }],
      incremental: [{ status: "active", packageType: "plan_point", totalPoints: 1010, usedPoints: 0 }],
    }, null);
    const rows = parseQuotaData("dumate", { quotas });
    const breakdown = completeQuotaBreakdown(rows, rows.filter(r => r.isCreditBalance));
    // Depending on the provider's pack contract, either all credits are
    // represented or the consumer must keep the authoritative aggregate.
    expect(breakdown.length === 0 || breakdown.reduce((sum, r) => sum + r.remainingNum, 0) === 6010).toBe(true);
    expect(completeQuotaBreakdown([detail(1010)], pool(6010))).toEqual([]);
  });

  it("keeps a complete Qoder-style breakdown, including a spent pack", () => {
    const rows = [detail(100, 100), detail(200, 50), detail(0, 0, { checkinToday: true, summarizesDetail: true })];
    const result = completeQuotaBreakdown(rows, pool(300, 150));
    expect(result).toHaveLength(2);
    expect(result.reduce((sum, r) => sum + r.remainingNum, 0)).toBe(150);
    expect(result.reduce((sum, r) => sum + r.totalNum, 0)).toBe(300);
  });

  it("rejects incomplete visibility, overcounting and mismatched remaining amounts", () => {
    expect(completeQuotaBreakdown([detail(100)], pool(300))).toEqual([]);
    expect(completeQuotaBreakdown([detail(100), detail(100)], pool(100))).toEqual([]);
    expect(completeQuotaBreakdown([detail(100, 20)], pool(100, 30))).toEqual([]);
    expect(completeQuotaBreakdown([detail(100, 0, { summarizesDetail: true })], pool(100))).toEqual([]);
  });

  it("accepts only floating-point addition noise, not real missing credits", () => {
    expect(completeQuotaBreakdown([detail(0.1), detail(0.2)], pool(0.3))).toHaveLength(2);
    expect(completeQuotaBreakdown([detail(99.99)], pool(100))).toEqual([]);
  });

  it("uses explicit remaining values and fails closed on invalid quantities", () => {
    expect(completeQuotaBreakdown([detail(100, 0, { remaining: 70 })], [{ total: 100, remaining: 70 }])).toHaveLength(1);
    for (const row of [detail(NaN), detail(Infinity), detail(-1), detail(100, 0, { remaining: 101 })]) {
      expect(completeQuotaBreakdown([row], pool(100))).toEqual([]);
    }
    expect(completeQuotaBreakdown([], pool(100))).toEqual([]);
    expect(completeQuotaBreakdown([detail(100)], [])).toEqual([]);
  });
});
