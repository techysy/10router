/**
 * Quota row classification — pure, DOM-free, JSX-free.
 *
 * Split out of `QuotaPackBar.js` so it can be unit-tested directly: the card
 * component is a `.js` file full of JSX, which this suite's vite pipeline
 * cannot import (no React plugin, and the test runner is `environment: "node"`
 * with no jsdom). Keeping the decisions here also makes the layout rules
 * readable on their own, away from the markup.
 */

export const AGGREGATE_RE = /total|aggregate|summary|^总/i;
// #Loomy dual-slot: 永久积分行名 与 每日赠送积分行名（loomy usage 返回的确切键）
export const PERMANENT_RE = /永久|permanent|lifetime/i;
export const DAILY_GRANT_RE = /每日赠送|daily\s*gift|daily\s*grant/i;
export const MONTHLY_RE = /month|月/i;
// A cycle WINDOW. Must cover every spelling the fetchers emit, because the
// `recurring` flag is not always forwarded (antigravity carries only
// `percentScale`, mimo-desktop only a name):
//   session (5h) / weekly (7d) / Monthly Credits   — commandcode, codebuddy
//   Weekly                                         — mimo-desktop
//   <family> · 5h Window / · Weekly Window         — antigravity
// Missing `5h`/`window` here made antigravity's 5h row classify as
// non-recurring, so it was silently dropped from the card.
export const RECURRING_NAME_RE = /month|月|week|周|滚动|rolling|5h|hourly|window/i;
// Stored-value pools (余额/代金券/现金…): a settled balance, not a window. They
// always read X/X because nothing decrements `total`, so the "/ total" half is
// noise — these render as a single value + unit.
export const STORED_VALUE_RE = /balance|voucher|cash|余额|代金券|现金/i;

/** Aggregate/summary rows are derived data — never charted, never summed. */
export function isAggregateQuotaRow(row) {
  return AGGREGATE_RE.test(String(row?.name || ""));
}

/** Subscription-recurring window: explicit flag or a cycle-named row. */
export function isRecurringQuotaRow(row) {
  if (row?.recurring === true) return true;
  return RECURRING_NAME_RE.test(String(row?.name || ""));
}

/** Stored-value pool (余额/代金券/现金): renders as one value, never "X / Y". */
/**
 * Loomy-style dual-slot pair: a permanent stored balance ("永久积分",
 * isCreditBalance) coexisting with a recurring daily grant ("每日赠送积分").
 * When both rows are present the card renders the TOTAL headline with two
 * inner slots (permanent + daily) instead of the generic pool bar (#Loomy).
 */
export function findDualSlotPair(rows = []) {
  const permanent = rows.find(
    (r) => r && r.isCreditBalance === true && PERMANENT_RE.test(String(r?.name || "")),
  );
  const daily = rows.find(
    (r) => r && r.recurring === true && DAILY_GRANT_RE.test(String(r?.name || "")),
  );
  if (!permanent || !daily) return null;
  return { permanent, daily };
}

if (!globalThis.__QUOTA_ROWS_RE__) {
  globalThis.__QUOTA_ROWS_RE__ = {};
}

export function isStoredValueRow(row) {
  if (row?.isCreditBalance === true) return true;
  return STORED_VALUE_RE.test(String(row?.name || ""));
}

/**
 * Whether a row joins QuotaPackBar's additive-pool bucket (one-shot packs +
 * stored-value singletons). A stored-value balance is a settled pool, never a
 * cycle window — even when the pusher marks it recurring (CreditDaddy's
 * minimax-free balances carry recurring:true for their daily 16:00 refill).
 * Without the stored-value escape hatch here the row fell into NEITHER bucket:
 * the cycle bucket excludes stored-value rows (classifyCycleRows) while this
 * bucket excluded recurring ones — the card rendered nothing but its header
 * (2026-10-21 minimax-free 白卡).
 */
