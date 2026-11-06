// Loomy「每日赠送积分优先」调度 + 双槽配对识别（用户 2026-11-06 需求）：
// 每账号先烧每日赠送的 5000（不用即废），永久积分压到最后。
// 三层：balanceExtractor 识别 daily/permanent 配对；quotaRows 识别双槽卡；
// auth 排序分支的排序键语义（比较器逻辑在 auth 内联，这里用同规则复刻验证
// 键设计——真实排序由 auth 集成路径覆盖）。
import { describe, it, expect } from "vitest";
import { extractDailyGrantAndPermanent, extractConnectionBalance } from "../../open-sse/services/usage/balanceExtractor.js";
import { findDualSlotPair } from "../../src/shared/utils/quotaRows.js";

// loomy usage 的确切行形态（open-sse/services/usage/loomy.js）
const LOOMY_USAGE = {
  plan: "Loomy",
  quotas: {
    "永久积分": { isCreditBalance: true, used: 0, total: 16560, remainingPercentage: 100, resetAt: null, unlimited: true },
    "每日赠送积分": { recurring: true, used: 1000, total: 5000, resetAt: null },
  },
};

describe("loomy daily/permanent pair extraction", () => {
  it("extractDailyGrantAndPermanent 识别配对：每日剩余/总额 + 永久", () => {
    const pair = extractDailyGrantAndPermanent(LOOMY_USAGE);
    expect(pair).toEqual({ dailyRemaining: 4000, dailyTotal: 5000, permanent: 16560 });
  });

  it("每日耗尽（used=total）→ dailyRemaining 0，账号落入永久层", () => {
    const pair = extractDailyGrantAndPermanent({
      quotas: {
        "永久积分": { isCreditBalance: true, used: 0, total: 16560 },
        "每日赠送积分": { recurring: true, used: 5000, total: 5000 },
      },
    });
    expect(pair.dailyRemaining).toBe(0);
    expect(pair.permanent).toBe(16560);
  });

  it("非配对 provider（只有余额行）返回 null——调度分支自然不触发", () => {
    expect(extractDailyGrantAndPermanent({
      quotas: { "Balance (USD)": { used: 2, total: 14.95 } },
    })).toBeNull();
  });

  it("extractConnectionBalance 不受新函数影响（回归）", () => {
    // 永久积分行 isCreditBalance → 储值余额识别继续工作
    expect(extractConnectionBalance(LOOMY_USAGE)).toBe(16560);
  });
});

describe("dual-slot pair detection（双槽卡判定）", () => {
  const rows = [
    { name: "永久积分", isCreditBalance: true, used: 0, total: 16560, unlimited: true },
    { name: "每日赠送积分", recurring: true, used: 1000, total: 5000 },
  ];

  it("配对在场 → 返回永久 + 每日两行", () => {
    const pair = findDualSlotPair(rows);
    expect(pair.permanent.name).toBe("永久积分");
    expect(pair.daily.name).toBe("每日赠送积分");
  });

  it("缺每日行（纯储值账号）→ null，走通用池渲染", () => {
    expect(findDualSlotPair([rows[0]])).toBeNull();
  });

  it("缺永久行（只有每日）→ null", () => {
    expect(findDualSlotPair([rows[1]])).toBeNull();
  });
});

describe("dailyGrantFirst 排序键语义（auth 分支同规则）", () => {
  // auth.js 内联比较器的键设计：有每日剩余的账号组按剩余降序；耗尽的落永久
  // 升序；都缺的按 priority。这里复刻验证排序结果的形态。
  const rank = (accounts) =>
    [...accounts].sort((a, b) => {
      const da = typeof a.dailyGrantRemaining === "number" ? a.dailyGrantRemaining : null;
      const db = typeof b.dailyGrantRemaining === "number" ? b.dailyGrantRemaining : null;
      const hasA = da !== null && da > 0;
      const hasB = db !== null && db > 0;
      if (hasA && hasB && da !== db) return db - da;
      if (hasA !== hasB) return hasA ? -1 : 1;
      const pa = typeof a.permanentBalance === "number" ? a.permanentBalance : null;
      const pb = typeof b.permanentBalance === "number" ? b.permanentBalance : null;
      if (pa !== null && pb !== null && pa !== pb) return pa - pb;
      return (a.priority || 999) - (b.priority || 999);
    });

  it("有每日额度的账号按剩余降序排在最前", () => {
    const out = rank([
      { name: "A", dailyGrantRemaining: 1000, permanentBalance: 16560 },
      { name: "B", dailyGrantRemaining: 4999, permanentBalance: 17000 },
      { name: "C", dailyGrantRemaining: 0, permanentBalance: 100 },
    ]);
    expect(out.map((x) => x.name)).toEqual(["B", "A", "C"]);
  });

  it("每日耗尽的账号按永久积分升序殿后（先烧零头）", () => {
    const out = rank([
      { name: "A", dailyGrantRemaining: 0, permanentBalance: 16560 },
      { name: "C", dailyGrantRemaining: 0, permanentBalance: 100 },
      { name: "D", dailyGrantRemaining: 0, permanentBalance: 5000 },
    ]);
    expect(out.map((x) => x.name)).toEqual(["C", "D", "A"]);
  });

  it("无配对数据的账号按 priority 落在两组之间", () => {
    const out = rank([
      { name: "A", dailyGrantRemaining: 0, permanentBalance: 100, priority: 2 },
      { name: "B", dailyGrantRemaining: 4999, permanentBalance: 17000 },
      { name: "E", priority: 1 },
    ]);
    expect(out.map((x) => x.name)).toEqual(["B", "E", "A"]);
  });
});
