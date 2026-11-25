/**
 * The clock half of quota reasoning — pure, dependency-free, no provider names.
 *
 * "When does this bucket next reset or expire" is answered on four surfaces
 * (relay account selection, the persisted `earliestPackageExpiry` column, the
 * quota card's countdown, and the hourglass sort). Each one used to write its
 * own `new Date(...).getTime()` plus its own guards, and they drifted: a card
 * header that dropped a drained-but-refilling window while the sort ranked by
 * it, a sentinel year honored in one place and not another, an unparseable date
 * becoming `NaN` and silently winning a `Math.min`. This file is the single
 * implementation of the *timing* rules; which bucket COUNTS as a candidate is a
 * policy decision and lives with the surface that makes it.
 *
 * Deliberately free of `src/` imports: `open-sse` must stay usable standalone,
 * and this is engine-side logic (routing reads it too).
 */

/**
 * Sentinel dates upstreams write for "never / permanent" (codebuddy and grok
 * hand back year-9999 stamps). Anything past this year is not a deadline.
 */
export const COUNTDOWN_SENTINEL_YEAR = 2099;

/**
 * A bucket's next reset/expiry as epoch ms, or `null` when there is nothing to
 * count down to.
 *
 * Accepts both field spellings — top-level quota buckets say `resetAt`, itemised
 * packs say `expiresAt` — and both value shapes (`Date` instances and strings),
 * because fetchers produce each. Rejects:
 *   - missing / empty values,
 *   - unparseable ones (a garbage string → `NaN`, which would poison a
 *     `Math.min` and compare false against everything),
 *   - sentinels past {@link COUNTDOWN_SENTINEL_YEAR} ("permanent"),
 *   - a time at or before `now`: a window whose reset already passed has
 *     refilled, and a one-shot pack past its date is gone. Neither is "about to
 *     happen" — ranking one first is what put expired 0-quota accounts at the
 *     top of the wall (2026-11-24 report). A stale date must never beat a live
 *     one, so it is `null` here rather than a past timestamp.
 */
export function quotaCountdownAt(row, now = Date.now()) {
  return quotaCountdownFromRaw(row?.resetAt ?? row?.expiresAt, now);
}

/**
 * {@link quotaCountdownAt} for a bare timestamp instead of a row — the surfaces
 * that rank on the persisted `earliestPackageExpiry` column (the connections API
 * `sort=expiring`, the relay's account order) hold a value, not a bucket, and
 * need the same three guards without re-writing them.
 */
export function quotaCountdownFromRaw(raw, now = Date.now()) {
  if (raw == null || raw === "") return null;
  const t = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
  if (!Number.isFinite(t)) return null;
  if (new Date(t).getFullYear() > COUNTDOWN_SENTINEL_YEAR) return null;
  return t > now ? t : null;
}

/** The row's own timestamp, in the shape it arrived in (never re-derived). */
export function quotaCountdownRaw(row) {
  return row?.resetAt ?? row?.expiresAt ?? null;
}

/**
 * The parse behind {@link quotaCountdownFromRaw}: a bucket's deadline as epoch ms,
 * or `null` when the bucket has NO usable date (missing, empty, unparseable, or a
 * year-past-2099 sentinel).
 *
 * Unlike `quotaCountdownFromRaw` this does NOT reject a date in the past — "does
 * this bucket have a deadline at all" is a different question from "is it still
 * ahead of us". A pack that expired yesterday HAS a deadline (it is spent, not
 * permanent), and conflating the two would make a dead pack look like a settled
 * balance, which the two surfaces reject for different reasons.
 */
export function quotaDeadlineTime(raw) {
  if (raw == null || raw === "") return null;
  const t = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
  if (!Number.isFinite(t)) return null;
  if (new Date(t).getFullYear() > COUNTDOWN_SENTINEL_YEAR) return null;
  return t;
}

/** A bucket with no deadline date is a BALANCE, not a window. */
export function isPerpetualBucket(row) {
  if (!row || row.isCreditBalance === true) return true;
  return quotaDeadlineTime(quotaCountdownRaw(row)) === null;
}

/**
 * Whether a bucket still has credit in it.
 *
 * Reads `remainingNum` (card-normalized), `remaining` (absolute credits) and
 * `remainingPercentage` (0–100) alike — every one of them means "drained" at
 * `<= 0`, so the unit difference is irrelevant. DRAINING is judged on ANY signal:
 * a bucket that reports `remaining: 0` next to a stale `remainingPercentage: 90`
 * is empty, and guessing which field is newer is not this layer's job. A bucket
 * with no numbers at all is NOT drained — an unknown must not silently drop a
 * real deadline.
 */
export function hasLiveRemaining(row) {
  if (row?.unlimited === true) return true;
  for (const key of ["remainingNum", "remaining", "remainingPercentage"]) {
    const v = row?.[key];
    if (v != null && Number.isFinite(Number(v)) && Number(v) <= 0) return false;
  }
  const total = Number(row?.totalNum ?? row?.total ?? 0);
  if (total > 0) return total - Number(row?.used ?? 0) > 0;
  return true;
}

