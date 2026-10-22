/**
 * Red / yellow / green health of a SUBSCRIPTION account.
 *
 * A subscription is a set of rolling windows of different lengths (CodeBuddy's
 * monthly refill, Minimax's 1h50m window, Antigravity's 5h + weekly). Two of
 * them carry the whole signal, and they answer different questions:
 *
 *   SHORT window (fastest-resetting)  → "can this account serve a request NOW?"
 *   LONG window  (slowest-resetting)  → "how much is left of this account?"
 *
 * Reading only one of them is how an account gets drained to nothing while its
 * sibling sits idle: the short window refills constantly, so it always looks
 * healthy, and a single "remaining" number never says the overall allowance is
 * nearly gone. Antigravity already ran into this ("a 5h window can be
 * near-empty while a 7d reservoir still has days left — the 5h one is what
 * throttles throughput"); this is the same split, made explicit.
 *
 * Windows are ranked by RESET PERIOD, not by quota size: period is what makes
 * a subscription a subscription.
 */
export const RED_ZONE_PCT = 5;
export const YELLOW_ZONE_PCT = 20;

// A bucket with no reset date never refills — it is a balance (River's USD,
// MiniMax Code's Credits), not a window. Balances are spent LAST: they are the
// fallback that must survive every subscription cycle. They are excluded from
// both colour selection and the earliest-expiry ordering.
function isPerpetual(quota) {
  if (!quota || quota.isCreditBalance === true) return true;
  const raw = quota.resetAt ?? quota.expiresAt;
  if (raw == null || raw === "") return true;
  const t = new Date(raw).getTime();
  // Sentinel "year 9999" dates mean permanent (same rule used below).
  return !Number.isFinite(t) || new Date(t).getFullYear() > 2099;
}

// Reset period in ms, used to rank windows. A one-shot pack's "period" is
// however long it has left — it does not refill, so sooner-expiring = more
// urgent, which lands it naturally at the short end.
function windowLength(quota, resetTime, now) {
  if (quota.recurring === true && typeof quota.periodMs === "number" && quota.periodMs > 0) {
    return quota.periodMs;
  }
  if (quota.recurring === true) {
    // Rolling window with no declared cadence: treat the time until the next
    // reset as the cycle length. A refreshed window has a full period ahead.
    return Math.max(1, resetTime - now);
  }
  // One-shot: everything it has left is its remaining life.
  return Math.max(1, resetTime - now);
}

/**
 * Colour a window's remaining percentage.
 * @returns {"red"|"yellow"|"green"}
 */
export function quotaZone(remainingPct) {
  if (typeof remainingPct !== "number" || !Number.isFinite(remainingPct)) return "green";
  if (remainingPct < RED_ZONE_PCT) return "red";
  if (remainingPct < YELLOW_ZONE_PCT) return "yellow";
  return "green";
}

const ZONE_RANK = { green: 0, yellow: 1, red: 2 };

/**
 * Combined colour of the two windows: the WORSE of them.
 *
 * A short window that just refilled to 100% says "I can serve right now", not
 * "this account has quota left". When the long window is at 0% the account is
 * spent for the cycle — the fresh short window only means the next burst is
 * allowed to start, and every request sent there burns a round trip before
 * upstream refuses. Colouring on the short window alone would paint that
 * account green and let the relay keep hammering it.
 *
 * @returns {"red"|"yellow"|"green"}
 */
export function combineZones(shortZone, longZone) {
  const a = ZONE_RANK[shortZone] ?? 0;
  const b = ZONE_RANK[longZone] ?? 0;
  return a >= b ? (shortZone || "green") : (longZone || "green");
}

// Main-allowance windows only. A one-shot bonus pack is EXTRA quota stacked on
// top of the subscription: it expiring says nothing about whether the
// subscription itself is spent, and letting it win the "long window" slot would
// report a healthy subscription as exhausted. Packs still count when the
// account has no recurring window at all (a pure credit account).
function eligibleForWindows(quota) {
  return quota?.recurring === true;
}

