/**
 * Qualitative credit-consumption tier — pure and JSX-free so unit tests can
 * import it without the component tree (same posture as offPeak.js / promoFree.js).
 *
 * Some providers publish only a *tier* for what a model spends, not a number:
 * AutoClaw's desktop picker has a 「消耗」column reading 低 / 中 / 高, and its
 * catalog endpoint ships that string as `creditConsumptionLevel` next to the
 * numeric `creditCostFactor`. The two are separate facts and both are shown —
 * the number goes on the existing multiplier badge (`rateMultiplier`), the tier
 * on this one. Never derive one from the other: a provider may publish a tier
 * without a number (then only this badge appears), and the thresholds that map
 * AutoClaw's numbers onto 低/中/高 are upstream's own business, not ours.
 *
 * Registry rows carry the canonical English key (`creditLevel: "low"`); the
 * upstream's own wording is translated at the edge, not stored, so the table
 * stays locale-independent.
 */

// label = the English literal the i18n dictionaries key on; variant/icon follow
// the existing badge vocabulary in ModelRow (success / default / warning).
export const CREDIT_LEVEL_BADGES = {
  low: { label: "Low", variant: "success", icon: "savings" },
  medium: { label: "Medium", variant: "default", icon: "paid" },
  high: { label: "High", variant: "warning", icon: "local_fire_department" },
};

/** "low" → the badge spec; anything unrecognised → null (no badge, never a guess). */
export function creditLevelBadge(level) {
  if (typeof level !== "string") return null;
  return CREDIT_LEVEL_BADGES[level.trim().toLowerCase()] || null;
}
