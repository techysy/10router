// 额度卡「最早到期/重置」口径统一与健壮化（2026-11-25 用户报：沙漏序把「每月 5d
// 后重置」的号排在 17d 的号后面，而卡上头部写着 17d——头部与排序键打架）。
//
// 根因是同一个问题被三个面各自实现：卡片头部（QuotaPackBar soonestLive，先剔除
// 耗尽行）、卡间排序（sortVisibleConnections，取所有未来 resetAt 的最小值）、
// 服务端持久化列（extractEarliestPackageExpiry，又一套）。本文件钉的是**统一后**
// 的契约：一套规则、一份实现、三面同值，以及历史上真踩过的边界。
//
// 实现分两层：
//   open-sse/utils/quotaTiming.js —— 时间/数值语义（relay 与 UI 共用，杜绝漂移）
//   src/shared/utils/quotaRows.js —— 展示口径的具名规则（COUNTDOWN_DISPLAY_RULES）
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as quotaRowsModule from "../../src/shared/utils/quotaRows.js";
import { COUNTDOWN_DISPLAY_RULES, countdownRefills, earliestQuotaCountdown } from "../../src/shared/utils/quotaRows.js";
import {
  drivesEarliestExpiry,
  hasLiveRemaining,
  isPerpetualBucket,
  quotaCountdownAt,
  quotaCountdownFromRaw,
  quotaDeadlineTime,
  refillsWhenDrained,
} from "../../open-sse/utils/quotaTiming.js";
import {
  extractDisplayPackageExpiry,
  extractEarliestPackageExpiry,
} from "../../open-sse/services/usage/expiryExtractor.js";
import {
  parseQuotaData,
  sortVisibleConnections,
} from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
// 夹具日期一律相对 now 生成：固定日期在未来的某次运行里会变成「过去」，测试会
// 自己红掉。
const iso = (msAhead) => new Date(Date.now() + msAhead).toISOString();

// ─── 1. 时间原语：什么算一个可倒计期的期限 ──────────────────────────────────
describe("quotaCountdownAt / FromRaw — 日期边界", () => {
  it("缺失、空串、非法串一律不算期限（NaN 一旦漏进 Math.min 会毒化整表）", () => {
    const now = Date.now();
    for (const raw of [null, undefined, "", "garbage", "not-a-date", 0, false]) {
      expect(quotaCountdownFromRaw(raw, now)).toBe(null);
    }
    for (const row of [{}, { resetAt: "" }, { resetAt: "garbage" }, { resetAt: null }]) {
      expect(quotaCountdownAt(row, now)).toBe(null);
    }
  });

  it("年份 >2099 的哨兵（codebuddy/grok 写 9999 表示永久）不是期限", () => {
    const now = Date.now();
    expect(quotaCountdownFromRaw("9999-12-31T00:00:00.000Z", now)).toBe(null);
    expect(quotaCountdownFromRaw(new Date(now + 400 * 365 * DAY).toISOString(), now)).toBe(null);
    // 2099 年内仍是真期限，别把守卫写成一刀切的年份上限以下全收。
    expect(quotaCountdownFromRaw("2099-01-01T00:00:00.000Z", now)).not.toBe(null);
  });

  it("过去的时间=窗口已回血，不得当「最早到期」参与（2026-11-24 已过期号排最前）", () => {
    const now = Date.now();
    expect(quotaCountdownFromRaw(new Date(now - 1000).toISOString(), now)).toBe(null);
    expect(quotaCountdownFromRaw(new Date(now - 30 * DAY).toISOString(), now)).toBe(null);
    // 恰好等于 now 也不可参与：比较器要求严格未来，否则「0s 后到期」会插队。
    expect(quotaCountdownFromRaw(new Date(now).toISOString(), now)).toBe(null);
  });

  it("接受 Date 实例与 ISO 串两种形状（包用 expiresAt、桶用 resetAt）", () => {
    const now = Date.now();
    const d = new Date(now + DAY);
    expect(quotaCountdownAt({ expiresAt: d }, now)).toBe(d.getTime());
    expect(quotaCountdownAt({ resetAt: d.toISOString() }, now)).toBe(d.getTime());
    // 桶优先：两样都有时读 resetAt（与提取器一致）。
    expect(quotaCountdownAt({ resetAt: iso(DAY), expiresAt: iso(10 * DAY) }, now)).toBeCloseTo(
      Date.now() + DAY,
      -3,
    );
  });

  it("quotaDeadlineTime 与 quotaCountdownFromRaw 的分工：有日期 vs 日期仍在前方", () => {
    const now = Date.now();
    const past = new Date(now - DAY).toISOString();
    // 昨天到期的包是「已烧掉的包」，不是「没有期限的余额」——deadline 口径必须仍然
    // 报出那个过去的时刻，否则死包会被当成储值池（两者被下游按不同理由剔除）。
    expect(quotaDeadlineTime(past)).toBeLessThan(now);
    expect(quotaCountdownFromRaw(past, now)).toBe(null);
    expect(quotaDeadlineTime("garbage")).toBe(null);
    expect(quotaDeadlineTime(null)).toBe(null);
    expect(quotaDeadlineTime(new Date(now + DAY))).toBeGreaterThan(now);
    // 哨兵在 deadline 口径下是「永久」（= 余额），这正是 isPerpetualBucket 要的。
    expect(quotaDeadlineTime("9999-12-31T00:00:00.000Z")).toBe(null);
    expect(isPerpetualBucket({ resetAt: "9999-12-31T00:00:00.000Z" })).toBe(true);
    expect(isPerpetualBucket({ resetAt: past })).toBe(false);
  });

  it("isPerpetualBucket：储值余额与无日期行是余额，不是窗口", () => {
    expect(isPerpetualBucket({ isCreditBalance: true, resetAt: iso(DAY) })).toBe(true);
    expect(isPerpetualBucket({ total: 100 })).toBe(true);
    expect(isPerpetualBucket({ resetAt: iso(DAY) })).toBe(false);
  });
});

