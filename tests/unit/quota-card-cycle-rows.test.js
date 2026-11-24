/**
 * Quota card cycle rows + nested ladder.
 *
 * Two behaviors the card depends on, both pure and DOM-free (this suite is
 * `environment: "node"`, and QuotaPackBar is a JSX .js file vite cannot import
 * here — no React plugin, no jsdom):
 *
 *  1. `classifyCycleRows` — which rows are cycle WINDOWS (滚动/每周) versus
 *     monthly RESOURCE PACKS (codebuddy / qoder's `Monthly`, which expire at
 *     month end and belong in the additive pool bar, not a card block).
 *  2. `buildNestedCycle` — the 月度 ⊃ 每周 ⊃ 滚动 ladder. These allowances
 *     genuinely nest on commandcode (3 ⊂ 6 ⊂ 10), so each layer's bar is
 *     measured against the OUTERMOST total. That is what makes
 *     "rolling ≤ weekly ≤ monthly" structural instead of something the renderer
 *     polices.
 *
 * Payloads below are the real upstream shapes.
 */

import { describe, it, expect } from "vitest";
import {
  buildNestedCycle,
  classifyCycleRows,
  cycleRowLines,
  isDrainedGiftPack,
  isRecurringQuotaRow,
  isExpiredPack,
  isResettingRow,
  isSpentPack,
  isUsedUpPack,
  shortDate,
  shortDuration,
  isStoredValueRow,
  joinsPackPool,
  detailRows,
  groupRowsByFamily,
  healthHue,
  splitFamilyWindow,
  meterTone,
  needsPerPackDetails,
  nameWithoutUnit,
  percentOf,
  quotaUnitOf,
} from "../../src/shared/utils/quotaRows.js";

const row = (name, extra = {}) => ({ name, used: 0, total: 100, ...extra });

describe("nameWithoutUnit / quotaUnitOf (the card-name regression)", () => {
  it("strips the unit for stored-value rows", () => {
    expect(nameWithoutUnit("Balance (CNY)")).toBe("Balance");
    expect(quotaUnitOf("Balance (CNY)")).toBe("CNY");
  });

  it("MUST NOT be applied to cycle rows — the suffix is the dictionary key", () => {
    // Regression guard for the bug this function shipped with. The dictionary
    // keys are the FULL names:
    //   "session (5h)" → 滚动, "weekly (7d)" → 每周, "Monthly Credits" → 月度额度
    // Stripping the parenthetical yields "session" / "weekly", which are NOT
    // keys, so translateQuotaName fell through and the card rendered the raw
    // English name while the detail table showed 滚动/每周.
    expect(nameWithoutUnit("session (5h)")).toBe("session");
    expect(nameWithoutUnit("weekly (7d)")).toBe("weekly");
    // Only the stored-value path may strip, and it is keyed on the row, not on
    // the name shape — so these names must reach the lookup intact.
    expect(isStoredValueRow(row("session (5h)", { recurring: true }))).toBe(false);
    expect(isStoredValueRow(row("weekly (7d)", { recurring: true }))).toBe(false);
    expect(isStoredValueRow(row("Monthly Credits", { recurring: true }))).toBe(false);
  });

  it("a credit-balance row (MiniMax Code Credits) renders as a stored value, not X / X", () => {
    const credits = row("Credits", { used: 0, total: 999.96, remaining: 999.96, isCreditBalance: true });
    expect(isStoredValueRow(credits)).toBe(true);
    expect(isResettingRow(credits)).toBe(false);
  });
});

