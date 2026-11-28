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
  // MiniMax Code 的积分桶是一次性到期包（usage/minimax-code.js ledgerBucketRow:
  // detailOnly + recurring:false + 每桶自己的 expireAt），与 CodeBuddy/Qoder 同
  // 性质。此前误归 PURE_BALANCE：开「到期优先」时红区号被 relay 下沉到队尾，
  // 12-05 到期的包眼看烂掉还先烧 12-09 的（用户 2026-11-26「其他供应商优先
  // 测量也有问题」实测现网 minimax-code 三红一黄）。
  "minimax-code",
  "minimax-code-global",
]);

const ROLLING_SUBSCRIPTION_PROVIDERS = new Set([
  "antigravity",
  "github",
  "codex",
  "commandcode",
  "glm",
  "glm-cn",
]);

const PURE_BALANCE_PROVIDERS = new Set([
  "loomy",
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
  "together",
  "fireworks",
  "nebius",
  "hyperbolic",
  "chutes",
  "cohere",
  "mistral",
  "river",
  "modelscope",
  "oxion",
  "baidu",
  "kimi",
  "azure",
  "step_plan",
  // 积分/额度为可调度余额的供应商（用户 2026-11-22：Meoo 调度偏好要
  // 「大额优先/小额优先」）。余额由 extractConnectionBalance 从各自
  // usage payload 提取并持久化为 quotaBalance，排序消费它。
  "meoo",
  "qwenwork",
  "qwenwork-cn",
  // 2026-11-26 补齐同一类（用户「再看看其他供应商优先测量也有问题」「比如
  // quwork 也可以看下」）：以下供应商的 usage 都暴露一条**可路由的储值/积分
  // 余额行**（extractConnectionBalance 认得它 → quotaBalance 落库），却因归在
  // GENERIC 而在详情页**根本没有「大额/小额优先」这个选项**（GENERIC 分支只给
  // 到期优先/轮询/手动三档）。归类只放开这个入口，默认仍是手动优先级；
  // 「到期优先」的臂不受影响（earliestExpiryFirst 在排序与选择里都先判）。
  //   quwork     — 源码注释：行形态与 Meoo 积分池同款（储值池）
  //   dumate     — 「积分余额」isCreditBalance 行
  //   lingxi     — 智点余额汇总行 isCreditBalance（桶行仍走到期优先）
  //   deepai     — "Balance （Theos)" 行，注释写明 balanceExtractor claims it
  //   autoclaw   — 钱包合计行，注释写明 name starting with "Balance"
  //   clixad / freepi — 每日 credits 余额行 isCreditBalance
  "quwork",
  "dumate",
  "lingxi",
  "deepai",
  "autoclaw",
  "autoclaw-cn",
  "clixad",
  "freepi",
  // ⚠️ croli 曾**刻意不加**（其 usage 注释明确「never insert wallet credits into
  //  quotas」——钱包积分是账本奖励，不得成为路由信号）。2026-11-28 供应商下架，
  // 该例外失去对象，原断言随测试一并移除；此处保留一行说明，防止下轮又有人补进来。
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