export function joinsPackPool(row) {
  return !isRecurringQuotaRow(row) || isStoredValueRow(row);
}

/**
 * `"Balance (CNY)"` → `"CNY"`; `"Weekly"` → `""`.
 * The stored-value unit is lifted out of the row name so it can be re-attached
 * to the number as small print instead of living in the label.
 */
export function quotaUnitOf(name) {
  const m = /\(([^)]+)\)\s*$/.exec(String(name || ""));
  return m ? m[1].trim() : "";
}

/**
 * Name with any trailing `(...)` unit stripped: `"Balance (CNY)"` → `"Balance"`.
 *
 * ONLY for stored-value rows. Do NOT run this on cycle rows: the parenthetical
 * is part of the dictionary key there (`"session (5h)"` → 滚动, `"weekly (7d)"`
 * → 每周), so stripping it makes the lookup miss and the card renders the raw
 * English name. That was a real regression — see `quota-card-cycle-rows.test.js`.
 */
export function nameWithoutUnit(name) {
  return String(name || "").replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/** remaining/total clamped to 0–100, tolerant of missing/zero totals. */
export function percentOf(row) {
  const total = Number((row?.totalNum ?? row?.total) || 0);
  const remaining = Number.isFinite(row?.remainingNum)
    ? Number(row.remainingNum)
    : Math.max(0, total - Number(row?.used || 0));
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, (remaining / total) * 100));
}

// No `credit` here: "Monthly Credits" already matches /month/, and a bare
// credit token pulled one-shot rows ("Purchased Credits") in as the ladder head.
const CYCLE_LAYER_RE = {
  monthly: /month|月/i,
  weekly: /week|周/i,
  rolling: /rolling|滚动|session|5h/i,
};

function ownTotalOf(row) {
  return Number((row?.totalNum ?? row?.total) || 0);
}

function ownRemainingOf(row) {
  const total = ownTotalOf(row);
  return Number.isFinite(row?.remainingNum)
    ? Number(row.remainingNum)
    : Math.max(0, total - Number(row?.used || 0));
}

/**
 * Build the nested cycle ladder — outermost (largest allowance) first.
 *
 * WHICH rows nest (this is the whole subtlety):
 *
 *  - commandcode: `session (5h)` ⊂ `weekly (7d)` ⊂ `Monthly Credits` — three
 *    scopes of the SAME resource, each a hard ceiling on the one inside it. A
 *    month's credits are doled out into weeks, which are doled out into 5h
 *    sessions. That is a true containment chain.
 *
 *  - antigravity: `Gemini · 5h Window` + `Gemini · Weekly Window` — two
 *    SEPARATE windows on the same family. Neither contains the other; both are
 *    independent meters that happen to share a name prefix. These must render
 *    as two side-by-side bars, NOT as a ladder.
 *
 *  - opencode-go: `Rolling` / `Weekly` / `Monthly` are each a PERCENT of its
 *    own undisclosed ceiling (all 100). The sizes of the ceilings relative to
 *    each other are unknown, so there is nothing to nest on — flat rows.
 *
 * So nesting requires a MONTHLY head AND real amounts on one scale: every
 * layer's ceiling must be strictly smaller than its parent's (commandcode
 * 3 < 6 < 10 USD). Otherwise this returns `[]` and the caller renders each row
 * as its own plain full-width bar.
 *
 * When nesting IS in play all layers share the HEAD's ceiling as the measure,
 * and a child's fill is clamped to its parent's — you cannot spend more of a
 * week than is left in the month:
 *
 *   月度额度 9.69/10  [███████████████████▍]  96.9%
 *     每周   5.69/6   [███████████▍        ]  56.9%
 *       滚动 2.73/3   [█████▍              ]  27.3%
 *
 * Each row still reports its OWN `X / Y` in the label.
 */