describe("classifyCycleRows", () => {
  it("monthly is a DUAL citizen: in the pool AND its own row", () => {
    // A `Monthly` allowance expires at month end, so it counts into the pool bar
    // and the big total. It ALSO renders as its own progress row underneath —
    // the card shows both. `monthly` is the pool feed; `cycleRowLines` is the
    // row list, and it contains the monthly row too.
    const monthly = row("Monthly Credits", { recurring: true, total: 10, used: 0.04 });
    const c = classifyCycleRows([monthly]);
    expect(c.monthly).toEqual([monthly]);

    const lines = cycleRowLines([monthly]);
    expect(lines).toEqual([monthly]);
  });

  it("keeps rolling/weekly as windows and excludes the monthly pack", () => {
    const session = row("session (5h)", { recurring: true, total: 3 });
    const weekly = row("weekly (7d)", { recurring: true, total: 6 });
    const monthly = row("Monthly Credits", { recurring: true, total: 10 });

    const c = classifyCycleRows([session, weekly, monthly]);
    expect(c.hasAnyCycle).toBe(true);
    expect(c.windows).toEqual([session, weekly, monthly]);
    expect(c.monthly).toEqual([monthly]);
  });

  it("mimo-desktop: a lone Weekly is a window with no monthly invented", () => {
    // Real payload: {"Weekly": {...}} — no recurring flag (default branch
    // provider), so recognition is by name.
    const weekly = row("Weekly", { resetAt: "2026-10-06T08:43:49.000Z" });
    expect(isRecurringQuotaRow(weekly)).toBe(true);

    const c = classifyCycleRows([weekly]);
    expect(c.windows).toEqual([weekly]);
    // No monthly row exists upstream, so none is synthesised for the card.
    expect(c.monthly).toEqual([]);
    expect(cycleRowLines([weekly])).toEqual([weekly]);
  });

  it("a pure stored-value card has no cycle rows at all (stepfun-cn)", () => {
    const c = classifyCycleRows([
      row("Balance (CNY)", { displayRemaining: true, total: 14.95 }),
      row("Voucher (CNY)", { displayRemaining: true, total: 14.95 }),
    ]);
    expect(c.hasAnyCycle).toBe(false);
    expect(c.windows).toEqual([]);
    expect(c.monthly).toEqual([]);
    expect(cycleRowLines([
      row("Balance (CNY)", { displayRemaining: true, total: 14.95 }),
    ])).toEqual([]);
  });
});

describe("cycleRowLines", () => {
  it("orders shorter windows first, monthly anchored at the bottom", () => {
    const session = row("session (5h)", { recurring: true, total: 3 });
    const weekly = row("weekly (7d)", { recurring: true, total: 6 });
    const monthly = row("Monthly Credits", { recurring: true, total: 10 });
    expect(cycleRowLines([weekly, session, monthly])).toEqual([weekly, session, monthly]);
  });

  it("a GIFT-pack monthly stays collapsed (CodeBuddy's monthly grant)", () => {
    // CodeBuddy's "Monthly" is a monthly credit GRANT — the same kind of thing
    // as its Bonus Packs — not a plan window. It must not get its own line; it
    // lives in the per-pack details only. `parseQuotaData` marks it.
    const grant = row("Monthly", { recurring: true, total: 500, giftPack: true });
    expect(cycleRowLines([grant])).toEqual([]);
    // ...but it still belongs to the pool/total, so nothing is lost.
    expect(classifyCycleRows([grant]).monthly).toEqual([grant]);
  });

  it("a PLAN monthly window still gets its own line (opencode-go)", () => {
    const planMonthly = row("Monthly", { recurring: true, total: 100 });
    expect(cycleRowLines([planMonthly])).toEqual([planMonthly]);
  });

  it("mixes them: only the plan window shows, the grant stays collapsed", () => {
    const planMonthly = row("Monthly", { recurring: true, total: 100 }); // opencode-go
    const weekly = row("Weekly", { recurring: true, total: 50 });
    expect(cycleRowLines([weekly, planMonthly])).toEqual([weekly, planMonthly]);

    const grant = row("Monthly", { recurring: true, total: 500, giftPack: true });
    const bonus = row("Bonus Pack 1", { recurring: false, total: 100 });
    expect(cycleRowLines([grant, bonus])).toEqual([]);
  });
});

