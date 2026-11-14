"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { translate } from "@/i18n/runtime";
import { translateQuotaName } from "@/shared/utils/quotaName";
import {
  buildNestedCycle,
  classifyCycleRows,
  cycleRowLines,
  CRITICAL_PCT,
  isAggregateQuotaRow,
  isDrainedGiftPack,
  isRecurringQuotaRow,
  isResettingRow,
  groupRowsByFamily,
  isStoredValueRow,
  findDualSlotPair,
  joinsPackPool,
  meterTone,
  splitFamilyWindow,
  nameWithoutUnit,
  percentOf,
  quotaUnitOf,
} from "@/shared/utils/quotaRows";
import { cn } from "@/shared/utils/cn";
import QuotaMeter, {
  MeterTrack,
  METER_RADIUS,
  meterFill,
  meterSolid,
  TONE_TEXT,
  quotaDateWord,
} from "@/shared/components/QuotaMeter";

/**
 * Connection quota block — CreditDaddy account-card language (签到积分型).
 *
 * Aggregate half (additive pool only):
 *
 *   [✦✦] 2,455.33                    2,455.33 / 4,182
 *   [family: proportional segments | trailing used chunk]   ← 月度并入：
 *     它就是「以重置日为到期日的资源包」，不再单独成行
 *   15 个资源包（可用）        赠送包 21（55.33）到期 10-15
 *
 * Cycle half — 滚动 → 每周 → 月度, fixed order (monthly anchors the bottom),
 * each item ALWAYS two lines (name + numbers, then its own full-width bar):
 *
 *   [✦] 每周                       100 / 100 · 于 10-06 重置
 *   [==================== 100%]
 *
 * Stored-value rows (余额/代金券) are two-line too, but the right-hand side is a
 * single value with the unit as small print — they are settled balances that
 * always read X/X, so "X / Y" carried no information:
 *
 *   [✦] 余额                            14.95（CNY）
 *   [==================== 100%]
 *
 * SEMANTICS:
 *  - Aggregate summaries ("Total Points") are derived data — excluded from
 *    the chart; the expanded details show the ORIGINAL rows untouched.
 *  - Additive pool (签到积分型): only family packs, the monthly window (when a
 *    family coexists — its reset day acts as its expiry), and stored-value
 *    singletons sum into 余额. Rolling/weekly are limits, never additive, so
 *    they stay out of the pool total.
 *  - Stored-value singletons (余额/代金券) do not sum into 余额 as separate
 *    pools — identical-value ones are collapsed first (stepfun-cn).
 */

const MAX_SEGMENTS = 20;
// Fixed colour for the segmented pool bar — see renderPoolBar.
const POOL_GREEN = "hsl(142 60% 45%)";

/** CreditDaddy's `credit` icon — twin four-point sparkles (feather-style). */
function CreditIcon({ className }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
      <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />
    </svg>
  );
}

