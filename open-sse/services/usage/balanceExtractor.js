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