describe("buildNestedCycle", () => {
  // Real commandcode payload.
  const session = row("session (5h)", { recurring: true, total: 3, used: 0, remaining: 3, remainingNum: 3 });
  const weekly = row("weekly (7d)", { recurring: true, total: 6, used: 0.0365, remaining: 5.9635, remainingNum: 5.9635 });
  const monthly = row("Monthly Credits", { recurring: true, total: 10, used: 0.0365, remaining: 9.9635, remainingNum: 9.9635 });

  it("orders outermost-first: 月度 ⊃ 每周 ⊃ 滚动", () => {
    const ladder = buildNestedCycle([session, weekly, monthly]);
    expect(ladder.map((l) => l.row.name)).toEqual([
      "Monthly Credits",
      "weekly (7d)",
      "session (5h)",
    ]);
    expect(ladder.map((l) => l.depth)).toEqual([0, 1, 2]);
  });

  it("measures every layer on the HEAD's scale (commandcode: all USD)", () => {
    const [m, w, s] = buildNestedCycle([session, weekly, monthly]);
    // 9.9635 / 10, 5.9635 / 10, 3 / 10 — one ruler, so the bands line up with
    // the real amounts instead of each being "100% of itself".
    expect(m.widthPct).toBeCloseTo(99.635, 3);
    expect(w.widthPct).toBeCloseTo(59.635, 3);
    expect(s.widthPct).toBeCloseTo(30, 3);
    // The invariant the layout rests on: nested bands never overhang.
    expect(s.widthPct).toBeLessThanOrEqual(w.widthPct);
    expect(w.widthPct).toBeLessThanOrEqual(m.widthPct);
  });

  it("each layer keeps its OWN ceiling in the label (X / own-total)", () => {
    const [m, w, s] = buildNestedCycle([session, weekly, monthly]);
    expect([m.ownRemaining, m.ownTotal]).toEqual([9.9635, 10]);
    expect([w.ownRemaining, w.ownTotal]).toEqual([5.9635, 6]);
    expect([s.ownRemaining, s.ownTotal]).toEqual([3, 3]);
  });

  it("clamps a child to what its parent has left", () => {
    // A full 5h session cannot spend more than the 0.6 left in the week.
    const tightWeekly = row("weekly (7d)", { recurring: true, total: 6, remaining: 0.6, remainingNum: 0.6 });
    const fullSession = row("session (5h)", { recurring: true, total: 3, remaining: 3, remainingNum: 3 });
    const [, w, s] = buildNestedCycle([tightWeekly, fullSession, monthly]);
    expect(w.widthPct).toBeCloseTo(6, 3);
    expect(s.widthPct).toBeCloseTo(6, 3);
    expect(s.ownRemaining).toBe(3); // the label still reports the window's own number
  });

  it("an exhausted head empties the whole track (regression: it drew 100%)", () => {
    const spent = row("Monthly Credits", { recurring: true, total: 10, remaining: 0, remainingNum: 0 });
    const fullWeekly = row("weekly (7d)", { recurring: true, total: 6, remaining: 6, remainingNum: 6 });
    const fullSession = row("session (5h)", { recurring: true, total: 3, remaining: 3, remainingNum: 3 });
    const ladder = buildNestedCycle([fullSession, fullWeekly, spent]);
    expect(ladder.map((l) => l.widthPct)).toEqual([0, 0, 0]);
  });

  it("percent-only windows are NOT nested (opencode-go: 100 / 100 / 100)", () => {
    // Each is a percent of its own undisclosed ceiling, so there is no shared
    // scale to nest on — they stay flat rows.
    const pct = (name) => row(name, { recurring: true, total: 100, remainingNum: 70 });
    expect(buildNestedCycle([pct("Rolling"), pct("Weekly"), pct("Monthly")])).toEqual([]);
  });

  // The experimental "nested cycle quota bars" toggle (localStorage
  // quotaNestedCycle → QuotaPackBar nestedCycle → force). The user's live
  // commandcode data: 每周 ceiling == 月度额度 ceiling, which trips the strict
  // containment rule even though the scopes genuinely nest.
  const eqChain = () => [
    row("session (5h)", { recurring: true, total: 3, remainingNum: 1.94 }),
    row("weekly (7d)", { recurring: true, total: 6, remainingNum: 1.62 }),
    row("Monthly Credits", { recurring: true, total: 6, remainingNum: 5.62 }),
  ];

  it("default: equal ceilings are NOT nested (commandcode 6/6 live data)", () => {
    expect(buildNestedCycle(eqChain())).toEqual([]);
  });

  it("force: an equal-ceilings chain nests, clamped parent-fit", () => {
    const [m, w, s] = buildNestedCycle(eqChain(), { force: true });
    expect([m.ownTotal, w.ownTotal, s.ownTotal]).toEqual([6, 6, 3]);
    expect(m.widthPct).toBeCloseTo((5.62 / 6) * 100, 3);
    expect(w.widthPct).toBeCloseTo((1.62 / 6) * 100, 3);
    expect(s.widthPct).toBeCloseTo((1.62 / 6) * 100, 3); // 1.94 会话被每周的 1.62 截断
    expect(s.ownRemaining).toBe(1.94); // label still reports the window's own number
  });

  it("force still requires the monthly head and two real-amount layers", () => {
    const weekly = row("weekly (7d)", { recurring: true, total: 6, remainingNum: 6 });
    const session = row("session (5h)", { recurring: true, total: 3, remainingNum: 3 });
    expect(buildNestedCycle([weekly, session], { force: true })).toEqual([]);
    expect(buildNestedCycle([weekly, session, row("Monthly Credits", { recurring: true, total: 0, remainingNum: 0 })], { force: true })).toEqual([]);
  });

  it("a one-shot credit row never heads the ladder (Purchased Credits)", () => {
    const purchased = row("Purchased Credits", { recurring: false, total: 50, remainingNum: 50 });
    expect(buildNestedCycle([purchased, weekly, session])).toEqual([]);
  });

  it("a lone weekly is NOT a ladder — it renders as one plain flat bar", () => {
    // mimo: only a Weekly, no monthly. No containment chain exists, so there is
    // nothing to nest; the renderer draws a single full-width bar instead.
    const weekly2 = row("Weekly", { recurring: true, total: 100, remaining: 100, remainingNum: 100 });
    expect(buildNestedCycle([weekly2])).toEqual([]);
  });

  it("weekly + rolling without a monthly head stay flat (nothing to contain them)", () => {
    // A weekly/rolling pair only nests when a monthly allowance is the thing
    // they are carved out of. Absent that, they are parallel windows.
    expect(buildNestedCycle([session, weekly])).toEqual([]);
  });

  it("returns empty for no cycle rows, so a plain card renders no ladder", () => {
    expect(buildNestedCycle([])).toEqual([]);
    expect(buildNestedCycle([row("Bonus Pack 21"), row("Balance (CNY)")])).toEqual([]);
  });

  it("a LONE monthly is not a ladder (this is what hid the CodeBuddy grant)", () => {
    // Regression: the renderer prefers the ladder whenever one exists and skips
    // `cycleRowLines` entirely. A single loose row produced a one-entry "ladder",
    // so the CodeBuddy monthly grant kept rendering even after being excluded
    // from the row list. A chain needs ≥ 2 layers.
    const grant = row("Monthly", { recurring: true, total: 500, giftPack: true });
    expect(buildNestedCycle([grant, row("Bonus Pack 1", { total: 100 })])).toEqual([]);

    // Same rule for a plan monthly with nothing under it.
    expect(buildNestedCycle([row("Monthly", { recurring: true, total: 100 })])).toEqual([]);
  });

  it("a gift-pack monthly can never head a chain", () => {
    // Even paired with a weekly, a GRANT monthly is not a plan window, so it is
    // skipped as a head — the weekly then has nothing to nest inside and falls
    // through to a flat row.
    const grant = row("Monthly", { recurring: true, total: 500, giftPack: true });
    const weekly = row("Weekly", { recurring: true, total: 100, remainingNum: 80 });
    expect(buildNestedCycle([grant, weekly])).toEqual([]);
    expect(cycleRowLines([grant, weekly])).toEqual([weekly]);
  });

  it("antigravity: 5h + weekly are PARALLEL windows, never a ladder", () => {
    // Real shape: `familyDisplayName · windowLabel`, e.g.
    //   "Gemini · 5h Window"   {percentScale:true, total:100}
    //   "Gemini · Weekly Window"
    // Neither contains the other — they are two independent meters on the same
    // family. With no monthly head there is no containment chain, so this must
    // stay flat (the renderer then draws two side-by-side full-width bars).
    const fiveH = row("Gemini · 5h Window", { percentScale: true, total: 100, remainingNum: 72, remainingPercentage: 72 });
    const weeklyWin = row("Gemini · Weekly Window", { percentScale: true, total: 100, remainingNum: 41, remainingPercentage: 41 });

    const ladder = buildNestedCycle([fiveH, weeklyWin]);
    expect(ladder).toEqual([]);

    // ...and they still show up as cycle windows so the caller renders them.
    const c = classifyCycleRows([fiveH, weeklyWin]);
    expect(c.hasAnyCycle).toBe(true);
    expect(c.windows).toHaveLength(2);
    expect(new Set(c.windows.map((r) => r.name))).toEqual(
      new Set(["Gemini · 5h Window", "Gemini · Weekly Window"]),
    );
    // A "5h Window" is not the same thing as a monthly pack, and must not be
    // swept into the pool.
    expect(c.monthly).toEqual([]);
  });

  it("antigravity weekly ALONE also stays flat (no fabricated parent)", () => {
    const weeklyWin = row("Claude · Weekly Window", { percentScale: true, total: 100, remainingNum: 41 });
    expect(buildNestedCycle([weeklyWin])).toEqual([]);
  });
});