export function buildNestedCycle(rows = [], { force = false } = {}) {
  const buckets = { monthly: null, weekly: null, rolling: null };
  for (const row of rows) {
    // A monthly GRANT (CodeBuddy) is a credit pack, not a plan window, so it
    // cannot be the head of a containment chain — it is collapsed to the
    // per-pack details instead. Only cycle rows are candidates at all: a
    // one-shot or stored-value row can never contain a window.
    if (row?.giftPack === true || row?.detailOnly === true) continue;
    if (!isRecurringQuotaRow(row) || isStoredValueRow(row)) continue;
    const name = String(row?.name || "");
    for (const [layer, re] of Object.entries(CYCLE_LAYER_RE)) {
      if (!buckets[layer] && re.test(name)) {
        buckets[layer] = row;
        break;
      }
    }
  }

  // No monthly head → no containment chain. Parallel windows (antigravity's
  // 5h + weekly) stay independent. `force` (the experimental nested-bars
  // toggle) relaxes that: with a monthly head and ≥2 real-amount layers the
  // caller wants the ladder even so — clamping below still keeps each child's
  // fill inside its parent's value.
  if (!buckets.monthly) return [];

  const ladder = [buckets.monthly, buckets.weekly, buckets.rolling].filter(Boolean);

  // A chain needs at least two layers. One loose row is not a ladder — it must
  // fall through to the flat `cycleRowLines` list, otherwise the renderer (which
  // prefers the ladder when one exists) would draw it and skip that filter
  // entirely. That is exactly how a lone CodeBuddy `Monthly` grant kept
  // appearing on the card after being excluded from `cycleRowLines`.
  if (ladder.length < 2) return [];

  // Containment on one scale: each ceiling strictly inside its parent's. Equal
  // totals (percent-only windows, all 100) or an inverted pair mean the layers
  // are not measured in a shared unit, so they cannot be drawn nested — UNLESS
  // `force` is on: commandcode's 每周 ceiling equals its 月度额度's, which trips
  // the equality case even though the scopes genuinely contain one another.
  if (!force) {
    for (let i = 1; i < ladder.length; i += 1) {
      const child = ownTotalOf(ladder[i]);
      if (!(child > 0 && child < ownTotalOf(ladder[i - 1]))) return [];
    }
  }

  const scale = ownTotalOf(ladder[0]);
  if (!(scale > 0)) return [];
  let parentValue = scale;
  return ladder.map((row, depth) => {
    const ownTotal = ownTotalOf(row);
    const ownRemaining = ownRemainingOf(row);
    const value = Math.max(0, Math.min(ownRemaining, parentValue));
    parentValue = value;
    return {
      row,
      depth,
      widthPct: Math.min(100, (value / scale) * 100),
      ownRemaining,
      ownTotal,
      ownPct: percentOf(row),
    };
  });
}

/**
 * Cycle rows that are NOT part of the nested ladder and NOT monthly packs.
 *
 * A `Monthly` / `Monthly Credits` row is a RESOURCE PACK expiring at month end
 * (codebuddy, qoder), not a window — it belongs in the additive pool bar, so it
 * is deliberately excluded here and never gets its own card block.
 *
 * Returning nothing for a card with no such rows is correct: a stored-value card
 * (stepfun) and a purely-monthly card both render no cycle block, and nothing
 * synthetic is invented for them.
 */
export function classifyCycleRows(rows = []) {
  const cycleRows = rows.filter((r) => isRecurringQuotaRow(r) && !isStoredValueRow(r));
  const monthly = cycleRows.filter((r) => MONTHLY_RE.test(String(r.name || "")));
  const windows = cycleRows.filter((r) => !monthly.includes(r));

  return {
    hasAnyCycle: cycleRows.length > 0,
    /** Rolling / weekly windows (+ monthly, which also gets its own row). */
    windows: [...windows, ...monthly],
    /**
     * Monthly rows are DUAL-CITIZEN, by the user's call: they count into the
     * additive pool bar and the big total (they are allowances that expire at
     * month end), AND they render as their own progress row under the pool. So
     * this list is consumed for the pool — it is not "excluded from the card".
     */
    monthly,
  };
}

