/**
 * Time-boxed "free promo" support for credit-metered provider models.
 *
 * A registry model may carry `promoFreeUntil` — an ISO date in **UTC** (e.g.
 * "2026-09-24") — alongside its normal `rateMultiplier`. While the window is
 * open the dashboard shows the same green `free` badge as a permanent
 * `rateMultiplier: 0`, and once it closes the badge falls back to the real
 * published multiplier on its own.
 *
 * Why not just write `rateMultiplier: 0` for the duration of the promo:
 *   1. `0` means "rides the free quota" — a lasting property. A dated promo
 *      written as `0` keeps claiming `free` after it ends and needs somebody to
 *      remember to change it back.
 *   2. It would also erase the published multiplier, which is what keeps the
 *      shared CN/intl credit table honest (the same id must carry the same
 *      multiplier on both gateways — asserted in
 *      tests/unit/codebuddy-intl-models.test.js).
 * Keeping the multiplier and the promo window as two separate facts avoids both.
 *
 * Semantics: the promo is active while `now < Date.parse(promoFreeUntil)`, so
 * the date is the first instant it is NO LONGER free (UTC midnight). A promo
 * covering all of 2026-09-24 is written "2026-09-25". An unparseable value is
 * treated as "no promo" rather than "free forever".
 */

/** @returns {number|null} epoch ms the promo ends, or null when there is none */
export function promoFreeUntilMs(model) {
  const raw = model?.promoFreeUntil;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/** @returns {boolean} true while the model's promo window is still open */
export function isPromoFree(model, now = Date.now()) {
  const until = promoFreeUntilMs(model);
  return until !== null && now < until;
}