describe("percentOf", () => {
  it("clamps to 0–100 and tolerates a missing/zero total", () => {
    expect(percentOf({ totalNum: 10, remainingNum: 5 })).toBe(50);
    expect(percentOf({ totalNum: 10, remainingNum: 20 })).toBe(100);
    expect(percentOf({ totalNum: 10, remainingNum: 0 })).toBe(0);
    expect(percentOf({ totalNum: 0, remainingNum: 0 })).toBe(0);
    expect(percentOf({ total: 4, used: 1 })).toBe(75);
  });
});

describe("meterTone — one colour rule for every quota meter", () => {
  it("resets → reset (sky), one-shot / balance → expire (green)", () => {
    expect(meterTone(row("weekly (7d)", { recurring: true, total: 6, remainingNum: 5 }))).toBe("reset");
    expect(meterTone(row("Bonus Pack 3", { recurring: false, total: 100, remainingNum: 80 }))).toBe("expire");
    expect(meterTone(row("Balance (CNY)", { total: 14.95, remainingNum: 14.95 }))).toBe("expire");
  });

  it("under 10% left is critical (red) whatever the kind; empty is not", () => {
    expect(meterTone(row("weekly (7d)", { recurring: true, total: 100, remainingNum: 5 }))).toBe("critical");
    expect(meterTone(row("Bonus Pack 1", { recurring: false, total: 100, remainingNum: 9 }))).toBe("critical");
    // 0 left has no fill to colour — it keeps its kind (the empty track says it).
    expect(meterTone(row("Bonus Pack 1", { recurring: false, total: 100, remainingNum: 0 }))).toBe("expire");
  });

  it("card and per-pack table agree on a flagless row (regression: Qoder was blue in one, green in the other)", () => {
    // The table used to default a missing flag to recurring; the card reads the
    // name. Both now go through isResettingRow.
    expect(isResettingRow({ name: "Resource Package", total: 900 })).toBe(false);
    expect(isResettingRow({ name: "Weekly", total: 100 })).toBe(true);
    // An explicit false always wins over a cycle-looking name.
    expect(isResettingRow({ name: "Monthly", recurring: false })).toBe(false);
  });
});

