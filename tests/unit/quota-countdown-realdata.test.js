// 额度卡头部与排序键在**真机形态**上必须同值（2026-11-25 用户报，CodeBuddy CN #2055）。
//
// 夹具是 NAS 实例 `/api/usage/{id}` 的原样返回（2026-11-26 取），三个面在这份数据上
// 各自给出过不同答案：
//   头部（QuotaPackBar soonestLive，先剔耗尽行）→ 「Bonus Pack 16」16d 后过期；
//   卡间排序（sortVisibleConnections，取所有未来 resetAt 的最小值）→ 「Bonus Pack 1」
//     9h——一个已烧完的一次性包，日期只是记录不是期限；
//   服务端列（earliestPackageExpiry）→ 「Bonus Pack 16」，与头部巧合一致但与卡上
//     明细首行「每月 0/500 · 数日后重置」无关。
// 统一后：头部与排序键同为 Monthly 的重置时刻，路由列刻意不变（见最后一条）。
import { describe, it, expect } from "vitest";
import { parseQuotaData, sortVisibleConnections } from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";
import { earliestQuotaCountdown } from "@/shared/utils/quotaRows.js";
import { extractEarliestPackageExpiry, extractDisplayPackageExpiry } from "open-sse/services/usage/expiryExtractor.js";

const NAS_CODEBUDDY_CN_2055 = {
  plan: "CodeBuddy",
  quotas: {
    "Total Points": { used: 3613.84, total: 4906, resetAt: null, unlimited: false, recurring: false },
    // 卡上逐包明细的第一行：红点（已耗尽）+ 4d 后重置。头部此前吞掉了它。
    Monthly: { used: 500, total: 500, resetAt: "2026-11-30T15:59:59.000Z", unlimited: false, recurring: true, giftPack: true },
    "Bonus Pack 1": { used: 1500, total: 1500, resetAt: "2026-11-26T10:00:27.000Z", unlimited: false, recurring: false },
    "Bonus Pack 2": { used: 100, total: 100, resetAt: "2026-11-27T03:23:13.000Z", unlimited: false, recurring: false },
    "Bonus Pack 3": { used: 300, total: 300, resetAt: "2026-11-27T03:33:24.000Z", unlimited: false, recurring: false },
    "Bonus Pack 4": { used: 100, total: 100, resetAt: "2026-11-27T17:59:17.000Z", unlimited: false, recurring: false },
    "Bonus Pack 5": { used: 100, total: 100, resetAt: "2026-11-29T02:42:11.000Z", unlimited: false, recurring: false },
    "Bonus Pack 6": { used: 100, total: 100, resetAt: "2026-11-29T19:05:27.000Z", unlimited: false, recurring: false },
    "Bonus Pack 7": { used: 100, total: 100, resetAt: "2026-12-04T02:11:45.000Z", unlimited: false, recurring: false },
    "Bonus Pack 8": { used: 100, total: 100, resetAt: "2026-12-05T03:07:12.000Z", unlimited: false, recurring: false },
    "Bonus Pack 9": { used: 100, total: 100, resetAt: "2026-12-06T09:42:57.000Z", unlimited: false, recurring: false },
    "Bonus Pack 10": { used: 100, total: 100, resetAt: "2026-12-06T16:07:12.000Z", unlimited: false, recurring: false },
    "Bonus Pack 11": { used: 100, total: 100, resetAt: "2026-12-07T16:16:52.000Z", unlimited: false, recurring: false },
    "Bonus Pack 12": { used: 100, total: 100, resetAt: "2026-12-08T17:37:11.000Z", unlimited: false, recurring: false },
    "Bonus Pack 13": { used: 100, total: 100, resetAt: "2026-12-09T17:05:24.000Z", unlimited: false, recurring: false },
    "Bonus Pack 14": { used: 100, total: 100, resetAt: "2026-12-10T16:24:09.000Z", unlimited: false, recurring: false },
    "Bonus Pack 15": { used: 100, total: 100, resetAt: "2026-12-11T16:42:03.000Z", unlimited: false, recurring: false },
    // 第一个仍有余额的包：卡上原先报的就是它。
    "Bonus Pack 16": { used: 13.83999837, total: 100, resetAt: "2026-12-12T16:07:15.000Z", unlimited: false, recurring: false },
    "Bonus Pack 17": { used: 0, total: 100, resetAt: "2026-12-13T16:24:33.000Z", unlimited: false, recurring: false },
    "Bonus Pack 18": { used: 0, total: 100, resetAt: "2026-12-14T16:56:25.000Z", unlimited: false, recurring: false },
    "Bonus Pack 19": { used: 0, total: 100, resetAt: "2026-12-15T16:09:20.000Z", unlimited: false, recurring: false },
    "Bonus Pack 20": { used: 0, total: 100, resetAt: "2026-12-16T17:40:19.000Z", unlimited: false, recurring: false },
    "Bonus Pack 21": { used: 0, total: 100, resetAt: "2026-12-17T16:11:54.000Z", unlimited: false, recurring: false },
    "Bonus Pack 22": { used: 0, total: 100, resetAt: "2026-12-18T17:15:45.000Z", unlimited: false, recurring: false },
    "Bonus Pack 23": { used: 0, total: 100, resetAt: "2026-12-19T16:04:34.000Z", unlimited: false, recurring: false },
    "Bonus Pack 24": { used: 0, total: 100, resetAt: "2026-12-20T17:43:53.000Z", unlimited: false, recurring: false },
    "Bonus Pack 25": { used: 0, total: 100, resetAt: "2026-12-21T18:00:59.000Z", unlimited: false, recurring: false },
    "Bonus Pack 26": { used: 0, total: 100, resetAt: "2026-12-22T16:50:26.000Z", unlimited: false, recurring: false },
    "Bonus Pack 27": { used: 0, total: 100, resetAt: "2026-12-23T16:08:06.000Z", unlimited: false, recurring: false },
    "Bonus Pack 28": { used: 0, total: 100, resetAt: "2026-12-24T16:28:02.000Z", unlimited: false, recurring: false },
    "Bonus Pack 29": { used: 0, total: 6, resetAt: "2027-11-13T18:28:15.000Z", unlimited: false, recurring: false },
  },
};