// ─── 2. 候选规则：哪些行有权决定「最早」 ────────────────────────────────────
describe("drivesEarliestExpiry / earliestQuotaCountdown — 候选口径", () => {
  it("有余额的行只要日期在未来就参与，其余形态一律不参与", () => {
    const now = Date.now();
    const live = { name: "Bonus Pack 1", used: 10, total: 100, resetAt: iso(3 * DAY), recurring: false };
    expect(drivesEarliestExpiry(live, { now })).toBe(true);
    expect(earliestQuotaCountdown([live], { now })?.time).toBeGreaterThan(now);
  });

  it("已耗尽的一次性包不参与：0 积分包剩下的日期是记录不是期限（146a065a0）", () => {
    const now = Date.now();
    const drained = { name: "赠送包 16", used: 100, total: 100, remaining: 0, resetAt: iso(2 * DAY), recurring: false };
    expect(drivesEarliestExpiry(drained, { now })).toBe(false);
    expect(earliestQuotaCountdown([drained], { now })).toBe(null);
  });

  it("耗尽但会回血周期窗必须参与——recurring:true 与 recycles:true 两种拼法", () => {
    const now = Date.now();
    const weekly = { name: "Weekly", used: 100, total: 100, remainingPercentage: 0, resetAt: iso(2 * DAY), recurring: true };
    // antigravity 的逐模型行：上游不回 recurring，normalizer 标 recycles。
    const recycled = { name: "Gemini 3.1 Flash Image", used: 1000, total: 1000, remainingPercentage: 0, resetAt: iso(6 * HOUR), recurring: false, recycles: true };
    expect(refillsWhenDrained(weekly)).toBe(true);
    expect(refillsWhenDrained(recycled)).toBe(true);
    expect(drivesEarliestExpiry(weekly, { now })).toBe(true);
    expect(drivesEarliestExpiry(recycled, { now })).toBe(true);
  });

  it("`recycles:true` 压过 `recurring:false`——否则烧穿账号会掉回裸 0/1,000 卡（2026-11-06 报）", () => {
    const now = Date.now();
    const burned = {
      name: "Gemini 3.8 Flash (Low)", used: 1000, total: 1000, remainingPercentage: 0,
      resetAt: iso(9 * HOUR), recurring: false, recycles: true, percentScale: true,
    };
    expect(drivesEarliestExpiry(burned, { now })).toBe(true);
    const best = earliestQuotaCountdown([burned], { now });
    expect(best?.time).toBeGreaterThan(now);
    // 用词必须是「重置」：这批积分会回来，不是永久没了。
    expect(best?.resets).toBe(true);
    expect(countdownRefills(burned)).toBe(true);
  });

  it("recurring:false 显式旗标压过周期名（说 Monthly 但其实是会死的包）", () => {
    const now = Date.now();
    const dying = { name: "Monthly", used: 100, total: 100, remaining: 0, resetAt: iso(5 * DAY), recurring: false };
    expect(refillsWhenDrained(dying, { nameInferredCycles: (r) => /month/i.test(r.name) })).toBe(false);
    expect(drivesEarliestExpiry(dying, { now })).toBe(false);
  });

  it("unlimited / 储值余额 / 派生汇总行不参与", () => {
    const now = Date.now();
    const unlimited = { name: "Unlimited window", used: 0, total: 0, unlimited: true, resetAt: iso(DAY), recurring: true };
    const voucher = { name: "代金券(CNY)", used: 0, total: 14.95, remaining: 14.95, isCreditBalance: true, resetAt: iso(DAY) };
    const total = { name: "Total Points", used: 15, total: 600, resetAt: iso(DAY) };
    const restating = { name: "Resource Package", total: 900, used: 875, remaining: 25, summarizesDetail: true, resetAt: iso(DAY) };
    expect(earliestQuotaCountdown([unlimited], { now })).toBe(null);
    expect(earliestQuotaCountdown([voucher], { now })).toBe(null);
    expect(earliestQuotaCountdown([total], { now })).toBe(null);
    expect(earliestQuotaCountdown([restating], { now })).toBe(null);
    // 路由侧同样不吃余额与哨兵（它一直在剥，本测试钉的是别再退化）。
    expect(drivesEarliestExpiry(voucher, { now })).toBe(false);
    expect(drivesEarliestExpiry({ isCreditBalance: true, resetAt: iso(DAY) }, { now })).toBe(false);
  });

  it("展示口径计入耗尽的周期赠包，路由口径剔除它（口径差是刻意的）", () => {
    const now = Date.now();
    const drainedGrant = {
      name: "Monthly", used: 500, total: 500, remaining: 0,
      resetAt: iso(5 * DAY), recurring: true, giftPack: true,
    };
    expect(drivesEarliestExpiry(drainedGrant, { now })).toBe(false);
    expect(drivesEarliestExpiry(drainedGrant, { now, excludeDrainedGrants: false })).toBe(true);
    expect(earliestQuotaCountdown([drainedGrant], { now })).not.toBe(null);
    // 路由侧的排除同样适用于替代聚合的合集行。
    expect(drivesEarliestExpiry({ ...drainedGrant, giftPack: undefined, summarizesDetail: true }, { now })).toBe(false);
  });

  it("计数缺字段时不作「耗尽」处理：未知不得悄悄吞掉一个真期限", () => {
    const now = Date.now();
    expect(hasLiveRemaining({ resetAt: iso(DAY) })).toBe(true);
    expect(hasLiveRemaining({ remainingNum: 0, resetAt: iso(DAY) })).toBe(false);
    // 任一口径报 0 即耗尽（remaining 是绝对积分、remainingPercentage 是 0–100，
    // 两者在 <=0 上含义相同，不存在单位歧义）。
    expect(hasLiveRemaining({ remaining: 0, remainingPercentage: 90, resetAt: iso(DAY) })).toBe(false);
    expect(hasLiveRemaining({ unlimited: true, remaining: 0, resetAt: iso(DAY) })).toBe(true);
  });

  it("并列取第一条（调用方顺序即展示顺序，头部不得在两同日期间抖动）", () => {
    const now = Date.now();
    const at = iso(2 * DAY);
    const a = { name: "A", used: 0, total: 100, resetAt: at };
    const b = { name: "B", used: 0, total: 100, resetAt: at };
    expect(earliestQuotaCountdown([a, b], { now })?.row.name).toBe("A");
    expect(earliestQuotaCountdown([b, a], { now })?.row.name).toBe("B");
  });

  it("空/畸形输入安全：非数组、null 行、字符串行都不炸", () => {
    const now = Date.now();
    expect(earliestQuotaCountdown(null, { now })).toBe(null);
    expect(earliestQuotaCountdown(undefined, { now })).toBe(null);
    expect(earliestQuotaCountdown([], { now })).toBe(null);
    expect(earliestQuotaCountdown([null, "x", 42, {}], { now })).toBe(null);
    expect(drivesEarliestExpiry(null, { now })).toBe(false);
    expect(drivesEarliestExpiry("nope", { now })).toBe(false);
  });
});