describe("isSpentPack — what folds into 已用完 / 已过期", () => {
  const NOW = Date.parse("2026-09-29T12:00:00Z");

  it("a used-up one-shot pack is history", () => {
    expect(isSpentPack({ name: "Bonus Pack 7", recurring: false, used: 100, total: 100 }, NOW)).toBe(true);
  });

  it("an expired one-shot pack is history even with credit left", () => {
    const p = { name: "Bonus Pack 2", recurring: false, used: 10, total: 100, resetAt: "2026-09-20T00:00:00Z" };
    expect(isExpiredPack(p, NOW)).toBe(true);
    expect(isSpentPack(p, NOW)).toBe(true);
  });

  it("a live pack is not", () => {
    expect(isSpentPack({ name: "Bonus Pack 1", recurring: false, used: 45, total: 100, resetAt: "2026-10-15T00:00:00Z" }, NOW)).toBe(false);
  });

  it("an exhausted CYCLE window is not history — it refills (每月 0 / 500)", () => {
    expect(isSpentPack({ name: "Monthly", recurring: true, used: 500, total: 500 }, NOW)).toBe(false);
    expect(isSpentPack({ name: "weekly (7d)", used: 6, total: 6 }, NOW)).toBe(false);
  });

  it("unlimited and zero-allowance rows are never folded away", () => {
    expect(isSpentPack({ name: "Pro", recurring: false, unlimited: true, used: 5, total: 0 }, NOW)).toBe(false);
    expect(isSpentPack({ name: "Plan Credits", recurring: false, used: 0, total: 0 }, NOW)).toBe(false);
  });
});