// 抓取时刻（NAS 快照的相对基准）。真实日期直接写死会在未来的某次运行里变成
// 「过去」让测试自己红掉，所以整表平移到「现在」：保持每个包之间的真实间隔，
// 又永远处于快照当天相对的位置上。
const CAPTURED_AT = Date.parse("2026-11-26T02:00:00.000Z");
const SHIFT = Date.now() - CAPTURED_AT;
const usage = {
  ...NAS_CODEBUDDY_CN_2055,
  quotas: Object.fromEntries(
    Object.entries(NAS_CODEBUDDY_CN_2055.quotas).map(([k, q]) => [
      k,
      { ...q, resetAt: q.resetAt ? new Date(Date.parse(q.resetAt) + SHIFT).toISOString() : null },
    ]),
  ),
};

const MONTHLY = Date.parse(usage.quotas.Monthly.resetAt);
const FIRST_LIVE_PACK = Date.parse(usage.quotas["Bonus Pack 16"].resetAt);

describe("真机形态：CodeBuddy CN 混合卡（耗尽月窗 + 耗尽包 + 满包）", () => {
  const rows = parseQuotaData("codebuddy-cn", usage);

  it("夹具形状：Monthly 是 recurring+giftPack 的耗尽周期窗", () => {
    const monthly = rows.find((r) => r.name === "Monthly");
    expect(monthly).toBeTruthy();
    expect(monthly.recurring).toBe(true);
    expect(monthly.giftPack).toBe(true);
    expect(monthly.used).toBe(monthly.total);
    // 「Total Points」由 parseQuotaData 原样保留（卡片另有筛选），但派生行永不
    // 赢得倒计时——它连日期都没有，即便有也被 isSummaryRow 剔除。
    const total = rows.find((r) => r.name === "Total Points");
    expect(total).toBeTruthy();
    expect(total.resetAt).toBe(null);
    expect(earliestQuotaCountdown([total])).toBe(null);
  });

  it("卡面头部取 Monthly 的重置时刻（而非 16d 后的首个满包）", () => {
    const head = earliestQuotaCountdown(rows);
    expect(head.row.name).toBe("Monthly");
    expect(head.time).toBe(MONTHLY);
    expect(head.resets).toBe(true); // 用词必须是「后重置」
    expect(head.raw).toBe(usage.quotas.Monthly.resetAt);
  });

  it("沙漏序的排序键与头部同值（此前它取 9h 后烧完的 Bonus Pack 1）", () => {
    const conns = [
      { id: "cb", provider: "codebuddy-cn", name: "#2055" },
      { id: "other", provider: "meoo", name: "M" },
    ];
    const otherRows = [{ name: "Weekly", used: 0, total: 100, resetAt: "2026-12-31T00:00:00.000Z", recurring: true }];
    const sorted = sortVisibleConnections(
      conns,
      { cb: { quotas: rows }, other: { quotas: otherRows } },
      true,
      "all",
      "default",
    );
    expect(sorted.map((c) => c.id)).toEqual(["cb", "other"]);
    // 同值断言：卡上写的时刻 == 墙用来排的时刻。
    expect(earliestQuotaCountdown(rows).time).toBe(MONTHLY);
  });

  it("已耗尽的一次性包不参与（BP1 9h 后到期不得成为排序键）", () => {
    const drained = rows.filter((r) => r.name === "Bonus Pack 1")[0];
    expect(drained.remainingNum ?? drained.total - drained.used).toBe(0);
    expect(earliestQuotaCountdown([drained])).toBe(null);
    expect(earliestQuotaCountdown(rows).time).toBeGreaterThan(
      Date.parse(usage.quotas["Bonus Pack 1"].resetAt),
    );
  });

  it("路由列刻意不变：耗尽的月赠包不得占位，仍取首个仍有余额的包", () => {
    const routing = extractEarliestPackageExpiry(usage);
    expect(routing.name).toBe("Bonus Pack 16");
    expect(Date.parse(routing.expiry)).toBe(FIRST_LIVE_PACK);
    // 展示口径才是 Monthly；两者并存，UI 读展示、relay 读路由。
    const display = extractDisplayPackageExpiry(usage);
    expect(display.name).toBe("Monthly");
    expect(Date.parse(display.expiry)).toBe(MONTHLY);
  });
});