// ─── 3. 三面同值：头部 === 排序键 === 持久化列 ──────────────────────────────
describe("三面口径一致性", () => {
  // 用户截图的形态（CodeBuddy CN #2055）：一个耗尽但 5d 后重置的周期月包 +
  // 一批满的赠送包（17d～25d 递增）+ 一个已耗尽的一次性包。
  const mixedUsage = () => {
    const now = Date.now();
    return {
      quotas: {
        "Total Points": { used: 3113.84, total: 4406, resetAt: null, unlimited: false, recurring: false },
        // 红点行：0/500，5d 后重置 —— 这就是头部此前吞掉的信号。
        Monthly: { used: 500, total: 500, remaining: 0, resetAt: iso(5 * DAY), unlimited: false, recurring: true, giftPack: true },
        "Bonus Pack 1": { used: 1292.16, total: 1292.16, remaining: 0, resetAt: iso(1 * DAY), unlimited: false, recurring: false },
        ...Object.fromEntries(
          Array.from({ length: 9 }, (_, i) => [
            `赠送包 ${16 + i}`,
            { used: 0, total: 100, remaining: 100, resetAt: iso((17 + i) * DAY), unlimited: false, recurring: false },
          ]),
        ),
      },
    };
  };

  it("混合形态（有满包 + 有耗尽周期窗）→ 头部与排序键同取最早的那个值", () => {
    const rows = parseQuotaData("codebuddy-cn", mixedUsage());
    const now = Date.now();
    const head = earliestQuotaCountdown(rows, { now });
    // 本例应是 5d 后重置的周期月包，而不是 17d 的满赠送包。
    expect(head?.row.name).toBe("Monthly");
    expect(head?.time).toBeGreaterThanOrEqual(now + 5 * DAY - 60000);
    expect(head?.time).toBeLessThan(now + 17 * DAY);
    expect(head?.resets).toBe(true);

    // 排序键：与头部同一个时间（此前它取 5d 而头部取 17d，两边打架）。用一张
    // 「只有 17d 满包」的对照卡验证方向：耗尽月包必须把它挤到后面。
    const conns = [
      { id: "only-full-packs", provider: "meoo", name: "M", quotas: null },
      { id: "codebuddy", provider: "codebuddy-cn", name: "CB" },
    ];
    const onlyPacks = rows.filter((r) => r.name !== "Monthly");
    const sorted = sortVisibleConnections(
      conns,
      { codebuddy: { quotas: rows }, "only-full-packs": { quotas: onlyPacks } },
      true,
      "all",
      "default",
    );
    expect(sorted.map((c) => c.id)).toEqual(["codebuddy", "only-full-packs"]);
    // 两面读同一个值：卡上的时刻 == 墙用来排的时刻。
    expect(earliestQuotaCountdown(rows, { now }).time).toBe(head.time);
    expect(head.time).toBeLessThan(earliestQuotaCountdown(onlyPacks, { now }).time);
  });

  it("同一份卡面数据：服务端展示列与卡上头部同值", () => {
    const usage = mixedUsage();
    const display = extractDisplayPackageExpiry(usage);
    expect(display?.name).toBe("Monthly");
    // 路由口径必须仍然剔除耗尽的月赠包，否则每个号都报同一个月底日期、
    // 多账号派发会卡死（既有契约，本测试钉它没被展示口径带跑）。
    const routing = extractEarliestPackageExpiry(usage);
    expect(routing?.name).toBe("赠送包 16");
    expect(routing.expiry).not.toBe(display.expiry);
  });

  it("全耗尽且无回血窗口 → 展示列也是 null（卡上不编造倒计时）", () => {
    const usage = {
      quotas: {
        "Bonus Pack 1": { used: 100, total: 100, remaining: 0, resetAt: iso(2 * DAY), recurring: false },
      },
    };
    expect(extractDisplayPackageExpiry(usage)).toBe(null);
    expect(extractEarliestPackageExpiry(usage)).toBeNull();
  });

  it("itemised 合集（Qoder addOn）：两面都按 LIVE 包排，不看聚合行、不看耗尽包", () => {
    const usage = {
      quotas: {
        addOn: {
          total: 600, used: 575, remaining: 25,
          resetAt: iso(3 * DAY), // 由「含耗尽包」的最早包推出来，不可信
          packs: [
            { name: "赠送包 1", total: 100, used: 100, remaining: 0, expiresAt: iso(3 * DAY) },
            { name: "赠送包 2", total: 100, used: 75, remaining: 25, expiresAt: iso(19 * DAY) },
          ],
        },
      },
    };
    const display = extractDisplayPackageExpiry(usage);
    expect(display?.name).toBe("addOn · 赠送包 2");
    expect(display.timestamp).toBeGreaterThanOrEqual(Date.now() + 19 * DAY - 60000);
    // 卡面同样落在活的包上（parseQuotaData 把包标成 detailOnly，头部候选里有它们）。
    const rows = parseQuotaData("qoder", usage);
    const head = earliestQuotaCountdown(rows);
    expect(head?.raw).toBe(usage.quotas.addOn.packs[1].expiresAt);
  });
});