describe("isUsedUpPack — 0 余额但未到期的包不再倒计时（2026-11-24 用户报）", () => {
  const NOW = Date.parse("2026-09-29T12:00:00Z");

  it("a drained one-shot pack with its expiry still ahead is used up", () => {
    // CodeBuddy 赠送包 0/100，9h 42m 后才到期 —— 日期是记录，不是期限。
    expect(
      isUsedUpPack({ name: "Bonus Pack 1", recurring: false, used: 100, total: 100, resetAt: "2026-09-29T21:42:00Z" }, NOW)
    ).toBe(true);
    expect(
      isUsedUpPack({ name: "Bonus Pack 1", recurring: false, used: 0, total: 0, remainingNum: 0, resetAt: "2026-09-30T00:00:00Z" }, NOW)
    ).toBe(false);
  });

  it("a pack with credit left is not", () => {
    expect(
      isUsedUpPack({ name: "Bonus Pack 19", recurring: false, used: 94.81, total: 100, resetAt: "2026-10-15T00:00:00Z" }, NOW)
    ).toBe(false);
  });

  it("a drained CYCLE window is not used up — it refills", () => {
    expect(isUsedUpPack({ name: "Monthly", recurring: true, used: 500, total: 500, resetAt: "2026-10-05T00:00:00Z" }, NOW)).toBe(false);
  });

  it("an already-expired pack is not used up — expired wording takes over", () => {
    expect(
      isUsedUpPack({ name: "Bonus Pack 2", recurring: false, used: 100, total: 100, resetAt: "2026-09-20T00:00:00Z" }, NOW)
    ).toBe(false);
  });
});

describe("shortDate", () => {
  it("formats MM-DD and tolerates junk", () => {
    expect(shortDate("2026-10-05T12:00:00")).toBe("10-05");
    expect(shortDate("")).toBe("");
    expect(shortDate("not a date")).toBe("");
  });
});

describe("shortDuration", () => {
  const NOW = new Date("2026-10-01T12:00:00").getTime();
  it("scales precision with magnitude: d+h, h+m, m+s", () => {
    expect(shortDuration(new Date(NOW + 2 * 86400e3 + 3 * 3600e3 + 30 * 60e3).toISOString(), NOW)).toBe("2d 3h");
    expect(shortDuration(new Date(NOW + 5 * 3600e3 + 20 * 60e3 + 40e3).toISOString(), NOW)).toBe("5h 20m");
    expect(shortDuration(new Date(NOW + 45 * 60e3 + 30e3).toISOString(), NOW)).toBe("45m 30s");
  });
  it("clamps the past to zero and tolerates junk", () => {
    expect(shortDuration(new Date(NOW - 60e3).toISOString(), NOW)).toBe("0m 0s");
    expect(shortDuration("", NOW)).toBe("");
    expect(shortDuration("not a date", NOW)).toBe("");
  });
});

describe("逐包明细 — only when the card collapsed something", () => {
  it("drops the summary rows the headline already shows", () => {
    const total = { name: "Total Points", total: 4182 };
    const addOn = { name: "Resource Package", total: 900, aggregate: true, summarizesDetail: true };
    const pack = { name: "Bonus Pack 1", total: 500, detailOnly: true, recurring: false };
    expect(detailRows([total, addOn, pack])).toEqual([pack]);
  });

  it("subscription cards (every row already on the card) get no details", () => {
    const cc = [
      { name: "session (5h)", recurring: true, total: 3 },
      { name: "weekly (7d)", recurring: true, total: 6 },
      { name: "Monthly Credits", recurring: true, total: 10 },
    ];
    expect(needsPerPackDetails(cc)).toBe(false);
    // + one purchased pool: it is the card headline, still nothing new.
    expect(needsPerPackDetails([...cc, { name: "Purchased Credits", recurring: false, total: 50 }])).toBe(false);
    expect(needsPerPackDetails([{ name: "Weekly", total: 100 }])).toBe(false); // mimo
    expect(needsPerPackDetails([{ name: "Resource Package", total: 100, aggregate: true }])).toBe(false); // qoder, no packs
  });

  it("pack cards keep them", () => {
    const grant = { name: "Monthly", recurring: true, giftPack: true, total: 500 };
    const bonus = (n) => ({ name: `Bonus Pack ${n}`, recurring: false, total: 100 });
    expect(needsPerPackDetails([grant, bonus(1), bonus(2)])).toBe(true); // codebuddy
    expect(needsPerPackDetails([
      { name: "Resource Package", total: 900, summarizesDetail: true },
      { name: "Bonus Pack 1", total: 500, detailOnly: true, recurring: false },
    ])).toBe(true); // qoder with packs
    expect(needsPerPackDetails([
      { name: "Balance (CNY)", total: 14.95 },
      { name: "Voucher (CNY)", total: 14.95 },
    ])).toBe(true); // stepfun-cn: 代金券 is not on the card
  });
});

