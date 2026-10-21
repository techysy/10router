// Next daily reset in a provider's natural timezone.
//
// Several providers hand out a daily pool that is refreshed (not accumulated)
// at local midnight. The expiry extractor needs a future timestamp to rank that
// account ahead of accounts whose credits expire days later; without one the
// daily pool is just another stored-value row.
//
// Chinese providers (Loomy / CodeArts) use UTC+8. The offset is explicit so a
// server running in another timezone calculates the same upstream boundary.

const HOUR_MS = 60 * 60 * 1000;

/**
 * @param {number} [nowMs]
 * @param {number} [offsetHours] provider's natural-day offset from UTC
 * @returns {number} epoch ms of the next midnight in that timezone
 */
export function nextDailyResetMs(nowMs = Date.now(), offsetHours = 8) {
  const shifted = new Date(nowMs + offsetHours * HOUR_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  shifted.setUTCDate(shifted.getUTCDate() + 1);
  return shifted.getTime() - offsetHours * HOUR_MS;
}

/** ISO form for the usage `resetAt` field. */
export function nextDailyResetIso(nowMs = Date.now(), offsetHours = 8) {
  return new Date(nextDailyResetMs(nowMs, offsetHours)).toISOString();
}
