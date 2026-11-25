/**
 * Extract numerical balance from a provider usage response.
 *
 * Looks for stored-value / credit / currency balance quota rows:
 *   - "Balance (CNY)", "Balance (USD)", "Balance"
 *   - "余额", "余额 (CNY)"
 *   - Quotas with isCreditBalance === true (e.g. MiniMax Code Credits)
 *
 * @param {object} usage - Return value of getUsageForProvider(connection)
 * @returns {number|null} Numerical balance or null if not found
 */
export function extractConnectionBalance(usage) {
  if (!usage || !usage.quotas || typeof usage.quotas !== "object") {
    return null;
  }
  const BALANCE_KEY_RE = /balance|voucher|cash|余额|代金券|现金|credit/i;
  let best = null;
  let bestPriority = -1;

  for (const [key, quota] of Object.entries(usage.quotas)) {
    if (!quota || typeof quota !== "object") continue;
    const isPrimaryName = /^balance|^余额/i.test(key.trim());
    const isCredit = quota.isCreditBalance === true;
    const isAnyBalance = BALANCE_KEY_RE.test(key) || isCredit;
    if (!isAnyBalance) continue;

    // Calculate value: remaining preferred over total - used over total
    let val = null;
    if (typeof quota.remaining === "number" && Number.isFinite(quota.remaining)) {
      val = quota.remaining;
    } else if (typeof quota.total === "number" && Number.isFinite(quota.total)) {
      const used = Number(quota.used) || 0;
      val = Math.max(0, quota.total - used);
    }
    if (val === null) continue;

    const prio = isPrimaryName ? 2 : (isCredit ? 1 : 0);
    if (prio > bestPriority) {
      bestPriority = prio;
      best = val;
    }
  }

  return best;
}

/**
 * Extract the account's daily-grant remaining + permanent balance as a pair
 * (#98-adjacent Loomy scheduling: burn the daily gift first, permanent last).
 *
 * Recognised rows:
 *   - "每日赠送积分" / "Daily Gift" — recurring daily grant (remaining = total - used)
 *   - isCreditBalance rows / 永久积分 — permanent stored balance
 *
 * @param {object} usage - Return value of getUsageForProvider(connection)
 * @returns {{ dailyRemaining: number, dailyTotal: number, permanent: number } | null}
 *          null when the provider exposes neither row.
 */
export function extractDailyGrantAndPermanent(usage) {
  if (!usage || !usage.quotas || typeof usage.quotas !== "object") {
    return null;
  }
  const DAILY_RE = /每日赠送|daily\s*gift|daily\s*grant|daily\s*bonus/i;
  const PERMANENT_RE = /永久|permanent|lifetime/i;

  let dailyRemaining = null;
  let dailyTotal = null;
  let permanent = null;

  for (const [key, quota] of Object.entries(usage.quotas)) {
    if (!quota || typeof quota !== "object") continue;
    const val = typeof quota.remaining === "number" && Number.isFinite(quota.remaining)
      ? quota.remaining
      : (typeof quota.total === "number" ? Math.max(0, quota.total - (Number(quota.used) || 0)) : null);
    if (val === null) continue;

    if (dailyRemaining === null && DAILY_RE.test(key)) {
      dailyRemaining = val;
      dailyTotal = typeof quota.total === "number" ? quota.total : null;
    } else if (permanent === null && (PERMANENT_RE.test(key) || quota.isCreditBalance === true)) {
      permanent = val;
    }
  }

  if (dailyRemaining === null && permanent === null) return null;
  return {
    dailyRemaining: dailyRemaining ?? 0,
    dailyTotal: dailyTotal ?? 0,
    permanent: permanent ?? 0,
  };
}
