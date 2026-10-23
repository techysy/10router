/**
 * Provider quota & scheduling category classification.
 *
 * Classifies providers into 5 distinct quota/scheduling models:
 *
 * 1. PACK_ASSET: Fixed one-shot resource packs that permanently expire (e.g. CodeBuddy, Qoder).
 *    Goal: Burn the soonest-expiring pack first, no Relay dead-burn lock, no pre-emptive 5% drop.
 *
 * 2. ROLLING_SUBSCRIPTION: Auto-refilling recurring windows (5h/7d) (e.g. Antigravity, GitHub, Codex, GLM).
 *    Goal: Single-point dead-burn with Relay forward handoff at 5% red zone to allow cyclic refill.
 *
 * 3. PURE_BALANCE: Pay-per-token or stored-value currency balances without fixed expiry (e.g. DeepSeek, StepFun, OpenAI).
 *    Goal: Priority order, Lowest-balance first (burn change/cleanup), Highest-balance first, or Round-Robin.
 *
 * 4. GATEWAY_FREE: Local loopback or credit daemon managed free proxies (zcode-free, minimax-free, trae-free).
 *    Goal: Managed automatically by gateway; no manual account sorting required.
 *
 * 5. GENERIC (Fallback): Safe default for unknown, custom, or newly added third-party providers.
 *    Renders standard full controls (Earliest Expiry First + Round Robin + Sticky) so no provider
 *    is ever rendered blank or missing functionality.
 */

export const PROVIDER_QUOTA_TYPES = {
  PACK_ASSET: "pack_asset",             // CodeBuddy, Qoder (discrete expiring packs)
  ROLLING_SUBSCRIPTION: "subscription", // Antigravity, GitHub, Codex, GLM, etc.
  PURE_BALANCE: "balance",              // DeepSeek, StepFun, OpenAI, Anthropic, etc.
  GATEWAY_FREE: "gateway_free",         // zcode-free, minimax-free, trae-free
  GENERIC: "generic",                   // Fallback for unknown / custom / third-party providers
};

const PACK_ASSET_PROVIDERS = new Set([
  "codebuddy-cn",
  "codebuddy-intl",
  "qoder",
  "qoder-cn",
]);

const ROLLING_SUBSCRIPTION_PROVIDERS = new Set([
  "antigravity",
  "github",
  "codex",
  "commandcode",
  "glm",
  "glm-cn",
  "minimax-code",
  "minimax-code-global",
]);

const PURE_BALANCE_PROVIDERS = new Set([
  "deepseek",
  "stepfun",
  "stepfun-cn",
  "openai",
  "anthropic",
  "minimax",
  "minimax-cn",
  "siliconflow-cn",
  "groq",
  "openrouter",
  "novita",
  "together",
  "fireworks",
  "nebius",
  "hyperbolic",
  "chutes",
  "cohere",
  "mistral",
  "river",
  "modelscope",
  "baidu",
  "kimi",
  "azure",
  "step_plan",
]);

const GATEWAY_FREE_PROVIDERS = new Set([
  "zcode-free",
  "minimax-free",
  "trae-free",
]);

/**
 * Returns the quota category for a given provider.
 * Guaranteed to return PROVIDER_QUOTA_TYPES.GENERIC if unknown, preventing blank UI.
 *
 * @param {string} providerId
 * @returns {"pack_asset"|"subscription"|"balance"|"gateway_free"|"generic"}
 */
export function getProviderQuotaCategory(providerId) {
  if (!providerId || typeof providerId !== "string") {
    return PROVIDER_QUOTA_TYPES.GENERIC;
  }
  const id = providerId.toLowerCase().trim();
  if (PACK_ASSET_PROVIDERS.has(id)) {
    return PROVIDER_QUOTA_TYPES.PACK_ASSET;
  }
  if (ROLLING_SUBSCRIPTION_PROVIDERS.has(id)) {
    return PROVIDER_QUOTA_TYPES.ROLLING_SUBSCRIPTION;
  }
  if (PURE_BALANCE_PROVIDERS.has(id)) {
    return PROVIDER_QUOTA_TYPES.PURE_BALANCE;
  }
  if (GATEWAY_FREE_PROVIDERS.has(id)) {
    return PROVIDER_QUOTA_TYPES.GATEWAY_FREE;
  }
  return PROVIDER_QUOTA_TYPES.GENERIC;
}