/**
 * Extract earliest-expiring available quota package from usage payload.
 *
 * Scans `usage.quotas` across all packages (and, for buckets that itemise a
 * `packs[]` breakdown, across their LIVE packs — see below), skips exhausted
 * one-shot packages (used >= total or remaining <= 0) and summary aggregates
 * ("Total Points"), and returns the soonest future expiry timestamp/ISO string.
 * Exhausted RECURRING windows (recurring:true) are kept — their next reset time
 * is the point of the badge even (especially) when the window is drained.
 *
 * Alongside the expiry it reports the SUBSCRIPTION health split:
 *
 *   remainingPercentage  — backwards-compatible alias of `shortRemainingPct`
 *                          (this used to be "smallest of all buckets")
 *   shortRemainingPct    — fastest-resetting window; drives relay red-zone
 *   longRemainingPct     — slowest-resetting window; account's overall headroom
 *   zone / longZone      — red|yellow|green for each
 *   windowCount          — how many timed windows fed the two signals
 *
 * Balances (no reset date) feed none of them — see isPerpetual().
 *
 * @param {Object} usage
 * @returns {{
 *   expiry: string|null, name: string|null, timestamp: number|null,
 *   remainingPercentage?: number, shortRemainingPct?: number|null,
 *   longRemainingPct?: number|null, zone?: string, longZone?: string,
 *   windowCount?: number
 * } | null}
 */