describe("antigravity family windows", () => {
  const g5 = { name: "Gemini Models · 5h Window", percentScale: true, total: 100 };
  const gw = { name: "Gemini Models · Weekly Window", percentScale: true, total: 100 };
  const c5 = { name: "Claude and GPT models · 5h Window", percentScale: true, total: 100 };
  const cw = { name: "Claude and GPT models · Weekly Window", percentScale: true, total: 100 };

  it("splits the upstream '<family> · <window>' name", () => {
    expect(splitFamilyWindow(g5.name)).toEqual({ family: "Gemini Models", window: "5h Window" });
    expect(splitFamilyWindow("weekly (7d)")).toBeNull();
  });

  it("groups consecutive windows under one family caption", () => {
    const groups = groupRowsByFamily([g5, gw, c5, cw, { name: "Weekly" }]);
    expect(groups.map((g) => [g.family, g.rows.length])).toEqual([
      ["Gemini Models", 2],
      ["Claude and GPT models", 2],
      [null, 1],
    ]);
  });

  it("stays flat and un-nested: percent windows share no scale", () => {
    expect(buildNestedCycle([g5, gw, c5, cw])).toEqual([]);
    expect(needsPerPackDetails([g5, gw, c5, cw])).toBe(false);
  });
});

describe("healthHue — one friendly gradient for every meter", () => {
  it("runs red → amber → emerald as more is left", () => {
    expect(healthHue(0)).toBe(4);      // red
    expect(healthHue(35)).toBe(40);    // amber
    expect(healthHue(100)).toBe(158);  // emerald
  });

  it("is monotonic — a fuller meter is never a warmer colour", () => {
    let prev = -1;
    for (let p = 0; p <= 100; p += 1) {
      const h = healthHue(p);
      expect(h).toBeGreaterThanOrEqual(prev);
      prev = h;
    }
  });

  it("clamps junk", () => {
    expect(healthHue(-5)).toBe(4);
    expect(healthHue(250)).toBe(158);
    expect(healthHue(undefined)).toBe(4);
  });
});

describe("joinsPackPool — a recurring stored-value balance must not blank the card", () => {
  // CreditDaddy's minimax-free push carries recurring:true on its balance rows
  // (daily 16:00 refill). Excluding recurring rows from the additive pool while
  // the cycle bucket excludes stored-value rows left such a row in NEITHER —
  // the card rendered nothing but its header (2026-10-21 白卡).
  const mmFreeRows = [
    { name: "备", used: 0, total: 2600.64, resetAt: "2026-10-21T16:00:00.000Z", recurring: true, displayRemaining: true, isCreditBalance: true, checkinToday: true, streakDays: 5 },
    { name: "主", used: 0, total: 2599.87, resetAt: "2026-10-21T16:00:00.000Z", recurring: true, displayRemaining: true, isCreditBalance: true, checkinToday: true, streakDays: 2 },
  ];

  it("recurring stored-value rows join the pool", () => {
    for (const r of mmFreeRows) {
      expect(isStoredValueRow(r)).toBe(true);
      expect(joinsPackPool(r)).toBe(true);
    }
  });

  it("plain recurring windows still stay out of the pool", () => {
    expect(joinsPackPool(row("session (5h)"))).toBe(false);
    expect(joinsPackPool(row("weekly (7d)"))).toBe(false);
  });

  it("one-shot packs keep joining the pool", () => {
    expect(joinsPackPool({ name: "Bonus Pack 1", recurring: false })).toBe(true);
  });

  it("classifyCycleRows still excludes them — a balance is not a window", () => {
    const { hasAnyCycle } = classifyCycleRows(mmFreeRows);
    expect(hasAnyCycle).toBe(false);
  });
});