function fmt(n) {
  return Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** "{date} 重置" / "10-15 到期" — shared with the per-pack table (QuotaMeter). */
function dateWord(recurring, iso) {
  return quotaDateWord(recurring, iso);
}

function remainingOf(p) {
  if (p.remaining !== undefined && p.remaining !== null) return Math.max(0, Number(p.remaining));
  return Math.max(0, Number(p.total || 0) - Number(p.used || 0));
}



/**
 * One quota item — ALWAYS two lines, so every row on every card scans the same:
 *
 *   [✦] 每周                        5.96 / 6 · 于 10-06 重置
 *   [==================== 99.3%]
 *
 * `depth` indents nested cycle layers (see buildNestedCycle) and `widthPct`
 * carries the shared-measure width; at depth 0 it is a plain full-width row.
 *
 * Stored-value rows (`balance` 类) read the other way round — the AMOUNT is the
 * headline (large) with its unit as small print, and the label becomes the
 * small right-aligned caption. They have no denominator, so the bar encodes
 * only "has balance" (full, green) vs "empty" (empty, red):
 *
 *   14.95（CNY）                            余额
 *   [==================== 100%]
 */
/**
 * #Loomy dual-slot card —— 「永久积分 + 每日赠送积分」配对专用形态：
 *
 *   [✦] 20,560                        永久 16,560 · 每日 4,000/5,000
 *   [======== 永久槽 ========][=== 每日槽 ===]
 *   永久积分                              16,560
 *   [==================== 100%]
 *   每日赠送积分                          4,000 / 5,000
 *   [====== 80% ======]
 *
 * 大数 = 永久剩余 + 每日剩余（今天能花的总额）；段式轨道按两槽剩余占比
 * 分段（永久实心、每日亮绿），两槽明细行沿用 QuotaRow 既有形态。
 */
function DualSlotCard({ permanent, daily, className }) {
  const [expanded, setExpanded] = useState(false);
  const permRemaining = remainingOf(permanent);
  const dailyRemaining = remainingOf(daily);
  const permTotal = Number(permanent.total || 0);
  const dailyTotal = Number(daily.total || 0);
  const totalRemaining = permRemaining + dailyRemaining;
  const permShare = totalRemaining > 0 ? permRemaining / totalRemaining : 1;
  const dailyPct = dailyTotal > 0 ? (dailyRemaining / dailyTotal) * 100 : 0;
  const dailyCritical = dailyPct > 0 && dailyPct < CRITICAL_PCT;

  return (
    <div className={cn("min-w-0 space-y-2", className)}>
      {/* 大数总额 + 双槽小字（点行切换明细展开） */}
      <div className="flex cursor-pointer items-end justify-between gap-3" onClick={() => setExpanded((v) => !v)}>
        <span className="flex items-end gap-1.5 tabular-nums">
          <CreditIcon className="size-[12px] shrink-0 self-center text-primary" />
          <b className="text-[14px] font-bold leading-none text-text">{fmt(totalRemaining)}</b>
        </span>
        <span className="inline-flex shrink-0 items-baseline gap-3 text-[11px] leading-none tabular-nums text-text-muted">
          <span>永久 {fmt(permRemaining)}</span>
          <span className={dailyCritical ? "text-[color:var(--bad)]" : ""}>
            每日 {fmt(dailyRemaining)}/{fmt(dailyTotal)}
          </span>
        </span>
      </div>
      {/* 双槽段式轨道：永久槽 + 每日槽（剩余占比分段） */}
      <MeterTrack
        className="flex gap-[2px]"
        role="img"
        aria-label={`永久 ${fmt(permRemaining)}，每日 ${fmt(dailyRemaining)}/${fmt(dailyTotal)}`}
      >
        {permRemaining > 0 && (
          <span className="block h-full" style={{ flex: `${permShare.toFixed(4)} 1 0`, background: POOL_GREEN }} />
        )}
        {dailyRemaining > 0 && (
          <span className="block h-full" style={{ flex: `${(1 - permShare).toFixed(4)} 1 0`, background: dailyCritical ? meterSolid(0) : POOL_GREEN, opacity: 0.75 }} />
        )}
        {permRemaining === 0 && dailyRemaining === 0 && (
          <span className="block h-full w-full" />
        )}
      </MeterTrack>
      {/* 两槽明细行：默认收起（总额+双槽小字已表达全部信息），点总额行切换展开 */}
      {expanded && (
        <>
          <QuotaRow row={permanent} />
          <QuotaRow row={daily} />
        </>
      )}
    </div>
  );
}

function QuotaRow({ row, label = null, inset = false }) {
  const total = Number((row.totalNum ?? row.total) || 0);
  const remaining = Number.isFinite(row.remainingNum)
    ? Number(row.remainingNum)
    : Number(row.remaining ?? remainingOf(row));
  const stored = isStoredValueRow(row);
  const recurring = isResettingRow(row);

  if (stored) {
    const unit = quotaUnitOf(row.name);
    const hasBalance = remaining > 0;
    // Read-only daily check-in state pushed with the row (#77) — sits right
    // after the balance number, mirroring the connection-card badge position.
    const checkin = row.checkinToday === true;
    return (
      <div className="min-w-0 space-y-1">
        <div className="flex min-w-0 items-baseline justify-between gap-2 tabular-nums">
          <span className="flex min-w-0 items-baseline gap-1">
            <CreditIcon className="size-[11px] shrink-0 self-center text-text-muted" />
            <b className={cn("text-[12px] font-bold", hasBalance ? "text-text" : TONE_TEXT.critical)}>{fmt(remaining)}</b>
            {unit ? <span className="text-[10px] text-text-muted">（{unit}）</span> : null}
            {checkin && (
              <span className="ml-1 inline-flex shrink-0 items-center gap-0.5 rounded bg-green-500/10 px-1 py-px text-[10px] font-medium text-green-600 dark:text-green-400" style={{ transform: "translateY(-1px)" }}>
                <span className="material-symbols-outlined text-[11px]">check_circle</span>
                {translate("Checked in today")}
                {Number.isInteger(row.streakDays) && row.streakDays > 1 && (
                  <span className="text-text-muted">
                    {" · "}{translate("{count}-day streak").replace("{count}", String(row.streakDays))}
                  </span>
                )}
              </span>
            )}
          </span>
          <span className="shrink-0 text-[11px] text-text-muted">
            {translateQuotaName(nameWithoutUnit(row.name) || row.name)}
          </span>
        </div>
        {/* No denominator: the meter only says "has balance" (full) or "empty". */}
        <QuotaMeter pct={hasBalance ? 100 : 0} />
      </div>
    );
  }

  // Cycle rows keep the FULL name for the dictionary lookup — the parenthetical
  // is part of the key ("session (5h)" → 滚动). Stripping it silently produced
  // the raw English name on the card.
  const pct = percentOf(row);
  const tone = meterTone(row, pct);
  return (
    <div className={cn("min-w-0 space-y-1", inset && "pl-[17px]")}>
      <div className="flex min-w-0 items-center justify-between gap-2 text-[11px] tabular-nums">
        <span className="flex min-w-0 items-center gap-1.5">
          {inset ? null : <CreditIcon className="size-[11px] shrink-0 text-text-muted" />}
          <span className="truncate text-text-muted">{label ?? translateQuotaName(row.name)}</span>
        </span>
        <span className={cn("shrink-0", TONE_TEXT[tone])}>
          {/* percentScale rows are a 0–100 fraction the upstream reports, not a
              count — "53 / 100" read like 53 requests. Same as the details. */}
          {row.percentScale
            ? `${Math.round(pct)}%`
            : translate("remaining {remaining} of {total}")
                .replace("{remaining}", fmt(remaining))
                .replace("{total}", fmt(total))}
          {row.resetAt
            ? `　${dateWord(recurring, row.resetAt)}`
            : ""}
        </span>
      </div>
      <QuotaMeter pct={pct} />
    </div>
  );
}

/**
 * The nested cycle allowance as ONE bar, drawn concentrically.
 *
 * 滚动 ⊂ 每周 ⊂ 月度额度 are three scopes of the same USD allowance on one
 * scale (see buildNestedCycle), so they share a single track: the outermost
 * layer fills at full height, each inner layer sits INSIDE it — shorter and
 * stronger — so every layer's own fill is visible at once:
 *
 *   ✦ 月度额度                         9.69 / 10　10-29 重置
 *   [▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒ ]   ← 96.9%
 *   [▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓               ]      ← 每周 56.9%
 *   [██████████                            ]      ← 滚动 27.3%
 *     ■ 每周                            5.69 / 6　10-05 重置
 *     ■ 滚动                            2.73 / 3　09-30 重置
 *
 * The inner layers' lines carry a swatch in their band's colour, so each line
 * reads straight off the bar above it.
 */
// Same health colour as every other meter (meterFill, by each layer's OWN share
// left); the layers differ only in opacity and inset, outer → inner.
const BAND_OPACITY = [0.35, 0.65, 1];
// Only as tall as three layers need to stay distinguishable: 8 → 5.5 → 3px
// (a plain meter is 5px). The innermost band never gets thinner than 3px.
const TRACK_PX = 8;
const INNER_MIN_PX = 3;

function NestedCycleTrack({ ladder }) {
  const n = ladder.length;
  // Band i is inset by i * step on top and bottom; the innermost keeps INNER_MIN_PX.
  const step = (TRACK_PX - INNER_MIN_PX) / 2 / Math.max(1, n - 1);
  // Two layers skip the middle opacity so head and inner stay clearly apart.
  const opacity = (i) => (n === 2 ? BAND_OPACITY[i * 2] : BAND_OPACITY[i]);
  const tone = (i) => (ladder[i].ownPct > 0 && ladder[i].ownPct < CRITICAL_PCT ? "critical" : "reset");
  const textTone = (i) => TONE_TEXT[tone(i)];
  const head = ladder[0];

  return (
    <div className="min-w-0 space-y-1">
      <div className="flex min-w-0 items-center justify-between gap-2 text-[11px] tabular-nums">
        <span className="flex min-w-0 items-center gap-1.5">
          <CreditIcon className="size-[11px] shrink-0 text-text-muted" />
          <span className="truncate text-text-muted">{translateQuotaName(head.row.name || "")}</span>
        </span>
        <span className={cn("shrink-0", textTone(0))}>
          {translate("remaining {remaining} of {total}")
            .replace("{remaining}", fmt(head.ownRemaining))
            .replace("{total}", fmt(head.ownTotal))}
          {head.row.resetAt ? `　${dateWord(true, head.row.resetAt)}` : ""}
        </span>
      </div>

      <MeterTrack
        height={TRACK_PX}
        role="img"
        aria-label={ladder
          .map(({ row, ownRemaining, ownTotal }) =>
            `${translateQuotaName(row.name)} ${fmt(ownRemaining)}/${fmt(ownTotal)}`)
          .join("，")}
      >
        {ladder.map(({ row, widthPct, ownRemaining, ownTotal }, i) => (
          <span
            key={`${row.name || "band"}-${i}`}
            className={cn("absolute left-0", METER_RADIUS)}
            style={{
              top: `${i * step}px`,
              bottom: `${i * step}px`,
              width: `${widthPct}%`,
              opacity: opacity(i),
              ...meterFill(ladder[i].ownPct),
            }}
            title={`${translateQuotaName(row.name)} ${fmt(ownRemaining)} / ${fmt(ownTotal)}`}
          />
        ))}
      </MeterTrack>

      {ladder.slice(1).map(({ row, ownRemaining, ownTotal }, j) => (
        <div
          key={`${row.name || "layer"}-${j}`}
          className="flex min-w-0 items-center justify-between gap-2 text-[11px] tabular-nums"
          style={{ paddingLeft: `${(j + 1) * 10}px` }}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className="size-[8px] shrink-0 rounded-[2px]"
              style={{ opacity: opacity(j + 1), background: meterSolid(ladder[j + 1].ownPct) }}
              aria-hidden="true"
            />
            <span className="truncate text-text-muted">{translateQuotaName(row.name)}</span>
          </span>
          <span className={cn("shrink-0", textTone(j + 1))}>
            {translate("remaining {remaining} of {total}")
              .replace("{remaining}", fmt(ownRemaining))
              .replace("{total}", fmt(ownTotal))}
            {row.resetAt ? `　${dateWord(true, row.resetAt)}` : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

NestedCycleTrack.propTypes = {
  ladder: PropTypes.arrayOf(PropTypes.object).isRequired,
};

QuotaRow.propTypes = {
  row: PropTypes.shape({
    name: PropTypes.string,
    used: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    total: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    remaining: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    remainingNum: PropTypes.number,
    totalNum: PropTypes.number,
    resetAt: PropTypes.oneOfType([PropTypes.string, PropTypes.instanceOf(Date)]),
    recurring: PropTypes.bool,
  }),
};

export default function QuotaPackBar({ packs = [], className, nestedCycle = false }) {
  // `detailOnly` rows (Qoder's per-campaign packs) are a breakdown of a row the
  // card already charts — they exist for the per-pack table, never for the card.
  const rows = (packs || []).filter(
    (p) => p && typeof p === "object" && p.detailOnly !== true && !isAggregateQuotaRow(p)
  );
  if (rows.length === 0) return null;

  // The per-campaign breakdown of a charted total (Qoder's addOn packs). Never
  // summed — the total already counts them — but it is what the bar segments
  // and the pack-count line describe when the pool is that single total.
  const breakdown = (packs || [])
    .filter((p) => p && typeof p === "object" && p.detailOnly === true)
    .map((p) => ({ ...p, totalNum: Number(p.total || 0), remainingNum: remainingOf(p) }));

  const withNums = rows.map((p) => {
    const totalNum = Number(p.total || 0);
    return { ...p, totalNum, remainingNum: remainingOf(p) };
  });

  // #Loomy dual-slot：永久积分（储值）+ 每日赠送（滚动）同时在场 → 总额大数
  // 在外、内部双槽（永久槽 / 每日槽）双条。命中即短路返回，不走通用池逻辑
  // ——通用池会把 stored-value 与 recurring 拆成两张互不相干的形状。
  const dualSlot = findDualSlotPair(withNums);
  if (dualSlot) {
    return <DualSlotCard permanent={dualSlot.permanent} daily={dualSlot.daily} className={className} />;
  }

  // Cycle rows split two ways (see classifyCycleRows): MONTHLY rows are resource
  // packs that expire at month end (codebuddy / qoder), so they belong in the
  // additive pool; everything else recurring forms the nested 滚动⊂每周 ladder.
  // `nestedCycle` (experimental toggle) FORCES the ladder whenever a monthly
  // head and ≥2 real-amount layers exist, relaxing the strict-containment rule.
  const cycle = classifyCycleRows(withNums);
  const ladder = buildNestedCycle(withNums, { force: nestedCycle === true });
  // Rows that get their own line under the pool bar. Monthly is in here TOO —
  // it counts into the pool and the total, and still shows its own window row.
  // Rows drawn in the ladder are shown there ONCE — never again in the pool
  // headline, the pack-count line or the flat list (commandcode's 月度额度 used
  // to appear four times).
  const inLadder = new Set(ladder.map((l) => l.row));
  const cycleLines = cycleRowLines(withNums).filter((r) => !inLadder.has(r));

  // Non-recurring rows: same-base-name groups with ≥2 members are a pack
  // family; singletons are stored-value pools (余额/代金券) → their own rows.
  // Qoder-style 合集行「资源包」已在上游包含全部赠送包：存在时排除赠送包
  // 家族行，防止资源包 Credits 与赠送包被重复计数（用户实测重复）。
  // joinsPackPool, not a bare !isRecurringQuotaRow: a pushed stored-value
  // balance can arrive marked recurring (minimax-free's daily refill) and is
  // still a settled pool — excluding it here blanked the whole card.
  const hasCollectionRow = withNums.some((p) => String(p.name || "") === "资源包");
  const nonRecurring = withNums
    .filter((p) => joinsPackPool(p))
    .filter((p) => !(hasCollectionRow && String(p.name || "").startsWith("赠送包")));
  const groups = new Map();
  for (const p of nonRecurring) {
    const base = String(p.name || "").replace(/\s*\d+\s*$/, "").trim();
    if (!base) continue;
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(p);
  }
  const families = [...groups.entries()]
    .map(([base, members]) => {
      const totalNum = members.reduce((s, p) => s + p.totalNum, 0);
      const usedNum = members.reduce((s, p) => s + Number(p.used || 0), 0);
      const remainingNum = members.reduce((s, p) => s + p.remainingNum, 0);
      return { base, members, totalNum, usedNum, remainingNum, live: members.filter((p) => p.remainingNum > 0 && p.totalNum > 0) };
    })
    .filter((f) => f.members.length >= 2 && f.totalNum > 0);
  const familyMemberSet = new Set(families.flatMap((f) => f.members));
  // Monthly joins the additive pool beside a pack family, or if it is marked
  // as a giftPack / credit pool (e.g. CodeBuddy Intl with no bonus packs).
  // Alone without those flags, a monthly row is a subscription window (opencode-go),
  // not an additive spendable balance.
  // A DRAINED monthly grant (giftPack at 0) stops counting into the pool —
  // same rule the router's expiryExtractor applies for earliest-expiry (T0
  // sibling): it is a burned asset, and summing its total into the denominator
  // read "30 / 130" on CodeBuddy Intl cards whose 100 credits were gone. The
  // row itself still renders in the per-pack details (逐包明细).
  const monthlyPacks = cycle.monthly.filter(
    (r) =>
      !inLadder.has(r) &&
      !isDrainedGiftPack(r) &&
      (families.length > 0 || r.giftPack === true || r.displayRemaining === true)
  );
  // Stored-value singletons with IDENTICAL values are the same pool rendered
  // twice upstream (stepfun-cn: 余额(CNY) + 代金券(CNY) both 14.95/14.95) —
  // 去重，不累加（用户实测「其实是一个」）。
  const seenSig = new Set();
  const singletonPools = nonRecurring.filter((p) => {
    if (familyMemberSet.has(p)) return false;
    const sig = `${Number(p.used || 0)}|${Number(p.total || 0)}|${p.resetAt || ""}`;
    if (seenSig.has(sig)) return false;
    seenSig.add(sig);
    return true;
  });

  // Additive pool (签到积分型 + Qoder 系列积分): family packs + monthly resource
  // packs (月底到期的包 — 与 qoder 同理，计入总量) + stored-value singletons
  // (余额/代金券/套餐内 Credits——用户拍板：Qoder 也用同一逻辑，都是积分).
  // The 滚动/每周 ladder is a limit, not additive — it never joins the pool.
  const pool = [
    ...families.flatMap((f) => f.members),
    ...monthlyPacks,
    ...singletonPools,
  ];
  const poolTotal = pool.reduce((s, p) => s + p.totalNum, 0);
  const poolRemaining = pool.reduce((s, p) => s + p.remainingNum, 0);
  // A one-row pool is already fully described by the big aggregate line and the
  // When the pool collapses to ONE logical thing, its individual row must not be
  // re-listed underneath — the aggregate line above already is that row (Qoder:
  // 资源包; stepfun: 余额). The BAR still renders: it is the visual meter for that
  // same value, and dropping it removed the only progress indication on the card.
  //
  // Counts COLLAPSED families too: Qoder's `资源包` is a 2-member family shown as
  // a single aggregate row, so it counts as one.
  const poolRowCount = families.length + singletonPools.length + monthlyPacks.length;
  const isPoolFullyRepresented = poolRowCount <= 1;
  // A "settled balance" is a single stored-value pool: nothing decrements its
  // total, so `remaining / total` is always the full amount and printing it is
  // noise. True for stepfun's 余额/代金券; false for Qoder's 资源包 (a real
  // 100 / 900) and for any summing family.
  const poolIsSettledBalance =
    poolRowCount === 1 && pool.length > 0 && pool.every((p) => isStoredValueRow(p));
  // Currency/credit unit for the settled balance headline ("14.95（CNY）").
  // Taken from the pool row's name — the settled-balance path renders the
  // aggregate line rather than a QuotaRow, so it has to re-derive the unit
  // QuotaRow would otherwise read for itself.
  const poolUnit = poolIsSettledBalance ? quotaUnitOf(pool[0]?.name) : "";
  // 订阅窗折叠（2026-11-14 用户）：储值余额池 + 恰好一个滚动窗时，窗摘要并入
  // 大数右侧小字（「5,000　6d 3h后重置」），不再单独占一行 —— 正文只剩聚合条
  // 与逐包明细。多窗、或池本身不是储值余额（Qoder 家族等）维持原行：信息密度
  // 不允许折叠。
  const compactWindow =
    poolIsSettledBalance && cycleLines.length === 1 ? cycleLines[0] : null;

  // 原生包名展示修正：合集池「资源包」→「资源包 Credits」。
  const displayPackName = (name) => (name === "资源包" ? "资源包 Credits" : name);

  const hasFamily = families.length > 0;
  // A one-row pool that has an itemised breakdown is drawn and counted BY that
  // breakdown — the same segments + "N 个资源包" line a CodeBuddy card gets.
  const byBreakdown = isPoolFullyRepresented && breakdown.length > 0;
  const barPacks = byBreakdown ? breakdown : pool;
  // A pool whose rows carry an expiry is never the "one settled pool" shape —
  // it is packs that will run out, and the meta line's pack-count + nearest
  // expiry is real information. Without this guard, the drained-giftPack
  // exclusion collapsed CodeBuddy pools to a single family/row and the card
  // degraded to a bare name line ("赠送包 1") with no countdown at all
  // (2026-10-22 user report: 没有了 xxx 于多久过期).
  const poolHasExpiry = pool.some((p) => p.resetAt);

  const renderPoolBar = (poolPacks, poolTotal) => {
    const livePacks = poolPacks
      .filter((p) => p.remainingNum > 0 && p.totalNum > 0)
      .sort((a, b) => String(a.resetAt || "").localeCompare(String(b.resetAt || "")));
    let oneShotIdx = 0;
    const withAlpha = livePacks.map((p) => ({
      ...p,
      alpha: isResettingRow(p) ? 1 : Math.max(0.45, 0.85 - oneShotIdx++ * 0.05),
    }));
    let segments = withAlpha;
    if (withAlpha.length > MAX_SEGMENTS) {
      const kept = withAlpha.slice(0, MAX_SEGMENTS - 1);
      const rest = withAlpha.slice(MAX_SEGMENTS - 1);
      segments = [
        ...kept,
        {
          name: translate("{count} more packs").replace("{count}", String(rest.length)),
          remainingNum: rest.reduce((s, p) => s + p.remainingNum, 0),
          totalNum: rest.reduce((s, p) => s + p.totalNum, 0),
          resetAt: rest[0]?.resetAt || null,
          recurring: false,
          alpha: 0.6,
        },
      ];
    }
    const poolRemainingNum = poolPacks.reduce((s, p) => s + p.remainingNum, 0);
    // The spent part is the bare track (same as every meter), so the live
    // segments are followed by an empty spacer instead of a painted "used" chunk.
    const spentShare = poolTotal > 0 ? Math.max(0, 1 - poolRemainingNum / poolTotal) : 0;
    // The whole pool nearly gone → red, like any single meter under 10%.
    const poolPct = poolTotal > 0 ? (poolRemainingNum / poolTotal) * 100 : 0;
    // The segmented pool bar is the ONE meter without the health gradient: a
    // CodeBuddy pool is 15–26 packs, and re-colouring every segment by health
    // turned it into noise. One calm pack green; red only when the whole pool
    // is nearly gone, like any meter under CRITICAL_PCT.
    const poolColor = poolPct > 0 && poolPct < CRITICAL_PCT ? meterSolid(0) : POOL_GREEN;
    return (
      <MeterTrack
        className="flex gap-[2px]"
        role="img"
        aria-label={translate("{count} packs, remaining {remaining} of {total}")
          .replace("{count}", String(livePacks.length))
          .replace("{remaining}", fmt(poolRemainingNum))
          .replace("{total}", fmt(poolTotal))}
      >
        {segments.map((p, i) => {
          const share = poolTotal > 0 ? p.remainingNum / poolTotal : 0;
          const resets = isResettingRow(p);
          return (
            <span
              key={`${p.name || "pack"}-${i}`}
              className="block h-full min-w-[3px]"
              // One colour for the whole pool; the packs are told apart by
              // the 2px gaps and their stepped opacity.
              style={{ flex: `${share.toFixed(4)} 1 0`, opacity: p.alpha, background: poolColor }}
              title={[
                p.name || translate("Quota package"),
                `${translate("Remaining")} ${fmt(p.remainingNum)} / ${fmt(p.totalNum)}`,
                p.resetAt ? dateWord(resets, p.resetAt) : null,
              ].filter(Boolean).join("，")}
            />
          );
        })}
        {spentShare > 0 && (
          <span aria-hidden="true" className="block h-full" style={{ flex: `${spentShare.toFixed(4)} 1 0` }} />
        )}
      </MeterTrack>
    );
  };

  return (
    <div className={cn("min-w-0 space-y-2", className)}>
      {/* Line 1: 大号余额（无「剩余」二字）←→ X / 共 T。
          大字 14px（09-30 由 16px 调小，与 11px 正文拉开但不突兀），要求**底部对齐** ——
          小字（单位/分母）的盒底与大字的盒底齐平，不再是垂直居中的浮标。
          做法：整行 items-end，给大字加 leading-none 让它的盒子贴合字形
          （否则 `b` 的 line-box 高出字形，任何基线/底边对齐都会差半个行高）。 */}
      {pool.length > 0 && (
        <div className="flex items-end justify-between gap-3">
          <span className="flex items-end gap-1.5 tabular-nums">
            <CreditIcon className="size-[12px] shrink-0 self-center text-primary" />
            <b className="text-[14px] font-bold leading-none text-text">{fmt(poolRemaining)}</b>
            {poolUnit ? (
              <span className="text-[10px] leading-none text-text-muted">（{poolUnit}）</span>
            ) : null}
            {pool[0]?.checkinToday && (
              <span className="ml-1 inline-flex shrink-0 items-center gap-0.5 rounded bg-green-500/10 px-1 py-px text-[10px] font-medium text-green-600 dark:text-green-400" style={{ transform: "translateY(-1px)" }}>
                <span className="material-symbols-outlined text-[11px]">check_circle</span>
                {translate("Checked in today")}
                {Number.isInteger(pool[0].streakDays) && pool[0].streakDays > 1 && (
                  <span className="text-text-muted">
                    {" · "}{translate("{count}-day streak").replace("{count}", String(pool[0].streakDays))}
                  </span>
                )}
              </span>
            )}
          </span>
          {/* A settled balance has no denominator worth printing — `14.95 / 14.95`
              just reprinted the big number beside it. Everything else keeps it:
              a summing family (CodeBuddy's packs) and a single pool with a real
              denominator (Qoder 100 / 900, the number the bar below measures).
              A settled balance WITH exactly one recurring window (dumate: 余额 +
              订阅窗) puts that window's summary here instead — its own row
              below was the third repetition of the same two facts. */}
          {compactWindow ? (
            <span
              className={cn(
                "inline-flex shrink-0 items-baseline text-[11px] leading-none tabular-nums",
                TONE_TEXT[meterTone(compactWindow, percentOf(compactWindow))],
              )}
            >
              {fmt(compactWindow.remainingNum)}
              {"　"}
              {dateWord(isResettingRow(compactWindow), compactWindow.resetAt)}
            </span>
          ) : !poolIsSettledBalance ? (
            <span className="inline-flex shrink-0 items-baseline text-xs leading-none tabular-nums text-text-muted">
              {fmt(poolRemaining)} / {fmt(poolTotal)}
            </span>
          ) : null}
        </div>
      )}
      {/* Additive pool bar: family packs + monthly (月度并入聚合，不单独成行).
          Hidden when the pool is one settled balance — a "progress" bar over a
          value with no denominator says nothing, and it was the second of the
          two bars stepfun showed. */}
      {pool.length > 0 && renderPoolBar(barPacks, poolTotal)}

      {/* Qoder 系合集说明：资源包 Credits 已包含套餐内 Credits 等（用户要求同步标注） */}
      {hasCollectionRow && (
        <div className="text-[11px] text-text-muted">
          {translate("includes {names}").replace(
            "{names}",
            [...singletonPools.map((p) => translateQuotaName(displayPackName(p.name))), "资源包 Credits"].join("、")
          )}
        </div>
      )}

      {/* Meta line under the bar — every pool card has one, so a card never
          ends on a bare number + bar:
            - packs with an expiry → "N 个资源包（可用）  ✦ 55.33  10-15 到期"
            - packs without one    → just the count
            - one pool, no packs   → what the number IS ("资源包" / "余额") */}
      {pool.length > 0 && (() => {
        const live = barPacks.filter((p) => p.remainingNum > 0);
        const soonestLive = live
          .filter((p) => p.resetAt)
          .sort((a, b) => String(a.resetAt).localeCompare(String(b.resetAt)))[0] || null;
        // A settled balance keeps its name line even when a breakdown exists
        // (MiMo's 现金/赠送 legs fold into 逐包明细): "N 个资源包" copy is wrong
        // for a stored-value card — the name IS what the number is
        // ("现金余额：… · 赠送余额：…"). Pack-count copy stays for real pack
        // families (Qoder's Resource Package), and for ANY pool whose rows
        // carry an expiry — the countdown is information, never noise
        // (poolHasExpiry guard; see its comment above).
        const isSinglePool =
          isPoolFullyRepresented && !poolHasExpiry && (!byBreakdown || poolIsSettledBalance);
        if (isSinglePool) {
          return (
            <div className="text-[11px] text-text-muted">
              {translateQuotaName(nameWithoutUnit(displayPackName(pool[0].name)) || pool[0].name)}
            </div>
          );
        }
        // 全部耗尽但包会回收（antigravity 的窗口配额：烧完后在 resetAt 回血）
        // —— meta 行照常给出「已耗尽 + 何时重置」，否则卡片以裸「0 / 1,000」
        // 空条收尾，读起来像数据异常（2026-11-06 用户报告）。一次性烧断的包
        // （recycles !== true）维持原状：静默，由聚合行自己说话。
        if (live.length === 0) {
          const recycling = barPacks
            .filter((p) => p.recycles === true && p.resetAt)
            .sort((a, b) => String(a.resetAt).localeCompare(String(b.resetAt)))[0] || null;
          if (!recycling) return null;
          return (
            <div className="flex items-center justify-between gap-3 text-[11px] tabular-nums">
              <span className="text-text-muted">
                {translate("{count} resource packs (depleted)").replace("{count}", String(barPacks.length))}
              </span>
              <span className="inline-flex min-w-0 items-center gap-3 truncate text-text-muted">
                <span className="inline-flex shrink-0 items-center gap-1">
                  <CreditIcon className="size-[11px] shrink-0" />
                  0
                </span>
                <span className="shrink-0">
                  {dateWord(true, recycling.resetAt)}
                </span>
              </span>
            </div>
          );
        }
        return (
          <div className="flex items-center justify-between gap-3 text-[11px] tabular-nums">
            <span className="text-text-muted">
              {translate("{count} resource packs").replace("{count}", String(live.length))}
            </span>
            {soonestLive ? (
              <span className="inline-flex min-w-0 items-center gap-3 truncate text-text-muted">
                {/* No pack name: the credit icon + amount + expiry already say
                    which pack this is. */}
                <span className="inline-flex shrink-0 items-center gap-1">
                  <CreditIcon className="size-[11px] shrink-0" />
                  {fmt(soonestLive.remainingNum)}
                </span>
                <span className="shrink-0">
                  {dateWord(isResettingRow(soonestLive), soonestLive.resetAt)}
                </span>
              </span>
            ) : null}
          </div>
        );
      })()}

      {/* 储值类（余额/代金券/现金）：同样是「一项两行」，但右侧是单值 + 小字
          单位 —— 它们恒为 X/X，显示 "/ 总量" 没有信息量。 */}
      {/* Stored-value singletons (余额/代金券) get their own row. But when the
          pool is exactly ONE row (Qoder: just 资源包), that row IS what the big
          aggregate line + segmented bar above already show — rendering it again
          here printed the same "100 / 100" a second time and read as two
          separate quotas. Only render the individual rows when the pool holds
          more than one distinct thing (e.g. stepfun-cn's 余额 + 代金券). */}
      {singletonPools.length > 0 && !isPoolFullyRepresented && (
        <>
          {singletonPools.map((p, i) => (
            <QuotaRow key={`${p.name || "pool"}-${i}`} row={p} />
          ))}
        </>
      )}

      {/* Cycle rows. Two distinct shapes, decided by the DATA (see
          buildNestedCycle):

          - Contained chain (commandcode: 月度额度 ⊃ 每周 ⊃ 滚动) → a ladder,
            each layer indented under its parent and inset to its share, so it
            reads as "this much of the parent's allowance".
          - Independent windows (antigravity: a family's `5h Window` and
            `Weekly Window`, or mimo's lone Weekly) → no ladder; each renders as
            its own plain full-width bar. They measure different things and
            must not be stacked.

          `cycleLines` (not `cycle.windows`) is the flat list, because a MONTHLY
          row belongs in both places: it is summed into the pool bar above AND
          gets its own progress row here. */}
      {/* A real containment chain → ONE concentric track. Cycle rows the
          ladder did not take (a second weekly window, an hourly row) still
          render as their own plain bars below it — nothing may vanish. */}
      {ladder.length > 0 && <NestedCycleTrack ladder={ladder} />}
      {/* A family's windows (antigravity "Gemini Models · 5h Window") read as
          one caption + a row per window, not the family name on every line.
          compactWindow skips its single window here — it already lives beside
          the big number above. */}
      {(compactWindow ? [] : groupRowsByFamily(cycleLines)).map((group, gi) =>
        group.family ? (
          <div key={`${group.family}-${gi}`} className="min-w-0 space-y-1.5">
            <div className="flex min-w-0 items-center gap-1.5 text-[11px]">
              <CreditIcon className="size-[11px] shrink-0 text-text-muted" />
              <span className="truncate text-text">{translate(group.family)}</span>
            </div>
            {group.rows.map((row, i) => (
              <QuotaRow
                key={`${row.name || "win"}-${i}`}
                row={row}
                inset
                label={translate(splitFamilyWindow(row.name)?.window || row.name)}
              />
            ))}
          </div>
        ) : (
          group.rows.map((row, i) => <QuotaRow key={`${row.name || "win"}-${gi}-${i}`} row={row} />)
        )
      )}
    </div>
  );
}

QuotaPackBar.propTypes = {
  nestedCycle: PropTypes.bool,
  packs: PropTypes.arrayOf(
    PropTypes.shape({
      name: PropTypes.string,
      used: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
      total: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
      remaining: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
      resetAt: PropTypes.oneOfType([PropTypes.string, PropTypes.instanceOf(Date)]),
      recurring: PropTypes.bool,
    })
  ),
  className: PropTypes.string,
};