/**
 * The cycle rows that get their own progress line under the pool bar, in
 * display order: the shorter windows first in upstream order (滚动 → 每周),
 * monthly LAST — the widest window anchors the block at the bottom.
 *
 * `giftPack` monthly rows are EXCLUDED — a provider's monthly *grant* (CodeBuddy
 * hands out a fresh credit pack each month) is not a plan window, so it belongs
 * only in the per-pack details, collapsed. Only a subscription's own monthly
 * window keeps a line. Both arrive spelled "Monthly", so `parseQuotaData` marks
 * the grant at the source; see the codebuddy-cn branch there.
 */
export function cycleRowLines(rows = []) {
  const { monthly, windows } = classifyCycleRows(rows);
  const planMonthly = monthly.filter((r) => r?.giftPack !== true);
  const nonMonthly = windows.filter((r) => !monthly.includes(r));
  return [...nonMonthly, ...planMonthly];
}

/**
 * A monthly GRANT (giftPack) whose balance is fully spent. Same rule as the
 * router's expiryExtractor giftPack exclusion (T0): a drained grant is a burned
 * asset, not headroom. Counting it in QuotaPackBar's pool inflated the
 * denominator — "30 / 130" where the 100 had nothing left (user-reported
 * CodeBuddy Intl card reading like 100 credits vanished). It stays visible in
 * the per-pack details (逐包明细); the card's pool just stops counting it.
 */
export function isDrainedGiftPack(row) {
  if (row?.giftPack !== true) return false;
  return percentOf(row) <= 0;
}

/**
 * Whether a row RESETS (cycle window) or EXPIRES (one-shot pack / balance).
 * One rule for every quota surface — the card and the per-pack table used to
 * disagree (the table defaulted a missing flag to recurring, the card read the
 * name), so the same Qoder row was blue in one place and green in the other.
 * An explicit `recurring: false` always wins.
 */
export function isResettingRow(row) {
  if (row?.recurring === false) return false;
  return isRecurringQuotaRow(row);
}

/** Below this share of its own ceiling a meter turns red, on every surface. */
export const CRITICAL_PCT = 10;

/**
 * The single colour rule for quota meters:
 *   "reset"    — a cycle window that refills (sky)
 *   "expire"   — a one-shot pack or balance that is spent down (green)
 *   "critical" — either kind with < CRITICAL_PCT left (red); an empty meter
 *                has no fill, so 0 is left to the kind colour's empty track.
 */
export function meterTone(row, pct = percentOf(row)) {
  if (pct > 0 && pct < CRITICAL_PCT) return "critical";
  return isResettingRow(row) ? "reset" : "expire";
}

/** ISO → "MM-DD" (local), "" when missing/invalid. The one date format on quota UI. */
export function shortDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * ISO → relative countdown, two units with precision following magnitude:
 * "2d 3h" at day scale, "5h 20m" under a day, "45m 30s" under an hour — a bare
 * date says nothing about a 5h rolling reset. "" when missing/invalid.
 */
export function shortDuration(iso, now = Date.now()) {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((t - now) / 1000));
  if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** remaining in the row's own unit, tolerant of the raw (`used`/`total`) shape. */
function remainingAmountOf(row) {
  if (Number.isFinite(row?.remainingNum)) return Number(row.remainingNum);
  return Math.max(0, Number(row?.total || 0) - Number(row?.used || 0));
}

/** A one-shot pack whose expiry has passed. */
export function isExpiredPack(row, now = Date.now()) {
  if (isResettingRow(row) || !row?.resetAt) return false;
  const t = new Date(row.resetAt).getTime();
  return Number.isFinite(t) && t <= now;
}