describe("isDrainedGiftPack — the pool-denominator rule (CodeBuddy Intl 30/130)", () => {
  // 2026-10-22 user report: CodeBuddy Intl cards with a drained Monthly grant
  // read "30 / 130" — the pool summed the burned grant's total (100) into the
  // denominator while its remaining was 0. Same rule as the router's
  // expiryExtractor giftPack exclusion (T0 sibling).

  const drainedMonthly = {
    name: "Monthly",
    used: 100,
    total: 100,
    resetAt: "2026-10-31T15:59:59.000Z",
    recurring: true,
    giftPack: true,
    displayRemaining: true,
  };
  const liveMonthly = {
    name: "Monthly",
    used: 45.7,
    total: 100,
    resetAt: "2026-10-31T15:59:59.000Z",
    recurring: true,
    giftPack: true,
    displayRemaining: true,
  };

  it("flags a giftPack whose balance is fully spent", () => {
    expect(isDrainedGiftPack(drainedMonthly)).toBe(true);
  });

  it("keeps a giftPack that still has balance", () => {
    expect(isDrainedGiftPack(liveMonthly)).toBe(false);
  });

  it("never flags non-giftPack rows, even at zero", () => {
    expect(isDrainedGiftPack({ name: "Bonus Pack 1", used: 30, total: 30, recurring: false })).toBe(false);
    expect(isDrainedGiftPack({ name: "余额 (CNY)", used: 0, total: 0, isCreditBalance: true })).toBe(false);
    expect(isDrainedGiftPack(null)).toBe(false);
  });

  it("pool simulation: drained grant drops out, live grant counts", () => {
    // QuotaPackBar's monthlyPacks filter shape: !inLadder && !isDrainedGiftPack && (families || giftPack || displayRemaining)
    const pick = (rows) => rows.filter((r) => !isDrainedGiftPack(r));
    const bonus = { name: "Bonus Pack 1", used: 0, total: 30, recurring: false };
    // Google#2: Bonus 30 + drained Monthly 100 → pool total 30 (was 130)
    const g2 = pick([bonus, drainedMonthly]);
    expect(g2.reduce((s, p) => s + p.total, 0)).toBe(30);
    expect(g2.reduce((s, p) => s + (p.total - p.used), 0)).toBe(30);
    // Google#1: Bonus×5 (150) + live Monthly (54.3 remaining of 100) → intact
    const g1 = pick([bonus, bonus, bonus, bonus, bonus, liveMonthly]);
    expect(g1.reduce((s, p) => s + p.total, 0)).toBe(250);
    expect(g1.reduce((s, p) => s + (p.total - p.used), 0)).toBeCloseTo(204.3, 5);
  });
});

describe("poolHasExpiry guard — drained-giftpack exclusion must not eat the meta line", () => {
  // 2026-10-22 follow-up: excluding the drained Monthly collapsed CodeBuddy
  // pools to a single family/row → isSinglePool degraded the meta line to a
  // bare name ("赠送包 1"), losing the pack count AND the nearest-expiry
  // countdown. Any pool row with a resetAt must keep the count+expiry copy.
  //
  // Mirrors the QuotaPackBar decision shape (pure re-derivation; the component
  // is JSX and cannot be imported in this node suite):
  const isSinglePool = (pool, { isPoolFullyRepresented, byBreakdown, poolIsSettledBalance }) =>
    isPoolFullyRepresented && !pool.some((p) => p.resetAt) && (!byBreakdown || poolIsSettledBalance);

  it("CodeBuddy CN: single bonus family WITH expiries → not single-pool", () => {
    const pool = Array.from({ length: 12 }, (_, i) => ({
      name: `Bonus Pack ${i + 1}`, used: 0, total: 100,
      resetAt: `2026-11-${String(10 + i).padStart(2, "0")}T00:00:00Z`,
    }));
    expect(isSinglePool(pool, { isPoolFullyRepresented: true, byBreakdown: false, poolIsSettledBalance: false })).toBe(false);
  });

  it("CodeBuddy Intl single bonus pack with expiry → not single-pool (meta keeps countdown)", () => {
    const pool = [{ name: "Bonus Pack 1", used: 0, total: 30, resetAt: "2026-11-21T02:46:43.000Z" }];
    expect(isSinglePool(pool, { isPoolFullyRepresented: true, byBreakdown: false, poolIsSettledBalance: false })).toBe(false);
  });

  it("settled balances without expiry stay single-pool (stepfun 余额)", () => {
    const pool = [{ name: "余额 (CNY)", used: 0, total: 14.95, isCreditBalance: true }];
    expect(isSinglePool(pool, { isPoolFullyRepresented: true, byBreakdown: false, poolIsSettledBalance: true })).toBe(true);
  });

  it("Qoder itemised pool: byBreakdown with expiries → not single-pool (unchanged)", () => {
    const pool = [{ name: "Resource Package", used: 100, total: 900 }];
    const breakdown = [{ name: "Bonus Pack 1", total: 500, resetAt: "2026-11-01T00:00:00Z", detailOnly: true }];
    expect(isSinglePool(pool, { isPoolFullyRepresented: true, byBreakdown: breakdown.length > 0, poolIsSettledBalance: false })).toBe(false);
  });
});