// ─── 4. 卡间排序器：比较 VALUES、并列沉底 ──────────────────────────────────
describe("sortVisibleConnections — 沙漏序的健壮化", () => {
  it("两侧都是 Infinity 时按 provider/name 沉底（减法会得 NaN 被当相等，钮看起来没反应）", () => {
    const conns = [
      { id: "x", provider: "qoder", name: "x" },
      { id: "a", provider: "aaaa", name: "a" },
      { id: "b", provider: "meoo", name: "b" },
    ];
    const sorted = sortVisibleConnections(conns, {}, true, "all", "default");
    expect(sorted.map((c) => c.id)).toEqual(["a", "b", "x"]);
  });

  it("配额未落地时回退持久化列：展示列优先，路由列兜底", () => {
    const conns = [
      { id: "routing-only", provider: "meoo", name: "r", earliestPackageExpiry: iso(30 * DAY) },
      { id: "display-wins", provider: "meoo", name: "d", displayPackageExpiry: iso(5 * DAY), earliestPackageExpiry: iso(40 * DAY) },
      { id: "none", provider: "meoo", name: "n" },
    ];
    const sorted = sortVisibleConnections(conns, {}, true, "all", "default");
    expect(sorted.map((c) => c.id)).toEqual(["display-wins", "routing-only", "none"]);
  });

  it("卡上 resetAt 优先于行级回退（落地数据比缓存新鲜）", () => {
    const conns = [
      { id: "row", provider: "meoo", name: "row", displayPackageExpiry: iso(48 * HOUR) },
      { id: "card", provider: "meoo", name: "card" },
    ];
    const quotaData = { card: { quotas: [{ name: "pack", used: 1, total: 10, resetAt: iso(6 * HOUR) }] } };
    const sorted = sortVisibleConnections(conns, quotaData, true, "all", "default");
    expect(sorted.map((c) => c.id)).toEqual(["card", "row"]);
  });

  it("9999 哨兵与过去日期同「无日期」沉底，不得排在有期限的卡之前", () => {
    const conns = [
      { id: "sentinel", provider: "opencode", name: "s", displayPackageExpiry: "9999-12-31T00:00:00.000Z" },
      { id: "past", provider: "meoo", name: "p", displayPackageExpiry: iso(-3 * DAY) },
      { id: "junk", provider: "meoo", name: "j", displayPackageExpiry: "not-a-date" },
      { id: "soon", provider: "meoo", name: "q", displayPackageExpiry: iso(24 * HOUR) },
    ];
    const sorted = sortVisibleConnections(conns, {}, true, "all", "default");
    expect(sorted[0].id).toBe("soon");
    // 沉底组内部按 provider 字典序决胜（Infinity 用减法会得到 NaN）：
    // meoo(j) < meoo(p) < opencode(s)。
    expect(sorted.slice(1).map((c) => c.id)).toEqual(["junk", "past", "sentinel"]);
  });

  it("codex 的 remaining 排序分支不被误伤（quotaSortMode 非 default 仍走剩余量）", () => {
    const conns = [
      { id: "a", provider: "codex", name: "a" },
      { id: "b", provider: "codex", name: "b" },
    ];
    const quotaData = {
      a: { quotas: [{ name: "5h", remaining: 10, resetAt: iso(HOUR) }] },
      b: { quotas: [{ name: "5h", remaining: 90, resetAt: iso(9 * HOUR) }] },
    };
    const sorted = sortVisibleConnections(conns, quotaData, true, "codex", "remaining-desc");
    expect(sorted.map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("关掉沙漏时保持 provider 分组序（口径改动不得顺手换默认序）", () => {
    const conns = [
      { id: "a", provider: "meoo", name: "a", displayPackageExpiry: iso(30 * DAY) },
      { id: "b", provider: "qoder", name: "b" },
      { id: "c", provider: "meoo", name: "c" },
    ];
    const sorted = sortVisibleConnections(conns, {}, false, "all", "default");
    expect(sorted.map((c) => c.id)).toEqual(["a", "c", "b"]);
  });

  it("隐藏一行=改排序键：卡面只剩可见行（与被隐藏的行的日期脱钩）", () => {
    const conns = [
      { id: "x", provider: "meoo", name: "x" },
      { id: "y", provider:"meoo", name: "y" },
    ];
    // x 的 Monthly 3d 后重置（用户隐藏掉）+ Weekly 20d；y 只剩 10d 的包。
    const xRows = [
      { name: "Monthly", used: 500, total: 500, remaining: 0, resetAt: iso(3 * DAY), recurring: true, giftPack: true },
      { name: "Weekly", used: 0, total: 100, resetAt: iso(20 * DAY), recurring: true },
    ];
    const yRows = [{ name: "pack", used: 0, total: 100, resetAt: iso(10 * DAY), recurring: false }];
    const quotaData = { x: { quotas: xRows }, y: { quotas: yRows } };
    // 全量（可见）：x 按 3d 排在 y 前。
    expect(sortVisibleConnections(conns, quotaData, true, "all", "default").map((c) => c.id))
      .toEqual(["x", "y"]);
    // 隐藏 Monthly 后 x 的排序键变 20d，必须落到 y 之后。
    const visible = { x: { quotas: xRows.slice(1) }, y: { quotas: yRows } };
    expect(sortVisibleConnections(conns, quotaData, true, "all", "default", visible).map((c) => c.id))
      .toEqual(["y", "x"]);
  });

  it("codex 的 remaining 分支读全量行：隐藏一行不得换排序基准", () => {
    const conns = [
      { id: "a", provider: "codex", name: "a" },
      { id: "b", provider: "codex", name: "b" },
    ];
    const quotaData = {
      a: { quotas: [{ name: "5h", remaining: 10 }, { name: "w", remaining: 99 }] },
      b: { quotas: [{ name: "5h", remaining: 90 }, { name: "w", remaining: 1 }] },
    };
    // 若该分支误读可见行集合（把首行隐藏掉），a/b 的基准就换成了第二行，顺序会反过来。
    const visible = {
      a: { quotas: quotaData.a.quotas.slice(1) },
      b: { quotas: quotaData.b.quotas.slice(1) },
    };
    const withRaw = sortVisibleConnections(conns, quotaData, true, "codex", "remaining-desc");
    const withVisible = sortVisibleConnections(conns, quotaData, true, "codex", "remaining-desc", visible);
    expect(withRaw.map((c) => c.id)).toEqual(["b", "a"]);
    expect(withVisible.map((c) => c.id)).toEqual(["b", "a"]);
  });
});

// ─── 3b. 简报点名的其余供应商形态，在同一套规则下的落点 ─────────────────────
describe("各供应商形态的倒计时落点", () => {
  const now = Date.now();

  it("antigravity 双窗（5h + 每周，独立不嵌套）→ 取更近的 5h，用词「重置」", () => {
    const rows = [
      { name: "Gemini Models · 5h Window", used: 100, total: 100, remainingPercentage: 0, resetAt: iso(4 * HOUR), recurring: true, percentScale: true },
      { name: "Gemini Models · Weekly Window", used: 20, total: 100, remainingPercentage: 80, resetAt: iso(6 * DAY), recurring: true, percentScale: true },
    ];
    const best = earliestQuotaCountdown(rows, { now });
    expect(best.row.name).toBe("Gemini Models · 5h Window");
    expect(best.resets).toBe(true);
  });

  it("MiMo 周窗：上游只给名字不给 recurring 旗标，仍按名判定参与", () => {
    const rows = [{ name: "Weekly", used: 100, total: 100, remainingPercentage: 0, resetAt: iso(2 * DAY) }];
    expect(refillsWhenDrained(rows[0], { nameInferredCycles: (r) => /week|周/i.test(String(r.name)) })).toBe(true);
    expect(earliestQuotaCountdown(rows, { now })?.row.name).toBe("Weekly");
    // 路由口径不靠名字推断——同一条行在 relay 侧不参与。
    expect(drivesEarliestExpiry(rows[0], { now })).toBe(false);
  });

  it("stepfun 双储值条（余额 + 代金券）→ 整卡无倒计时（余额没有到期日）", () => {
    const rows = [
      { name: "余额(CNY)", used: 14.95, total: 14.95, remaining: 14.95, isCreditBalance: true, resetAt: iso(9 * DAY) },
      { name: "代金券(CNY)", used: 14.95, total: 14.95, remaining: 14.95, isCreditBalance: true, resetAt: iso(2 * DAY) },
    ];
    expect(earliestQuotaCountdown(rows, { now })).toBe(null);
  });

  it("Loomy 双槽（永久积分 + 每日赠送）→ 只数每日槽的 resetAt", () => {
    const rows = [
      { name: "永久积分", used: 0, total: 5000, remaining: 5000, isCreditBalance: true, recurring: false, resetAt: null, unlimited: true },
      { name: "每日赠送积分", used: 4000, total: 5000, remaining: 1000, recurring: true, resetAt: iso(6 * HOUR) },
    ];
    const best = earliestQuotaCountdown(rows, { now });
    expect(best.row.name).toBe("每日赠送积分");
    expect(best.resets).toBe(true);
  });

  it("Qoder 合集（资源包 Credits 含套餐内 Credits）→ 按明细包排，不按合集行", () => {
    const rows = [
      { name: "资源包", used: 875, total: 900, remaining: 25, aggregate: true, summarizesDetail: true, resetAt: iso(3 * DAY) },
      { name: "赠送包 1", used: 100, total: 100, remaining: 0, detailOnly: true, resetAt: iso(3 * DAY), recurring: false },
      { name: "赠送包 2", used: 75, total: 100, remaining: 25, detailOnly: true, resetAt: iso(19 * DAY), recurring: false },
    ];
    const best = earliestQuotaCountdown(rows, { now });
    expect(best.row.name).toBe("赠送包 2");
    expect(best.raw).toBe(rows[2].resetAt);
  });

  it("commandcode 三层嵌套窗（月度⊃每周⊃滚动）→ 取最近的滚动窗", () => {
    const rows = [
      { name: "session (5h)", recurring: true, total: 3, remainingNum: 1.94, resetAt: iso(2 * HOUR) },
      { name: "weekly (7d)", recurring: true, total: 6, remainingNum: 1.62, resetAt: iso(3 * DAY) },
      { name: "Monthly Credits", recurring: true, total: 6, remainingNum: 5.62, resetAt: iso(20 * DAY) },
    ];
    const best = earliestQuotaCountdown(rows, { now });
    expect(best.row.name).toBe("session (5h)");
  });
});

// ─── 5. 源码契约：三面必须调公共函数，且 import 清单齐全 ────────────────────
// QuotaPackBar 是 .js 里的 JSX，vitest 4 + vite 8 在本套件无法 import，因此组件
// 面只能做文本契约。文本契约必须连 import 一起钉：2026-11-24 那次漏 import 让
// 运行时 ReferenceError 被 catch 吞掉、全页连接消失，而 CI 只跑文本契约全绿。
describe("各面必须复用公共函数（不得自带 filter+sort 副本）", () => {
  const read = (rel) =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  const BAR = read("../../src/shared/components/QuotaPackBar.js");
  const UTILS = read("../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js");
  const CLIENT_ROUTE = read("../../src/app/api/providers/client/route.js");
  const TIMING = read("../../open-sse/utils/quotaTiming.js");
  const ROWS = read("../../src/shared/utils/quotaRows.js");
  const EXTRACTOR = read("../../open-sse/services/usage/expiryExtractor.js");
  const CONN_REPO = read("../../src/lib/db/repos/connectionsRepo.js");
  const USAGE_ROUTE = read("../../src/app/api/usage/[connectionId]/route.js");
  const AUTH_SVC = read("../../src/sse/services/auth.js");
  const TEST_UTILS = read("../../src/app/api/providers/[id]/test/testUtils.js");

  const importedFrom = (src, moduleRe) => {
    const m = src.match(new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*"${moduleRe}`));
    return new Set(
      m
        ? m[1].split(",").map((s) => s.trim().replace(/^type\s+/, "")).filter(Boolean)
        : [],
    );
  };

  it("QuotaPackBar 调公共 earliestQuotaCountdown，不再自己 filter(remainingNum>0).sort()", () => {
    expect(BAR).toMatch(/earliestQuotaCountdown\(/);
    expect(BAR).not.toMatch(/filter\(\(p\) => p\.remainingNum > 0\)[\s\S]{0,80}\.sort\(/);
    expect(BAR).not.toMatch(/const soonestLive/);
    expect(BAR).not.toMatch(/const recycling = barPacks/);
    // 头部候选不能再用被池子筛过的 barPacks（耗尽月包正是被池子剔掉的）。
    expect(BAR).toMatch(/earliestQuotaCountdown\(\s*\[[\s\S]{0,200}withNums/);
  });

  it("QuotaPackBar 的 quotaRows import 清单齐全（漏一项运行时 ReferenceError 被吞）", () => {
    const imported = importedFrom(BAR, "@/shared/utils/quotaRows");
    for (const name of ["earliestQuotaCountdown", "isDrainedGiftPack", "meterTone", "percentOf", "isResettingRow"]) {
      expect(imported.has(name), `missing import: ${name}`).toBe(true);
    }
    // 导出名单直接取模块命名空间（quotaRows 是 DOM-free 可 import 的纯模块），
    // 比正则抓 `export` 关键字准——对象字面量的键会被正则误收成「导出名」。
    const exported = new Set(Object.keys(quotaRowsModule));
    expect(exported.size).toBeGreaterThan(15);
    const body = BAR.replace(/import\s*\{[^}]*\}\s*from\s*"@\/shared\/utils\/quotaRows";?/, "");
    const notImported = [...exported].filter(
      (n) => new RegExp(`\\b${n}\\b`).test(body) && !imported.has(n),
    );
    expect(notImported, `referenced but not imported: ${notImported.join(", ")}`).toEqual([]);
    const unused = [...imported].filter((n) => !new RegExp(`\\b${n}\\b`).test(body));
    expect(unused, `imported but unused (dead names): ${unused.join(", ")}`).toEqual([]);
  });

  it("排序面（utils.js）调公共函数，日期守卫取自时间原语", () => {
    expect(UTILS).toMatch(/earliestQuotaCountdown\(ranked\[connection\.id\]\?\.quotas/);
    expect(UTILS).toMatch(/quotaCountdownFromRaw/);
    // 曾经的病灶：自己 map/filter/sort resetAt。
    expect(UTILS).not.toMatch(/\.map\(\(quota\)\s*=>\s*\n?\s*quota\.resetAt/);
    expect(UTILS).toMatch(/import\s*\{[^}]*quotaCountdownFromRaw[^}]*\}\s*from\s*"open-sse\/utils\/quotaTiming\.js"/s);
    expect(UTILS).toMatch(/earliestQuotaCountdown[^}]*\}\s*from\s*"@\/shared\/utils\/quotaRows"/);
    // 沙漏序读「卡面可见行」，codex 的 remaining 分支读全量（隐藏一行不得换排序基准）
    expect(UTILS).toMatch(/const ranked = visibleQuotaData \|\| quotaData;/);
    expect(UTILS).toMatch(/getConnectionQuotaRemaining\(a, quotaData\)/);
  });

  it("index.js 把可见行集合传给排序面，且 import 齐全", () => {
    const INDEX = read("../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js");
    expect(INDEX).toMatch(/visibleSortQuotaData/);
    expect(INDEX).toMatch(/filterQuotasByVisibility\(conn\.id, entry\.quotas \|\| \[\], quotaVisibility, conn\.provider\)/);
    // 第六个实参必须真传（签名加了参数、调用点忘传＝静默回到旧行为）。
    const call = INDEX.match(/sortVisibleConnections\(\s*\n?\s*connections,[\s\S]{0,200}/);
    expect(call, "sortVisibleConnections call not found").toBeTruthy();
    expect(call[0]).toMatch(/visibleSortQuotaData,\s*\n?\s*\)/);
    for (const name of ["filterQuotasByVisibility", "sortVisibleConnections"]) {
      const importBlock = INDEX.match(/import\s*\{([^}]*)\}\s*from\s*"\.\/utils"/);
      const imported = new Set(importBlock[1].split(",").map((s) => s.trim()).filter(Boolean));
      expect(imported.has(name), `index.js missing import: ${name}`).toBe(true);
    }
  });

  it("服务端 expiring 排序用公共日期守卫，并优先读展示列", () => {
    expect(CLIENT_ROUTE).toMatch(/quotaCountdownFromRaw/);
    expect(CLIENT_ROUTE).toMatch(/displayPackageExpiry\s*\?\?\s*c\?\.earliestPackageExpiry/);
    expect(CLIENT_ROUTE).toMatch(/"displayPackageExpiry"/); // 必须在 SAFE_FIELDS 里
    // 不再自己写 new Date(...).getTime() + 2099 守卫。
    expect(CLIENT_ROUTE).not.toMatch(/getFullYear\(\)\s*<=\s*2099/);
    expect(CLIENT_ROUTE).toMatch(/import\s*\{[^}]*quotaCountdownFromRaw[^}]*\}\s*from\s*"open-sse\/utils\/quotaTiming\.js"/);
  });

  it("比较器先判等再相减（Infinity-Infinity=NaN 会被当相等，沙漏钮「点了没反应」）", () => {
    // 两侧都可能是 Infinity，所以必须先 `a !== b` 再减：NaN 作为比较器返回值
    // 被引擎当「相等」，后面的 provider/name 决胜就永远不执行。
    expect(UTILS).toMatch(/if \(aTime !== bTime\) return aTime - bTime;/);
    expect(CLIENT_ROUTE).toMatch(/if \(ta !== tb\) return ta - tb;/);
    // 不存在裸相减（无判等前置）的比较写法。
    expect(UTILS).not.toMatch(/return getEarliestResetTime\(a\) - getEarliestResetTime\(b\);/);
    expect(UTILS).toMatch(/Compare the VALUES, not the difference/);
  });

  it("持久化：展示列进 OPTIONAL_FIELDS，三个写入点都写它", () => {
    expect(CONN_REPO).toMatch(/"displayPackageExpiry", "displayPackageName"/);
    for (const [name, src] of [["usage route", USAGE_ROUTE], ["auth service", AUTH_SVC], ["test utils", TEST_UTILS]]) {
      expect(src, `displayPackageExpiry not written by ${name}`).toMatch(/displayPackageExpiry/);
      expect(src, `displayPackageName not written by ${name}`).toMatch(/displayPackageName/);
      // 展示值必须来自展示口径提取器，不能拿路由值凑数（那正是本次的病灶）。
      expect(src, `${name} does not call extractDisplayPackageExpiry`).toMatch(/extractDisplayPackageExpiry\(usage\)/);
      expect(src, `${name} still reads expiryInfo.displayExpiry`).not.toMatch(/expiryInfo\??\.displayExpiry/);
    }
    // 清空分支也必须带上新列，否则额度清空后卡片仍带着旧倒计时排在墙最前。
    // 文件是 CRLF，且中间夹着注释，所以只钉「同一对象字面量里出现两者」。
    const clearedBranch = USAGE_ROUTE.slice(USAGE_ROUTE.indexOf("earliestPackageExpiry: null"));
    expect(clearedBranch.slice(0, 900)).toMatch(/\.\.\.displayPatch,/);
    // 无路由信号但卡上有倒计期的形态（耗尽订阅 + 会回血月包）也得写。
    expect(TEST_UTILS).toMatch(/usage\?\.quotas && displayInfo/);
  });

  it("时间原语无 src 依赖（open-sse 必须能独立使用）", () => {
    expect(TIMING).not.toMatch(/from\s*"@\//);
    expect(TIMING).not.toMatch(/require\(/);
    // 展示层从原语取日期规则，不得再写一份 2099 比较。
    expect(ROWS).toMatch(/from\s*"open-sse\/utils\/quotaTiming\.js"/);
    expect(ROWS).not.toMatch(/getFullYear\(\)\s*>\s*2099/);
    expect(EXTRACTOR).toMatch(/drivesEarliestExpiry/);
    expect(EXTRACTOR).toMatch(/quotaCountdownFromRaw/);
    expect(EXTRACTOR).not.toMatch(/getFullYear\(\)\s*<=\s*2099/);
  });

  it("展示口径与路由口径的选项差是显式声明的，不是散落的 if", () => {
    expect(ROWS).toMatch(/excludeDrainedGrants: false/);
    expect(ROWS).toMatch(/nameInferredCycles: isRecurringQuotaRow/);
    expect(COUNTDOWN_DISPLAY_RULES.excludeDrainedGrants).toBe(false);
    expect(typeof COUNTDOWN_DISPLAY_RULES.isExcludedRow).toBe("function");
  });
});