/**
 * History in the per-pack details: a ONE-SHOT pack that is used up or expired.
 * It can never come back, so it is folded away instead of paginated through
 * (CodeBuddy accounts carry dozens of spent 0/100 bonus packs). A cycle window
 * at 0 is NOT history — it refills at its reset, so it stays in view.
 * An unlimited row is never spent.
 */
export function isSpentPack(row, now = Date.now()) {
  if (row?.unlimited === true || isResettingRow(row)) return false;
  if (isExpiredPack(row, now)) return true;
  return Number(row?.total || 0) > 0 && remainingAmountOf(row) <= 0;
}

/**
 * A row that only restates others: a named total ("Total Points" / 总积分) or a
 * bucket whose breakdown ships alongside it (Qoder's `addOn` next to its
 * `detailOnly` packs). The card's big number already IS that total, so the
 * per-pack details list must not repeat it as its first row.
 */
export function isSummaryRow(row) {
  return isAggregateQuotaRow(row) || row?.summarizesDetail === true;
}

/** The rows the per-pack details (逐包明细) list — everything but summaries. */
export function detailRows(rows = []) {
  return (rows || []).filter((r) => r && typeof r === "object" && !isSummaryRow(r));
}

/**
 * Whether 逐包明细 would show anything the card above it does not.
 *
 * The card draws every cycle window as its own row (flat or nested) and a lone
 * pool as its headline, so on a subscription card (commandcode, mimo, opencode,
 * claude…) the details only re-listed the same rows. They carry information
 * only when rows were COLLAPSED into a total on the card:
 *   - an itemised breakdown (`detailOnly`, Qoder's packs)
 *   - a monthly grant kept off the cycle rows (`giftPack`, CodeBuddy)
 *   - two or more one-shot / stored-value rows (a pack family summed into the
 *     headline, or stepfun's 余额 + 代金券 collapsed to one)
 */
export function needsPerPackDetails(rows = []) {
  const list = detailRows(rows);
  if (list.some((r) => r.detailOnly === true || r.giftPack === true)) return true;
  return list.filter((r) => !isResettingRow(r)).length >= 2;
}

// "<family> · <window>" — antigravity names each window by its model family
// ("Gemini Models · 5h Window"). The separator is the upstream's own.
const FAMILY_WINDOW_RE = /^(.+?)\s+·\s+(.+)$/;

/** `"Gemini Models · 5h Window"` → `{ family, window }`; null for a plain name. */
export function splitFamilyWindow(name) {
  const m = FAMILY_WINDOW_RE.exec(String(name || "").trim());
  return m ? { family: m[1], window: m[2] } : null;
}

/**
 * Consecutive runs of rows sharing a family, in order. A family with windows
 * renders as ONE caption + its window rows, instead of repeating the family on
 * every line; plain rows come back as their own family-less group.
 */
export function groupRowsByFamily(rows = []) {
  const groups = [];
  for (const row of rows) {
    const split = splitFamilyWindow(row?.name);
    const family = split?.family || null;
    const last = groups[groups.length - 1];
    if (family && last && last.family === family) last.rows.push(row);
    else groups.push({ family, rows: [row] });
  }
  return groups;
}

// Health hue by remaining share — red → orange → amber → green → emerald.
// Piecewise-linear between stops so neighbouring percentages never jump colour.
const HEALTH_STOPS = [
  [0, 4],
  [15, 22],
  [35, 40],
  [65, 130],
  [100, 158],
];

/** HSL hue for a meter with `pct` (0–100) left. */
export function healthHue(pct) {
  const p = Math.min(100, Math.max(0, Number(pct) || 0));
  for (let i = 1; i < HEALTH_STOPS.length; i += 1) {
    const [p1, h1] = HEALTH_STOPS[i];
    if (p <= p1) {
      const [p0, h0] = HEALTH_STOPS[i - 1];
      return Math.round(h0 + ((h1 - h0) * (p - p0)) / (p1 - p0));
    }
  }
  return HEALTH_STOPS[HEALTH_STOPS.length - 1][1];
}