/**
 * Whether a drained bucket comes back on its own (a window, not a burned pack),
 * from EXPLICIT flags only — a row's name is not visible at this layer.
 *
 *   - `recycles` is checked FIRST and beats `recurring: false`. Antigravity's
 *     per-model rows arrive with `recurring: false` (upstream never says it is a
 *     cycle) plus `recycles: true` written by the dashboard normalizer precisely
 *     because the resetAt DOES refill them — reading `recurring` first would drop
 *     a fully-burned account to a bare "0 / 1,000" card with no countdown, which
 *     is the bug the user reported on 2026-11-06.
 *   - then `recurring`: false means "it says Monthly but it is a pack that dies",
 *     true means a subscription window (MiMo weekly, MiniMax M Plan).
 *
 * `options.nameInferredCycles` is the caller's own "this name is a cycle window"
 * test — the display surface passes one, routing passes nothing (see
 * `COUNTDOWN_DISPLAY_RULES`: inferring a refill from a NAME could promote a
 * drained one-shot pack to "earliest", and relay would then burn an account that
 * has nothing left).
 */
export function refillsWhenDrained(row, { nameInferredCycles } = {}) {
  if (!row || typeof row !== "object") return false;
  if (row.recycles === true) return true;
  if (row.recurring === false) return false;
  if (row.recurring === true) return true;
  return typeof nameInferredCycles === "function" ? nameInferredCycles(row) === true : false;
}

/**
 * The candidate rule for "which bucket's date is the soonest one that matters".
 * ONE implementation, shared by relay/routing and the dashboard, with the
 * legitimate differences passed in as options:
 *
 *   - `isExcludedRow(row)` — a surface's own veto. Display passes its
 *     stored-value/summary-name tests (they need row NAMES, which this layer is
 *     deliberately free of); routing needs none.
 *   - `nameInferredCycles(row)` — see {@link refillsWhenDrained}.
 *   - `excludeDrainedGrants` (default true, the safe routing behaviour) — a
 *     `giftPack` / `summarizesDetail` bucket that is drained must not win the
 *     slot: CodeBuddy's monthly grant is `recurring + giftPack`, an additive
 *     credit pack that clears at month end, not a rate limit. Letting a drained
 *     one lead made every account report the identical month-end date and wedged
 *     multi-account dispatch. Display passes false — "每月 0/500, 5d 后重置" is
 *     exactly the countdown a card must show.
 *
 * The ordering is the contract:
 *   1. veto / `isCreditBalance` → out (a settled pool has no deadline);
 *   2. no date surviving {@link quotaCountdownAt} → out (permanent, past, junk);
 *   3. still has credit → IN, whatever it is;
 *   4. drained and does not refill → out: a 0-credit one-shot pack whose expiry
 *      is still ahead is a record, not a deadline (2026-11-24 report);
 *   5. drained and refills → in, subject to the grant rule.
 *
 * `unlimited` is NOT rejected here: routing has always let an unlimited window's
 * reset be the connection's earliest expiry, and this layer must not change what
 * the relay ranks on. The dashboard vetoes such rows through `isExcludedRow` —
 * a ceiling that never runs out has nothing to race the clock against.
 */
export function drivesEarliestExpiry(row, options = {}) {
  const {
    now = Date.now(),
    nameInferredCycles,
    excludeDrainedGrants = true,
    isExcludedRow,
  } = options || {};
  if (!row || typeof row !== "object") return false;
  if (typeof isExcludedRow === "function" && isExcludedRow(row)) return false;
  if (row.isCreditBalance === true) return false;
  if (quotaCountdownAt(row, now) === null) return false;
  if (hasLiveRemaining(row)) return true;
  if (!refillsWhenDrained(row, { nameInferredCycles })) return false;
  if (excludeDrainedGrants && (row.giftPack === true || row.summarizesDetail === true)) return false;
  return true;
}

/**
 * {@link drivesEarliestExpiry} + {@link quotaCountdownAt} over a list.
 *
 * @returns {{ time: number, row: Object, raw: string|Date }|null} — `raw` is the
 *   bucket's own timestamp in the shape it arrived in (never re-derived from
 *   `time`, so callers keep persisting the exact string upstream gave). Ties keep
 *   the FIRST row: the caller's order is its display order, so a headline cannot
 *   flicker between two equal dates.
 */
export function earliestExpiryBucket(rows = [], options = {}) {
  const { now = Date.now() } = options || {};
  let best = null;
  for (const row of rows || []) {
    if (!drivesEarliestExpiry(row, { ...options, now })) continue;
    const time = quotaCountdownAt(row, now);
    if (time === null) continue;
    if (best === null || time < best.time) {
      best = { time, row, raw: row.resetAt ?? row.expiresAt };
    }
  }
  return best;
}