export function extractEarliestPackageExpiry(usage) {
  if (!usage || typeof usage !== "object" || !usage.quotas) return null;

  const now = Date.now();
  let earliestTime = Infinity;
  let earliestName = null;
  let earliestIso = null;
  let minRemaining = Infinity;

  // Window split. `shortest`/`longest` hold the extreme of each end, so one
  // pass over the buckets yields both signals without keeping the whole list.
  // `fallback*` takes the same extremes restricted to one-shot packs, used only
  // when the account exposes no recurring window at all.
  const shortest = { period: Infinity, remaining: null };
  const longest = { period: -Infinity, remaining: null };
  const fallbackShort = { period: Infinity, remaining: null };
  const fallbackLong = { period: -Infinity, remaining: null };
  let windowCount = 0;
  let recurringCount = 0;

  // One candidate package — a top-level quota bucket, or one itemised pack
  // inside a bucket. Updates the running "earliest live expiry" and the
  // "most-constrained live remaining" signals.
  const consider = (label, pkg) => {
    if (!pkg || typeof pkg !== "object") return;

    // Packs carry `expiresAt`, top-level buckets carry `resetAt` — accept both.
    const resetRaw = pkg.resetAt ?? pkg.expiresAt;
    const resetTime = resetRaw ? new Date(resetRaw).getTime() : NaN;
    const hasReset = Number.isFinite(resetTime);
    // Sentinel dates (year 9999) mean "permanent" — same as having no date.
    const isFuture = hasReset && resetTime > now && new Date(resetTime).getFullYear() <= 2099;

    // A RECURRING window (recurring:true, e.g. MiMo weekly / MiniMax Code M Plan /
    // Antigravity 5h+7d) resets instead of dying: when it's drained, the upcoming
    // reset time is exactly the information the badge exists to show.
    //
    // However, when a recurring pack is marked `giftPack: true` (e.g. CodeBuddy CN's
    // Monthly refill allowance alongside multiple bonus packs): it is an additive
    // quota package, NOT a rate limit. When its cycle balance is 100% drained
    // (used >= total or remaining <= 0), it must NOT hijack the earliest expiry
    // timestamp over unconsumed bonus packs! Doing so makes every account report
    // the identical month-end reset date and wedges multi-account earliest-expiry
    // dispatch.
    const isExhausted = () => {
      const used = Number(pkg.used ?? 0);
      const total = Number(pkg.total ?? 0);
      if (total > 0 && used >= total) return true;
      if (pkg.remaining !== undefined && Number(pkg.remaining) <= 0) return true;
      if (pkg.remainingPercentage !== undefined && Number(pkg.remainingPercentage) <= 0) return true;
      return false;
    };

    if (pkg.recurring !== true || pkg.giftPack === true) {
      if (isExhausted()) return;
    }
    // A row whose reset date exists but is NOT a live future time is spent
    // (one-shot expired) or mid-refill (recurring past its mark) — it has no
    // countable future at all, and its stale `remaining` must not feed the
    // relay red-zone either.
    if (hasReset && !isFuture) return;

    const remaining = liveRemainingPercentage(pkg);

    // Fed into the earliest-expiry ordering? Balances no — a USD/Credits
    // remainder has no deadline, and letting it into the sort would make
    // "spend the soonest-expiring quota first" pick a balance as soonest.
    const perpetual = isPerpetual(pkg);
    if (!perpetual && isFuture && resetTime < earliestTime) {
      earliestTime = resetTime;
      earliestName = label;
      earliestIso = resetRaw instanceof Date ? resetRaw.toISOString() : String(resetRaw);
    }

    // Subscription window split (see RED_ZONE_PCT). Only timed windows take
    // part — balances have no cycle to rank and must not colour the account.
    if (perpetual || !isFuture || remaining === null) return;
    windowCount++;
    const period = windowLength(pkg, resetTime, now);
    if (eligibleForWindows(pkg)) {
      recurringCount++;
      if (period < shortest.period) {
        shortest.period = period;
        shortest.remaining = remaining;
      }
      if (period > longest.period) {
        longest.period = period;
        longest.remaining = remaining;
      }
    } else {
      if (period < fallbackShort.period) {
        fallbackShort.period = period;
        fallbackShort.remaining = remaining;
      }
      if (period > fallbackLong.period) {
        fallbackLong.period = period;
        fallbackLong.remaining = remaining;
      }
    }
    // Kept for the legacy field only; no longer the red-zone signal.
    if (remaining < minRemaining) minRemaining = remaining;
  };

  for (const [name, quota] of Object.entries(usage.quotas)) {
    if (!quota || typeof quota !== "object") continue;

    // Skip aggregate / summary rows that don't represent a real package
    const lowerName = name.toLowerCase();
    if (
      lowerName.includes("total") ||
      lowerName.includes("aggregate") ||
      lowerName.includes("summary")
    ) {
      continue;
    }

    // A bucket that itemises its packs (Qoder's addOn) is only their sum: the
    // pack list is the authoritative detail ("detail replaces aggregate" — the
    // same rule the dashboard cards follow). Rank on the packs, never on the
    // bucket-level resetAt, which producers derive from the soonest pack
    // *including drained ones*. The per-pack `consider` call applies the same
    // live/exhausted rules, so a fully drained pack list contributes nothing.
    if (Array.isArray(quota.packs) && quota.packs.length > 0) {
      for (const pack of quota.packs) {
        consider(pack?.name ? `${name} · ${pack.name}` : name, pack);
      }
      continue;
    }

    consider(name, quota);
  }

  if (earliestTime < Infinity || Number.isFinite(minRemaining) || windowCount > 0) {
    // Prefer recurring subscription windows; fall back to one-shot packs only
    // for accounts that have no subscription window at all.
    const useRecurring = recurringCount > 0;
    const shortSrc = useRecurring ? shortest : fallbackShort;
    const longSrc = useRecurring ? longest : fallbackLong;
    const shortPct = shortSrc.remaining;
    const longPct = longSrc.remaining;
    const shortZone = shortPct === null ? null : quotaZone(shortPct);
    const longZone = longPct === null ? null : quotaZone(longPct);

    return {
      expiry: earliestIso,
      name: earliestName,
      timestamp: earliestTime < Infinity ? earliestTime : null,
      // Legacy alias: this used to be "smallest remaining across ALL buckets".
      // Callers that only want "is the account nearly spent" should read
      // shortRemainingPct / zone instead.
      ...(Number.isFinite(minRemaining) ? { remainingPercentage: minRemaining } : {}),
      shortRemainingPct: shortPct,
      longRemainingPct: longPct,
      shortZone,
      longZone,
      // The colour that decides routing: the worse of the two windows. A
      // refilled short window over an exhausted long one is still spent.
      zone: shortZone === null && longZone === null ? null : combineZones(shortZone, longZone),
      windowCount,
      recurringWindowCount: recurringCount,
      windowSource: useRecurring ? "recurring" : "packs",
    };
  }

  return null;
}

/**
 * Remaining-percentage of a live bucket, from the fields the usage handlers
 * populate. Prefers an explicit remainingPercentage; derives from used/total
 * otherwise. Returns null when neither is available (caller treats it as
 * "unknown" and does not pre-emptively switch).
 */
function liveRemainingPercentage(quota) {
  // A stored-value balance (MiniMax Code's Credits) has no denominator:
  // used/total would always read 100% and lie about headroom, so it never
  // feeds the percentage red-zone. A zero balance is already filtered by the
  // liveness check above (remaining <= 0 ⇒ account drops out of the ring);
  // a positive one is "healthy until upstream says otherwise".
  if (quota.isCreditBalance === true) return null;
  if (typeof quota.remainingPercentage === "number" && Number.isFinite(quota.remainingPercentage)) {
    return quota.remainingPercentage;
  }
  const used = Number(quota.used ?? 0);
  const total = Number(quota.total ?? 0);
  if (total > 0) {
    return Math.max(0, (total - used) / total) * 100;
  }
  if (typeof quota.remaining === "number" && Number.isFinite(quota.remaining)) {
    return quota.remaining;
  }
  return null;
}
