/**
 * Amazon Quick model table — static by design.
 *
 * Quick has no model catalog endpoint and no per-model choice: the only
 * knob on the Chat operation is `performanceMode`, an enum the web UI
 * surfaces as three tiers （快 / 均衡 / 智能）. The gateway therefore
 * publishes exactly three tier models, one per enum value:
 *
 *   fast     → FAST      — Haiku / GPT Luna class (UI: 快）
 *   smart    → SMART     — Sonnet / GPT Terra class (UI: 均衡， upstream default)
 *   advanced → ADVANCED  — Opus / GPT Sol class (UI: 智能）
 *
 * Tier keys follow the QwenWork convention (short tier words as model
 * ids, the enum value kept alongside). Unlike QwenWork there is no
 * live catalog to merge and nothing is plan-gated, so this table is
 * the whole truth; resolveAmazonQuickModels exists so callers use the
 * same access shape as the other per-provider model services.
 */

export const AMAZONQUICK_TIERS = [
  { id: "fast", name: "Fast", performanceMode: "FAST" },
  { id: "smart", name: "Smart", performanceMode: "SMART" },
  { id: "advanced", name: "Advanced", performanceMode: "ADVANCED" },
];

/** Upstream default when the client never picked a tier. */
export const AMAZONQUICK_DEFAULT_TIER = "smart";

const TIER_BY_ID = new Map(AMAZONQUICK_TIERS.map((t) => [t.id, t]));

/**
 * Resolve a requested model id ("amazonquick/smart", "aq/fast", or a
 * bare tier) to its tier row. Unknown spellings fall back to the
 * upstream default tier (SMART) rather than failing — the upstream
 * itself defaults to SMART when no performanceMode is chosen.
 */
export function amazonQuickTierForModel(model) {
  const raw = String(model || "");
  const key = (raw.includes("/") ? raw.slice(raw.indexOf("/") + 1) : raw).trim().toLowerCase();
  return TIER_BY_ID.get(key) || TIER_BY_ID.get(AMAZONQUICK_DEFAULT_TIER);
}

export function amazonQuickPerformanceModeFor(model) {
  return amazonQuickTierForModel(model).performanceMode;
}

/** Static catalog for the model routes — same rows as the registry list. */
export function resolveAmazonQuickModels() {
  return AMAZONQUICK_TIERS.map((t) => ({ id: t.id, name: t.name }));
}
