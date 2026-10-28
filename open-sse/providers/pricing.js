// Pricing rates for AI models — all rates in $/1M tokens
//
// Fallback order (first match wins):
//   1. PROVIDER_PRICING[provider][model]  — provider-specific override
//   2. FREE_MODEL_NAMESPACES               — upstream bills these at $0
//   3. MODEL_PRICING[model]               — canonical model price (provider-agnostic)
//   4. PATTERN_PRICING                    — glob pattern match (e.g. "codex-*")

/**
 * Namespaces upstream meters at $0. A free model must never inherit a paid
 * rate: the vendor-prefix strip in getPricingForModel() would turn
 * "cline-free/deepseek-v4.1-flash" into "deepseek-v4.1-flash" and match
 * MODEL_PRICING, so the namespace is checked before both fallbacks.
 */
export const FREE_MODEL_NAMESPACES = ["cline-free/"];

export const ZERO_PRICING = {
  input: 0, output: 0, cached: 0, reasoning: 0, cache_creation: 0,
};

/** True when the model id sits in a namespace upstream bills at $0. */
export function isFreeModel(model) {
  if (!model) return false;
  const lower = String(model).toLowerCase();
  return FREE_MODEL_NAMESPACES.some((ns) => lower.startsWith(ns));
}

/**
 * Canonical model pricing — provider-agnostic.
 * Cover all known models; deduplicated across providers.
 */
export const MODEL_PRICING = {
  // === Anthropic / Claude ===
  "claude-opus-5-5":              { input: 4.00,  output: 20.00, cached: 0.20,  reasoning: 20.00,  cache_creation: 5.00  },
  "claude-opus-5-5-thinking":     { input: 4.00,  output: 20.00, cached: 0.20,  reasoning: 20.00,  cache_creation: 5.00  },
  "claude-opus-5-5-high":         { input: 4.00,  output: 20.00, cached: 0.20,  reasoning: 20.00,  cache_creation: 5.00  },
  "claude-opus-5-5-medium":       { input: 4.00,  output: 20.00, cached: 0.20,  reasoning: 20.00,  cache_creation: 5.00  },
  "claude-opus-5-5-low":          { input: 4.00,  output: 20.00, cached: 0.20,  reasoning: 20.00,  cache_creation: 5.00  },
  "claude-opus-4-6":              { input: 5.00,  output: 25.00, cached: 0.50,  reasoning: 25.00,  cache_creation: 6.25  },
  "claude-opus-4-5-20251101":     { input: 5.00,  output: 25.00, cached: 0.50,  reasoning: 25.00,  cache_creation: 6.25  },
  "claude-sonnet-5-5":            { input: 2.00,  output: 10.00, cached: 0.10,  reasoning: 10.00,  cache_creation: 2.50  },
  "claude-sonnet-5-5-thinking":   { input: 2.00,  output: 10.00, cached: 0.10,  reasoning: 10.00,  cache_creation: 2.50  },
  "claude-sonnet-5-5-high":       { input: 2.00,  output: 10.00, cached: 0.10,  reasoning: 10.00,  cache_creation: 2.50  },
  "claude-sonnet-5-5-medium":     { input: 2.00,  output: 10.00, cached: 0.10,  reasoning: 10.00,  cache_creation: 2.50  },
  "claude-sonnet-5-5-low":        { input: 2.00,  output: 10.00, cached: 0.10,  reasoning: 10.00,  cache_creation: 2.50  },
  "claude-sonnet-4-6":            { input: 3.00,  output: 15.00, cached: 0.30,  reasoning: 15.00,  cache_creation: 3.75  },
  "claude-sonnet-4-5-20250929":   { input: 3.00,  output: 15.00, cached: 0.30,  reasoning: 15.00,  cache_creation: 3.75  },
  "claude-haiku-4-5-20251001":    { input: 1.00,  output: 5.00,  cached: 0.10,  reasoning: 5.00,   cache_creation: 1.25  },
  "claude-sonnet-4-20250514":     { input: 3.00,  output: 15.00, cached: 1.50,  reasoning: 15.00,  cache_creation: 3.00  },
  "claude-opus-4-20250514":       { input: 15.00, output: 25.00, cached: 7.50,  reasoning: 112.50, cache_creation: 15.00 },
  "claude-3-5-sonnet-20241022":   { input: 3.00,  output: 15.00, cached: 1.50,  reasoning: 15.00,  cache_creation: 3.00  },
  "claude-haiku-4.5":             { input: 0.50,  output: 2.50,  cached: 0.05,  reasoning: 3.75,   cache_creation: 0.50  },
  "claude-opus-4.1":              { input: 5.00,  output: 25.00, cached: 0.50,  reasoning: 37.50,  cache_creation: 5.00  },
  "claude-opus-4.5":              { input: 5.00,  output: 25.00, cached: 0.50,  reasoning: 37.50,  cache_creation: 5.00  },
  "claude-opus-4.6":              { input: 5.00,  output: 25.00, cached: 0.50,  reasoning: 37.50,  cache_creation: 5.00  },
  "claude-sonnet-4":              { input: 3.00,  output: 15.00, cached: 0.30,  reasoning: 22.50,  cache_creation: 3.00  },
  "claude-sonnet-4.5":            { input: 3.00,  output: 15.00, cached: 0.30,  reasoning: 22.50,  cache_creation: 3.00  },
  "claude-sonnet-4.6":            { input: 3.00,  output: 15.00, cached: 0.30,  reasoning: 22.50,  cache_creation: 3.00  },
  "claude-opus-4-5-thinking":     { input: 5.00,  output: 25.00, cached: 0.50,  reasoning: 37.50,  cache_creation: 5.00  },
  "claude-opus-4-6-thinking":     { input: 5.00,  output: 25.00, cached: 0.50,  reasoning: 37.50,  cache_creation: 5.00  },
  "claude-fable-5":               { input: 10.00, output: 50.00, cached: 1.00,  reasoning: 50.00,  cache_creation: 12.50 },

  // === OpenAI / GPT ===
  "gpt-3.5-turbo":                { input: 0.50,  output: 1.50,  cached: 0.25,  reasoning: 2.25,   cache_creation: 0.50  },
  "gpt-4":                        { input: 2.50,  output: 10.00, cached: 1.25,  reasoning: 15.00,  cache_creation: 2.50  },
  "gpt-4-turbo":                  { input: 10.00, output: 30.00, cached: 5.00,  reasoning: 45.00,  cache_creation: 10.00 },
  "gpt-4o":                       { input: 2.50,  output: 10.00, cached: 1.25,  reasoning: 15.00,  cache_creation: 2.50  },
  "gpt-4o-mini":                  { input: 0.15,  output: 0.60,  cached: 0.075, reasoning: 0.90,   cache_creation: 0.15  },
  "gpt-4.1":                      { input: 2.50,  output: 10.00, cached: 1.25,  reasoning: 15.00,  cache_creation: 2.50  },
  "gpt-5":                        { input: 1.25,  output: 10.00, cached: 0.625, reasoning: 10.00,  cache_creation: 1.25  },
  "gpt-5-mini":                   { input: 0.25,  output: 2.00,  cached: 0.125, reasoning: 2.00,   cache_creation: 0.25  },
  "gpt-5-codex":                  { input: 1.25,  output: 10.00, cached: 0.625, reasoning: 10.00,  cache_creation: 1.25  },
  "gpt-5.1":                      { input: 1.25,  output: 10.00, cached: 0.625, reasoning: 10.00,  cache_creation: 1.25  },
  "gpt-5.1-codex":                { input: 1.25,  output: 10.00, cached: 0.625, reasoning: 10.00,  cache_creation: 1.25  },
  "gpt-5.1-codex-mini":           { input: 1.50,  output: 6.00,  cached: 0.75,  reasoning: 9.00,   cache_creation: 1.50  },
  "gpt-5.1-codex-mini-high":      { input: 2.00,  output: 8.00,  cached: 1.00,  reasoning: 12.00,  cache_creation: 2.00  },
  "gpt-5.1-codex-max":            { input: 8.00,  output: 32.00, cached: 4.00,  reasoning: 48.00,  cache_creation: 8.00  },
  "gpt-5.2":                      { input: 1.75,  output: 14.00, cached: 0.175, reasoning: 14.00,  cache_creation: 1.75  },
  "gpt-5.2-codex":                { input: 1.75,  output: 14.00, cached: 0.175, reasoning: 14.00,  cache_creation: 1.75  },
  "gpt-5.3-codex":                { input: 1.75,  output: 14.00, cached: 0.175, reasoning: 14.00,  cache_creation: 1.75  },
  "gpt-5.3-codex-spark":         { input: 3.00,  output: 12.00, cached: 0.30,  reasoning: 12.00,  cache_creation: 3.00  },
  "gpt-5.6":                      { input: 2.50,  output: 15.00, cached: 0.25,  reasoning: 15.00,  cache_creation: 2.50  },
  "gpt-5.6-luna":                 { input: 1.00,  output: 6.00,  cached: 0.10,  reasoning: 6.00,   cache_creation: 1.00  },
  "gpt-5.6-terra":                { input: 2.50,  output: 15.00, cached: 0.25,  reasoning: 15.00,  cache_creation: 2.50  },
  "gpt-5.6-sol":                  { input: 5.00,  output: 30.00, cached: 0.50,  reasoning: 30.00,  cache_creation: 5.00  },
  // OpenAI Standard 短上下文官方价（developers.openai.com/api/docs/pricing）。
  // 长上下文档更贵，但本表一模型只存一档价（上游 92c7bdd5 / dec820b9 同口径）。
  "gpt-6-astra":                  { input: 10.00, output: 50.00, cached: 1.00,  reasoning: 50.00,  cache_creation: 12.50 },
  "gpt-6.1-sol":                  { input: 2.00,  output: 10.00, cached: 0.10,  reasoning: 10.00,  cache_creation: 2.50  },
  "gpt-6.1-terra":                { input: 1.00,  output: 5.00,  cached: 0.05,  reasoning: 5.00,   cache_creation: 1.25  },
  "gpt-6-sol":                    { input: 2.00,  output: 10.00, cached: 0.20,  reasoning: 10.00,  cache_creation: 2.50  },
  "gpt-6-luna":                   { input: 0.10,  output: 0.50,  cached: 0.01,  reasoning: 0.50,   cache_creation: 0.125 },
  "o1":                           { input: 15.00, output: 60.00, cached: 7.50,  reasoning: 90.00,  cache_creation: 15.00 },
  "o1-mini":                      { input: 3.00,  output: 12.00, cached: 1.50,  reasoning: 18.00,  cache_creation: 3.00  },

  // === Gemini ===
  // Gemini 4 "Argon" (2026-09-30). Input/output confirmed via Artificial
  // Analysis. cached / reasoning / cache_creation are not published yet, so
  // they are left off rather than guessed: entries are returned verbatim, and
  // a fabricated 0 there would silently mis-bill cached and reasoning tokens.
  "gemini-4-argon":                 { input: 2.00,  output: 10.00 },
  "gemini-3.8-flash":              { input: 1.50,  output: 7.50,  cached: 0.15,  reasoning: 11.25,  cache_creation: 1.875 },
  "gemini-3.8-flash-high":         { input: 1.50,  output: 7.50,  cached: 0.15,  reasoning: 11.25,  cache_creation: 1.875 },
  "gemini-3.8-flash-medium":       { input: 1.50,  output: 7.50,  cached: 0.15,  reasoning: 11.25,  cache_creation: 1.875 },
  "gemini-3.8-flash-low":          { input: 1.50,  output: 7.50,  cached: 0.15,  reasoning: 11.25,  cache_creation: 1.875 },
  "gemini-3.7-flash":              { input: 1.50,  output: 7.50,  cached: 0.15,  reasoning: 11.25,  cache_creation: 1.875 },
  "gemini-3.7-flash-high":         { input: 1.50,  output: 7.50,  cached: 0.15,  reasoning: 11.25,  cache_creation: 1.875 },
  "gemini-3.7-flash-medium":       { input: 1.50,  output: 7.50,  cached: 0.15,  reasoning: 11.25,  cache_creation: 1.875 },
  "gemini-3.7-flash-low":          { input: 1.50,  output: 7.50,  cached: 0.15,  reasoning: 11.25,  cache_creation: 1.875 },
  "gemini-3.6-flash":              { input: 1.50,  output: 7.50,  cached: 0.15,  reasoning: 11.25,  cache_creation: 1.875 },
  "gemini-3.6-flash-high":         { input: 1.50,  output: 7.50,  cached: 0.15,  reasoning: 11.25,  cache_creation: 1.875 },
  "gemini-3.6-flash-medium":       { input: 1.50,  output: 7.50,  cached: 0.15,  reasoning: 11.25,  cache_creation: 1.875 },
  "gemini-3.6-flash-low":          { input: 1.50,  output: 7.50,  cached: 0.15,  reasoning: 11.25,  cache_creation: 1.875 },
  "gemini-3.5-flash-lite":         { input: 0.30,  output: 2.50,  cached: 0.03,  reasoning: 3.75,   cache_creation: 0.375 },
  "gemini-3.5-flash-high":         { input: 0.50,  output: 3.00,  cached: 0.03,  reasoning: 4.50,   cache_creation: 0.50  },
  "gemini-3-flash-preview":        { input: 0.50,  output: 3.00,  cached: 0.03,  reasoning: 4.50,   cache_creation: 0.50  },
  "gemini-3-pro-preview":         { input: 2.00,  output: 12.00, cached: 0.25,  reasoning: 18.00,  cache_creation: 2.00  },
  "gemini-3.1-pro-low":           { input: 2.00,  output: 12.00, cached: 0.25,  reasoning: 18.00,  cache_creation: 2.00  },
  "gemini-3.1-pro-high":          { input: 4.00,  output: 18.00, cached: 0.50,  reasoning: 27.00,  cache_creation: 4.00  },
  "gemini-pro-agent":             { input: 4.00,  output: 18.00, cached: 0.50,  reasoning: 27.00,  cache_creation: 4.00  },
  "gemini-3-flash-agent":         { input: 0.50,  output: 3.00,  cached: 0.03,  reasoning: 4.50,   cache_creation: 0.50  },
  "gemini-3.5-flash-low":         { input: 0.50,  output: 3.00,  cached: 0.03,  reasoning: 4.50,   cache_creation: 0.50  },
  "gemini-3.5-flash-extra-low":   { input: 0.50,  output: 3.00,  cached: 0.03,  reasoning: 4.50,   cache_creation: 0.50  },
  "gemini-3-flash":               { input: 0.50,  output: 3.00,  cached: 0.03,  reasoning: 4.50,   cache_creation: 0.50  },
  "gemini-2.5-pro":               { input: 2.00,  output: 12.00, cached: 0.25,  reasoning: 18.00,  cache_creation: 2.00  },
  "gemini-2.5-flash":             { input: 0.30,  output: 2.50,  cached: 0.03,  reasoning: 3.75,   cache_creation: 0.30  },
  "gemini-2.5-flash-lite":        { input: 0.15,  output: 1.25,  cached: 0.015, reasoning: 1.875,  cache_creation: 0.15  },

  // === Qwen ===
  // Source: Alibaba Cloud Model Studio「Model inference pricing」(intl, USD/1M tokens),
  // fetched 2026-09-24. Base-tier prices (flagship tiers have no tiering; Plus/
  // Flash long-context tiers, where they exist, are 2-3× — same convention as the
  // other tiered entries here). cached / cache_creation follow that doc's explicit
  // cache: hit = 10% of input, creation = 125% of input. reasoning = thinking-mode
  // output where the table separates it (qwen-plus legacy).
  "qwen3.8-max":                  { input: 2.00,  output: 6.00,  cached: 0.20,  reasoning: 6.00,   cache_creation: 2.50  },
  "qwen3.8-max-0902":             { input: 2.00,  output: 6.00,  cached: 0.20,  reasoning: 6.00,   cache_creation: 2.50  },
  "qwen3.7-max":                  { input: 2.50,  output: 7.50,  cached: 0.25,  reasoning: 7.50,   cache_creation: 3.13  },
  "qwen3.7-max-2026-05-20":       { input: 2.50,  output: 7.50,  cached: 0.25,  reasoning: 7.50,   cache_creation: 3.13  },
  "qwen3.7-plus":                 { input: 0.40,  output: 1.60,  cached: 0.04,  reasoning: 1.60,   cache_creation: 0.50  },
  "qwen3.6-plus":                 { input: 0.50,  output: 3.00,  cached: 0.05,  reasoning: 3.00,   cache_creation: 0.63  },
  "qwen3.5-plus":                 { input: 0.40,  output: 2.40,  cached: 0.04,  reasoning: 2.40,   cache_creation: 0.50  },
  "qwen-plus":                    { input: 0.40,  output: 1.20,  cached: 0.04,  reasoning: 4.00,   cache_creation: 0.50  },
  "qwen3.8-flash":                { input: 0.15,  output: 0.47,  cached: 0.015, reasoning: 0.47,   cache_creation: 0.19  },
  "qwen3.6-flash":                { input: 0.25,  output: 1.50,  cached: 0.025, reasoning: 1.50,   cache_creation: 0.31  },
  "qwen3.5-flash":                { input: 0.10,  output: 0.40,  cached: 0.01,  reasoning: 0.40,   cache_creation: 0.13  },
  "qwen-flash":                   { input: 0.05,  output: 0.40,  cached: 0.005, reasoning: 0.40,   cache_creation: 0.06  },
  // 已知边界：qwen3.5-omni-plus / qwen3.8-omni-* 按模态分段计价（文本/音频/图像各异），
  // 平铺 {input,output} 会系统性算错 → 刻意保持无价（audit-pricing 豁免表注明），
  // 宁可 $0 + 可解释，不要一个看着可信的错数。qwen3.8-flash-next 是 opencode-go
  // 渠道别名、无官方价目，同样豁免。
  "qwen3-coder-plus":             { input: 1.00,  output: 4.00,  cached: 0.50,  reasoning: 6.00,   cache_creation: 1.00  },
  "qwen3-coder-flash":            { input: 0.50,  output: 2.00,  cached: 0.25,  reasoning: 3.00,   cache_creation: 0.50  },

  // === Kimi ===
  // Official platform.kimi.ai: cache-hit / cache-miss / output per 1M tokens
  "kimi-k3":                      { input: 3.00,  output: 15.00, cached: 0.30,  reasoning: 15.00,  cache_creation: 3.00  },
  "k3":                           { input: 3.00,  output: 15.00, cached: 0.30,  reasoning: 15.00,  cache_creation: 3.00  },
  "kimi-k3.1-pro":                { input: 2.00,  output: 10.00, cached: 0.20,  reasoning: 10.00,  cache_creation: 2.00  },
  "kimi-k2.7-code":               { input: 0.95,  output: 4.00,  cached: 0.19,  reasoning: 4.00,   cache_creation: 0.95  },
  "kimi-k2.7-code-highspeed":     { input: 1.90,  output: 8.00,  cached: 0.38,  reasoning: 8.00,   cache_creation: 1.90  },
  "kimi-for-coding":              { input: 0.95,  output: 4.00,  cached: 0.19,  reasoning: 4.00,   cache_creation: 0.95  },
  "kimi-for-coding-highspeed":    { input: 1.90,  output: 8.00,  cached: 0.38,  reasoning: 8.00,   cache_creation: 1.90  },
  "kimi-k2":                      { input: 1.00,  output: 4.00,  cached: 0.50,  reasoning: 6.00,   cache_creation: 1.00  },
  "kimi-k2-thinking":             { input: 1.50,  output: 6.00,  cached: 0.75,  reasoning: 9.00,   cache_creation: 1.50  },
  // kimi-k2.5 rows: retired by Moonshot 2026-08-31; kept for third-party
  // gateways (codebuddy/bai/tokenrouter/cloudflare/…) serving their own copy.
  "kimi-k2.5":                    { input: 1.20,  output: 4.80,  cached: 0.60,  reasoning: 7.20,   cache_creation: 1.20  },
  "kimi-k2.5-thinking":           { input: 1.80,  output: 7.20,  cached: 0.90,  reasoning: 10.80,  cache_creation: 1.80  },
  "kimi-k2.6":                    { input: 1.00,  output: 4.00,  cached: 0.50,  reasoning: 6.00,   cache_creation: 1.00  },
  "kimi-latest":                  { input: 1.00,  output: 4.00,  cached: 0.50,  reasoning: 6.00,   cache_creation: 1.00  },

  // === DeepSeek ===
  "deepseek-chat":                { input: 0.14,  output: 0.28,  cached: 0.0028, reasoning: 0.28,   cache_creation: 0.14  },
  "deepseek-reasoner":            { input: 0.14,  output: 0.28,  cached: 0.0028, reasoning: 0.28,   cache_creation: 0.14  },
  "deepseek-r1":                  { input: 0.14,  output: 0.28,  cached: 0.0028, reasoning: 0.28,   cache_creation: 0.14  },
  "deepseek-v3.2-chat":           { input: 0.14,  output: 0.28,  cached: 0.0028, reasoning: 0.28,   cache_creation: 0.14  },
  "deepseek-v3.2-reasoner":       { input: 0.14,  output: 0.28,  cached: 0.0028, reasoning: 0.28,   cache_creation: 0.14  },
  "deepseek-v4-flash":            { input: 0.14,  output: 0.28,  cached: 0.0028, reasoning: 0.28,   cache_creation: 0.14  },
  "deepseek-v4-pro":              { input: 0.435, output: 0.87,  cached: 0.003625, reasoning: 0.87,  cache_creation: 0.435 },
  // 第一方 DeepSeek（2026-10-20 models.dev deepseek 条目核对）：v4-flash 0.15/0.6、
  // v4-pro 0.66/1.98。canonical 行保持旧值不动——它同时被 bai / baidu / apinex /
  // alitp-intl / blackbox 等转售商复用，改它会把这些渠道的成本一起改错；第一方的
  // 真实价放在下方 PROVIDER_PRICING.deepseek 里覆盖。
  "deepseek-flash":               { input: 0.15,  output: 0.60,  cached: 0.003,  reasoning: 0.60,   cache_creation: 0.15  },
  "deepseek-v4-flash-vision-exp": { input: 0.15,  output: 0.60,  cached: 0.003,  reasoning: 0.60,   cache_creation: 0.15  },

  // === GLM ===
  "glm-4.6":                      { input: 0.50,  output: 2.00,  cached: 0.25,  reasoning: 3.00,   cache_creation: 0.50  },
  "glm-4.6v":                     { input: 0.75,  output: 3.00,  cached: 0.375, reasoning: 4.50,   cache_creation: 0.75  },
  "glm-4.7":                      { input: 0.75,  output: 3.00,  cached: 0.375, reasoning: 4.50,   cache_creation: 0.75  },
  "glm-5":                        { input: 1.00,  output: 4.00,  cached: 0.50,  reasoning: 6.00,   cache_creation: 1.00  },

  // === MiniMax ===
  // M3.1-Flash（2026-10 正式版）：models.dev 的 minimax / minimax-cn 条目一致报
  // $0.15 / $0.6、cache_read $0.015（USD/1M tok），比 M3 的 0.30/1.20 便宜一半。
  // 大小写与命名空间两种拼写都列，否则用量成本会落到 `minimax-*` 通配价（0.50/2.00）。
  "MiniMax-M3.1-Flash":           { input: 0.15,  output: 0.60,  cached: 0.015, reasoning: 0.90,   cache_creation: 0.15  },
  "minimax-m3.1-flash":           { input: 0.15,  output: 0.60,  cached: 0.015, reasoning: 0.90,   cache_creation: 0.15  },
  "MiniMax-M3":                   { input: 0.30,  output: 1.20,  cached: 0.06,  reasoning: 1.80,   cache_creation: 0.30  },
  "MiniMax-M2.1":                 { input: 0.50,  output: 2.00,  cached: 0.25,  reasoning: 3.00,   cache_creation: 0.50  },
  "MiniMax-M2.5":                 { input: 0.50,  output: 2.00,  cached: 0.25,  reasoning: 3.00,   cache_creation: 0.50  },
  "MiniMax-M2.7":                 { input: 0.50,  output: 2.00,  cached: 0.25,  reasoning: 3.00,   cache_creation: 0.50  },
  "minimax-m2.1":                 { input: 0.50,  output: 2.00,  cached: 0.25,  reasoning: 3.00,   cache_creation: 0.50  },
  "minimax-m2.5":                 { input: 0.60,  output: 2.40,  cached: 0.30,  reasoning: 3.60,   cache_creation: 0.60  },

  // === Grok ===
  "grok-code-fast-1":             { input: 0.50,  output: 2.00,  cached: 0.25,  reasoning: 3.00,   cache_creation: 0.50  },

  // === Muse (Meta Model API) ===
  // 价格取自 https://dev.meta.ai/docs/pricing-rate-limits（contributor 档更
  // 便宜，代价是 Meta 可用数据训练）；数值录入自上游 decolua/9router 28809807。
  "muse-spark-1.3":                { input: 1.25, output: 4.25, cached: 0.15,  reasoning: 4.25,   cache_creation: 0 },
  "muse-spark-1.2":                { input: 1.25, output: 4.25, cached: 0.15,  reasoning: 4.25,   cache_creation: 0 },
  "muse-spark-1.1":                { input: 1.25, output: 4.25, cached: 0.15,  reasoning: 4.25,   cache_creation: 0 },
  "muse-spark-1.3-contributor":    { input: 0.10, output: 0.20, cached: 0.002, reasoning: 0.20,   cache_creation: 0 },
  "muse-spark-1.2-contributor":    { input: 0.10, output: 0.20, cached: 0.002, reasoning: 0.20,   cache_creation: 0 },

  // === Xiaomi MiMo ===
  // Official price page (mimo.mi.com/static/docs/price/pay-as-you-go.md, fetched
  // 2026-09-22), overseas table — this file is $/1M tokens, and the page's
  // domestic table is RMB, so the USD column is the one that belongs here.
  // First-party ids are bare (`mimo-v2.6-pro`) on both xiaomi-mimo and
  // xiaomi-tokenplan, so one canonical entry prices both cards; resellers that
  // prefix their ids (`xiaomi/mimo-…`) keep their own PROVIDER_PRICING rows.
  // Until now no first-party MiMo model had any price at all — getPricingForModel
  // returned null for mimo-v2.5-pro too — so usage against these cards reported
  // no cost. The retiring V2.5 pair is deliberately NOT backfilled: the page
  // prices v2.5-pro with v2.6-pro and v2.5 with v2.6-flash, but adding them now
  // would start reporting costs for historical usage that never showed one.
  // reasoning == output: upstream bills thinking tokens as output
  // (max_completion_tokens covers thinking + answer together).
  //
  // These are pay-as-you-go rates. They also resolve for xiaomi-tokenplan (same
  // bare ids), but Token Plan is a flat Credits subscription — $6/$16/$50/$100
  // per month for Lite/Standard/Pro/Max — so a cost shown against a tp-
  // connection is a pay-as-you-go equivalent, not what that user was charged.
  "mimo-v2.6-pro":                { input: 0.435, output: 0.87,  cached: 0.0036, reasoning: 0.87  },
  // Token Plan 的 Claude 原生变体：upstreamModelId 就是 mimo-v2.6-pro，费率必须相同。
  // 显式建行与 capabilities.js 同理 —— 缺了它，该 id 既无按量估价（成本恒 $0），
  // 也逃不开别处的通配兜底拿错价。
  "mimo-v2.6-pro-claude":         { input: 0.435, output: 0.87,  cached: 0.0036, reasoning: 0.87  },
  "mimo-v2.6-flash":              { input: 0.14,  output: 0.28,  cached: 0.0028, reasoning: 0.28  },
  // 定制服务 upstream (contact sales). The cloud + Token Plan cards list it so a
  // contracted user gets it out of the box; a key without the contract just errors.
  // Real-time rates — Batch API is exactly half of these, and ultraspeed does not
  // support Batch at all.
  "mimo-v2.6-pro-ultraspeed":     { input: 4.35,  output: 8.70,  cached: 0.036,  reasoning: 8.70  },

  // === OpenRouter fallback ===
  "auto":                         { input: 2.00,  output: 8.00,  cached: 1.00,  reasoning: 12.00,  cache_creation: 2.00  },

  // === Misc ===
  "oswe-vscode-prime":            { input: 1.00,  output: 4.00,  cached: 0.50,  reasoning: 6.00,   cache_creation: 1.00  },
  "gpt-oss-120b-medium":          { input: 0.50,  output: 2.00,  cached: 0.25,  reasoning: 3.00,   cache_creation: 0.50  },
  "vision-model":                 { input: 1.50,  output: 6.00,  cached: 0.75,  reasoning: 9.00,   cache_creation: 1.50  },
  "coder-model":                  { input: 1.50,  output: 6.00,  cached: 0.75,  reasoning: 9.00,   cache_creation: 1.50  },
};

/**
 * Provider-specific pricing overrides.
 * Only include entries where price DIFFERS from MODEL_PRICING.
 * Keyed by provider alias (cc, cx, gc, gh, ...) or provider id (openai, anthropic, ...).
 */
export const PROVIDER_PRICING = {
  // DeepSeek 第一方官方价（2026-10-20 models.dev `deepseek` provider 条目）。
  // 只覆盖第一方连接；同名的转售商行（bai / baidu / apinex / blackbox /
  // alitp-intl / clinepass）继续走 canonical MODEL_PRICING，不受影响。
  deepseek: {
    "deepseek-v4-flash": { input: 0.15, output: 0.6, cached: 0.003, reasoning: 0.6 },
    "deepseek-v4-pro": { input: 0.66, output: 1.98, cached: 0.022, reasoning: 1.98 },
    "deepseek-chat": { input: 0.14, output: 0.28, cached: 0.0028, reasoning: 0.28 },
    "deepseek-reasoner": { input: 0.14, output: 0.28, cached: 0.0028, reasoning: 0.28 },
  },
  // GitHub Copilot (gh) — explicit override, matches canonical gpt-5.3-codex rate
  gh: {
    "gpt-5.3-codex": { input: 1.75, output: 14.00, cached: 0.175, reasoning: 14.00, cache_creation: 1.75 },
  },
  // SiliconFlow 中国区 (issue #19-3) — 官方价目 ¥/1M ÷ 7.15 → $/1M
  // (https://siliconflow.cn/pricing, 2026-09-16)。key 用 SF 原始 id(含 org 前缀、
  // 原大小写)——查不到的长尾模型由用户侧「导入 /models」目录 + 手工定价覆盖。
  "siliconflow-cn": {
    "deepseek-ai/DeepSeek-V3.2": { input: 0.56, output: 0.85, cached: 0.06, reasoning: 0.85 },
    "deepseek-ai/DeepSeek-V4-Pro": { input: 1.68, output: 3.36, cached: 0.14, reasoning: 3.36 },
    "deepseek-ai/DeepSeek-V4-Flash": { input: 0.21, output: 0.63, cached: 0.02, reasoning: 0.63 },
    "moonshotai/Kimi-K2.6": { input: 0.91, output: 3.78, cached: 0.15, reasoning: 3.78 },
  },
  // Inception Labs — first-party launch pricing (docs.inceptionlabs.ai/get-started,
  // 2026-10-20): mercury-3 50% off → $0.10/$0.35, cached $0.01. reasoning billed
  // at the output rate. mercury-2.5 keeps its legacy $0.20/$0.75 rates.
  inception: {
    "mercury-3":    { input: 0.10, output: 0.35, cached: 0.01, reasoning: 0.35 },
    "mercury-2.5":  { input: 0.20, output: 0.75, cached: 0.02, reasoning: 0.75 },
  },
  // TokenRouter — exact rates from https://api.tokenrouter.com/api/pricing ($1/1M tokens).
  // Ratio→USD: input = model_ratio×2, output = model_ratio×completion_ratio×2.
  // These override the canonical MODEL_PRICING/PATTERN_PRICING, whose rates often
  // differ from TokenRouter's reseller pricing.
  tokenrouter: {
    "MiniMax-M3": { input: 0.3, output: 1.2, cached: 0.06, reasoning: 1.2 },
    "anthropic/claude-fable-5": { input: 10, output: 50, cached: 1.0, cache_creation: 12.5, reasoning: 50 },
    "anthropic/claude-haiku-4.5": { input: 1.0, output: 5.0, cached: 0.1, cache_creation: 1.25, reasoning: 5.0 },
    "anthropic/claude-opus-4.5": { input: 5.0, output: 25.0, cached: 0.5, cache_creation: 6.25, reasoning: 25.0 },
    "anthropic/claude-opus-4.6": { input: 5.0, output: 25.0, cached: 0.5, cache_creation: 6.25, reasoning: 25.0 },
    "anthropic/claude-opus-4.7": { input: 5.0, output: 25.0, cached: 0.5, cache_creation: 6.25, reasoning: 25.0 },
    "anthropic/claude-opus-4.7-fast": { input: 30, output: 150, cached: 3.0, reasoning: 150 },
    "anthropic/claude-opus-4.8": { input: 5.0, output: 25.0, cached: 0.5, cache_creation: 6.25, reasoning: 25.0 },
    "anthropic/claude-opus-4.8-fast": { input: 10, output: 50, cached: 1.0, cache_creation: 12.5, reasoning: 50 },
    "anthropic/claude-opus-5": { input: 5.0, output: 25.0, cached: 0.5, cache_creation: 6.25, reasoning: 25.0 },
    "anthropic/claude-opus-5-fast": { input: 10, output: 50, cached: 1.0, cache_creation: 12.5, reasoning: 50 },
    "anthropic/claude-sonnet-4": { input: 3.0, output: 15.0, cached: 0.3, cache_creation: 3.75, reasoning: 15.0 },
    "anthropic/claude-sonnet-4.5": { input: 3.0, output: 15.0, cached: 0.3, cache_creation: 3.75, reasoning: 15.0 },
    "anthropic/claude-sonnet-4.6": { input: 3.0, output: 15.0, cached: 0.3, cache_creation: 3.75, reasoning: 15.0 },
    "anthropic/claude-sonnet-5": { input: 2, output: 10, cached: 0.2, reasoning: 10 },
    "claude-opus-4-8-m-aws": { input: 5.0, output: 25.0, cached: 0.5, cache_creation: 6.25, reasoning: 25.0 },
    "deepseek/deepseek-v3.2": { input: 0.26, output: 0.38, cached: 0.13, reasoning: 0.38 },
    "deepseek/deepseek-v4-flash": { input: 0.14, output: 0.28, cached: 0.0028, reasoning: 0.28 },
    "deepseek/deepseek-v4-flash-0731": { input: 0.14, output: 0.28, cached: 0.0028, reasoning: 0.28 },
    "deepseek/deepseek-v4-pro": { input: 0.435, output: 0.87, cached: 0.003625, reasoning: 0.87 },
    "ex/gpt-5.4": { input: 2.5, output: 15.0, cached: 0.25, reasoning: 15.0 },
    "google/gemini-2.5-flash-image": { input: 0.3, output: 2.5, reasoning: 2.5 },
    "google/gemini-3-flash-preview": { input: 0.5, output: 3.0, cached: 0.05, cache_creation: 0.08333, reasoning: 3.0 },
    "google/gemini-3-pro-image-preview": { input: 2, output: 12, reasoning: 12 },
    "google/gemini-3.1-flash-image-preview": { input: 0.5, output: 3.0, reasoning: 3.0 },
    "google/gemini-3.1-flash-lite-image": { input: 0.25, output: 1.5, reasoning: 1.5 },
    "google/gemini-3.1-pro-preview": { input: 2, output: 12, cached: 0.2, cache_creation: 0.375, reasoning: 12 },
    "google/gemini-3.5-flash": { input: 1.5, output: 9.0, cached: 0.15, cache_creation: 0.08333, reasoning: 9.0 },
    "google/gemini-3.5-flash-lite": { input: 0.3, output: 2.5, cached: 0.03, cache_creation: 0.08333, reasoning: 2.5 },
    "google/gemini-3.6-flash": { input: 1.5, output: 7.5, cached: 0.15, cache_creation: 0.08333, reasoning: 7.5 },
    "google/gemini-embedding-2": { input: 1.0, output: 6.0, cached: 0.1, reasoning: 6.0 },
    "google/gemma-4-26b-a4b-it": { input: 0.06, output: 0.33, reasoning: 0.33 },
    "kling-3.0-turbo": { input: 2.1, output: 2.1, reasoning: 2.1 },
    "microsoft/mai-image-2.5": { input: 5.0, output: 47.0, reasoning: 47.0 },
    "minimax/minimax-m2-her": { input: 0.3, output: 1.2, cached: 0.03, reasoning: 1.2 },
    "minimax/minimax-m2.1": { input: 0.3, output: 1.2, cached: 0.03, reasoning: 1.2 },
    "minimax/minimax-m2.1-highspeed": { input: 0.6, output: 2.4, cached: 0.06, reasoning: 2.4 },
    "minimax/minimax-m2.5": { input: 0.3, output: 1.2, cached: 0.03, reasoning: 1.2 },
    "minimax/minimax-m2.7": { input: 0.3, output: 1.2, cached: 0.06, reasoning: 1.2 },
    "minimax/minimax-m2.7-highspeed": { input: 0.6, output: 2.4, cached: 0.06, reasoning: 2.4 },
    // M3.1-Flash（2026-10-19 控制台价目卡实读）：$0.15 / $0.60 / cache_read $0.015，
    // 与第一方 minimax 同价。`:free` 变体在目录里是独立 id，但上游按账号额度
    // 计费（实测余额为 0 时同样 403 insufficient_user_quota），因此按同价记录
    // 而不是 $0 —— 免费是有条件的，不能按永久免费写死。
    "minimax/minimax-m3.1-flash": { input: 0.15, output: 0.6, cached: 0.015, reasoning: 0.6 },
    "minimax/minimax-m3.1-flash:free": { input: 0.15, output: 0.6, cached: 0.015, reasoning: 0.6 },
    "miromind/mirothinker-1-7-deepresearch": { input: 4, output: 25.0, reasoning: 25.0 },
    "miromind/mirothinker-1-7-deepresearch-mini": { input: 1.25, output: 10.0, reasoning: 10.0 },
    "mistralai/devstral-2512": { input: 0.4, output: 2.0, cached: 0.04, reasoning: 2.0 },
    "mistralai/mistral-medium-3-5": { input: 1.5, output: 7.5, reasoning: 7.5 },
    "mistralai/mistral-small-2603": { input: 0.15, output: 0.6, cached: 0.015, reasoning: 0.6 },
    "mistralai/voxtral-small-24b-2507": { input: 0.1, output: 0.3, cached: 0.01, reasoning: 0.3 },
    "moonshotai/kimi-k2.5": { input: 0.6, output: 3.0, cached: 0.1, reasoning: 3.0 },
    "moonshotai/kimi-k2.6": { input: 0.95, output: 4.0, cached: 0.16, reasoning: 4.0 },
    "moonshotai/kimi-k2.7-code": { input: 0.9286, output: 3.8571, cached: 0.1857, reasoning: 3.8571 },
    "moonshotai/kimi-k3": { input: 3.0, output: 15.0, cached: 0.3, reasoning: 15.0 },
    "nvidia/nemotron-3-super-120b-a12b": { input: 0.3, output: 0.9, cached: 0.1, reasoning: 0.9 },
    "openai/gpt-4o-mini": { input: 0.15, output: 0.6, cached: 0.075, reasoning: 0.6 },
    "openai/gpt-5": { input: 1.25, output: 10.0, cached: 0.125, reasoning: 10.0 },
    "openai/gpt-5-image": { input: 10, output: 40, cached: 2.5, reasoning: 40 },
    "openai/gpt-5-image-mini": { input: 2.5, output: 8.0, cached: 0.25, reasoning: 8.0 },
    "openai/gpt-5-mini": { input: 0.25, output: 2.0, cached: 0.025, reasoning: 2.0 },
    "openai/gpt-5.2": { input: 1.75, output: 14.0, cached: 0.175, reasoning: 14.0 },
    "openai/gpt-5.3-codex": { input: 1.75, output: 14.0, cached: 0.175, reasoning: 14.0 },
    "openai/gpt-5.4": { input: 2.5, output: 15.0, cached: 0.25, reasoning: 15.0 },
    "openai/gpt-5.4-image-2": { input: 8, output: 30.0, cached: 2.0, reasoning: 30.0 },
    "openai/gpt-5.4-mini": { input: 0.75, output: 4.5, cached: 0.075, reasoning: 4.5 },
    "openai/gpt-5.4-nano": { input: 0.2, output: 1.25, cached: 0.02, reasoning: 1.25 },
    "openai/gpt-5.4-pro": { input: 30, output: 180, reasoning: 180 },
    "openai/gpt-5.5": { input: 5.0, output: 30.0, cached: 0.5, reasoning: 30.0 },
    "openai/gpt-5.5-pro": { input: 30, output: 180, reasoning: 180 },
    "openai/gpt-5.6-luna": { input: 0.2, output: 1.2, cached: 0.02, cache_creation: 0.25, reasoning: 1.2 },
    "openai/gpt-5.6-sol": { input: 5.0, output: 30.0, cached: 0.5, cache_creation: 6.25, reasoning: 30.0 },
    "openai/gpt-5.6-terra": { input: 2, output: 12, cached: 0.2, cache_creation: 2.5, reasoning: 12 },
    "openai/gpt-audio": { input: 2.5, output: 10.0, reasoning: 10.0 },
    "openai/gpt-audio-mini": { input: 0.6, output: 2.4, reasoning: 2.4 },
    "openai/gpt-oss-120b": { input: 0.039, output: 0.18, reasoning: 0.18 },
    "qwen/qwen3-coder-next": { input: 0.12, output: 0.75, cached: 0.06, reasoning: 0.75 },
    "qwen/qwen3.5-122b-a10b": { input: 0.26, output: 2.08, reasoning: 2.08 },
    "qwen/qwen3.5-35b-a3b": { input: 0.1625, output: 1.3, reasoning: 1.3 },
    "qwen/qwen3.5-397b-a17b": { input: 0.39, output: 2.34, reasoning: 2.34 },
    "qwen/qwen3.5-9b": { input: 0.1, output: 0.15, reasoning: 0.15 },
    "qwen/qwen3.5-flash": { input: 0.1048, output: 0.4194, reasoning: 0.4194 },
    "qwen/qwen3.5-plus-02-15": { input: 0.26, output: 1.56, reasoning: 1.56 },
    "qwen/qwen3.6-plus": { input: 0.54, output: 3.21, reasoning: 3.21 },
    "qwen/qwen3.7-max": { input: 1.25, output: 3.75, cached: 0.25, reasoning: 3.75 },
    "qwen/qwen3.7-plus": { input: 0.4, output: 1.6, cached: 0.08, reasoning: 1.6 },
    "qwen/qwen3.8-max": { input: 2, output: 6, cached: 0.25, cache_creation: 2.5, reasoning: 6 },
    "qwen3.5-omni-plus": { input: 1.0, output: 5.7143, reasoning: 5.7143 },
    "qwen3.6-flash": { input: 0.171, output: 1.029, cached: 0.017, cache_creation: 0.214, reasoning: 1.029 },
    "sakana/fugu-ultra": { input: 5.0, output: 30.0, cached: 0.5, reasoning: 30.0 },
    "seed-2-0-code-preview-260328": { input: 1.0, output: 6.0, cached: 0.2, cache_creation: 0.008333, reasoning: 6.0 },
    "seed-2-0-lite-260428": { input: 0.5, output: 4.0, cached: 0.1, cache_creation: 0.008333, reasoning: 4.0 },
    "seed-2-0-mini-260428": { input: 0.2, output: 0.8, cached: 0.04, cache_creation: 0.00833, reasoning: 0.8 },
    "seed-2-0-pro-260328": { input: 1.0, output: 6.0, cached: 0.2, cache_creation: 0.008333, reasoning: 6.0 },
    "stepfun/step-3.5-flash": { input: 0.1, output: 0.3, cached: 0.02, reasoning: 0.3 },
    "stepfun/step-3.7-flash": { input: 0.2, output: 1.15, cached: 0.04, reasoning: 1.15 },
    "tencent/hy3-preview": { input: 0.066, output: 0.26, cached: 0.029, reasoning: 0.26 },
    "tencent/hy4-preview": { input: 0.834, output: 2.501, cached: 0.042, reasoning: 2.501 },
    "x-ai/grok-4.1-fast": { input: 0.2, output: 0.5, cached: 0.05, reasoning: 0.5 },
    "x-ai/grok-4.20-beta": { input: 2, output: 6, cached: 0.2, reasoning: 6 },
    "x-ai/grok-4.3": { input: 1.25, output: 2.5, cached: 0.2, reasoning: 2.5 },
    "x-ai/grok-4.5": { input: 2, output: 6, cached: 0.5, reasoning: 6 },
    "x-ai/grok-build-0.1": { input: 1.0, output: 2.0, cached: 0.2, reasoning: 2.0 },
    "xiaomi/mimo-v2-flash": { input: 0.1, output: 0.3, cached: 0.01, reasoning: 0.3 },
    "xiaomi/mimo-v2-omni": { input: 0.4, output: 2.0, cached: 0.08, reasoning: 2.0 },
    "xiaomi/mimo-v2-pro": { input: 1.0, output: 3.0, cached: 0.2, reasoning: 3.0 },
    "xiaomi/mimo-v2.5": { input: 0.4, output: 2.0, cached: 0.08, reasoning: 2.0 },
    "xiaomi/mimo-v2.5-pro": { input: 1.0, output: 3.0, cached: 0.2, reasoning: 3.0 },
    "z-ai/glm-4.5-air": { input: 0.13, output: 0.85, cached: 0.025, reasoning: 0.85 },
    "z-ai/glm-4.6": { input: 0.6, output: 2.2, cached: 0.11, reasoning: 2.2 },
    "z-ai/glm-4.6v": { input: 0.3, output: 0.9, reasoning: 0.9 },
    "z-ai/glm-4.7": { input: 0.6, output: 2.2, cached: 0.11, reasoning: 2.2 },
    "z-ai/glm-5": { input: 1.0, output: 3.2, cached: 0.2, reasoning: 3.2 },
    "z-ai/glm-5-turbo": { input: 1.2, output: 4.0, cached: 0.24, reasoning: 4.0 },
    "z-ai/glm-5.1": { input: 1.05, output: 3.5, cached: 0.525, reasoning: 3.5 },
    "z-ai/glm-5.2": { input: 1.4, output: 4.4, cached: 0.26, reasoning: 4.4 },
  },

  // ── 以下为 2026-10-20 `node scripts/sync-modelsdev.mjs --refresh` 的输出：
  // 只收「source 前缀与本 provider 同族」的第一方价目，跨 reseller 猜的候选
  // 一律不收（同一模型在不同转售商差价很大，照抄会把成本算错）。USD / 1M tok。
  cohere: {
    "command-a-03-2025": { input: 2.5, output: 10, reasoning: 10 },
    "command-r-plus-08-2024": { input: 2.5, output: 10, reasoning: 10 },
    "command-r-08-2024": { input: 0.15, output: 0.6, reasoning: 0.6 },
  },
  groq: {
    "llama-3.3-70b-versatile": { input: 0.59, output: 0.79, reasoning: 0.79 },
    "openai/gpt-oss-120b": { input: 0.15, output: 0.6, cached: 0.075, reasoning: 0.6 },
  },
  mistral: {
    "mistral-large-latest": { input: 0.5, output: 1.5, cached: 0.05, reasoning: 1.5 },
    "codestral-latest": { input: 0.3, output: 0.9, cached: 0.03, reasoning: 0.9 },
    "mistral-medium-latest": { input: 1.5, output: 7.5, cached: 0.15, reasoning: 7.5 },
  },
  morph: {
    "morph-v3-large": { input: 0.9, output: 1.9, reasoning: 1.9 },
    "morph-v3-fast": { input: 0.8, output: 1.2, reasoning: 1.2 },
  },
  perplexity: {
    sonar: { input: 1, output: 1, reasoning: 1 },
    "sonar-pro": { input: 3, output: 15, reasoning: 15 },
  },
  "perplexity-agent": {
    "perplexity/sonar": { input: 0.25, output: 2.5, cached: 0.0625, reasoning: 2.5 },
    "nvidia/nemotron-3-super-120b-a12b": { input: 0.25, output: 2.5, reasoning: 2.5 },
  },
  siliconflow: {
    "openai/gpt-oss-120b": { input: 0.05, output: 0.45, reasoning: 0.45 },
    "inclusionAI/Ling-flash-2.0": { input: 0.14, output: 0.57, reasoning: 0.57 },
  },
  // StepFun 三线共用一份官方价（stepfun-ai 条目）；国际站 step-5-preview 略高。
  stepfun: {
    "step-5-preview": { input: 0.959, output: 2.741, cached: 0.048, reasoning: 2.741 },
    "step-3.7-flash": { input: 0.185, output: 1.11, cached: 0.037, reasoning: 1.11 },
    "step-3.5-flash": { input: 0.1, output: 0.3, cached: 0.02, reasoning: 0.3 },
    "step-3.5-flash-2603": { input: 0.1, output: 0.3, cached: 0.02, reasoning: 0.3 },
  },
  "stepfun-cn": {
    "step-5-preview": { input: 1.0, output: 2.7, cached: 0.05, reasoning: 2.7 },
    "step-3.7-flash": { input: 0.185, output: 1.11, cached: 0.037, reasoning: 1.11 },
    "step-3.5-flash": { input: 0.1, output: 0.3, cached: 0.02, reasoning: 0.3 },
    "step-3.5-flash-2603": { input: 0.1, output: 0.3, cached: 0.02, reasoning: 0.3 },
  },
  venice: {
    "venice-uncensored-1-2": { input: 0.2, output: 0.9, reasoning: 0.9 },
    "zai-org-glm-5": { input: 1, output: 3.2, cached: 0.2, reasoning: 3.2 },
    "llama-3.3-70b": { input: 0.7, output: 2.8, reasoning: 2.8 },
    "hermes-3-llama-3.1-405b": { input: 1.1, output: 3, reasoning: 3 },
    "mistral-small-3-2-24b-instruct": { input: 0.09375, output: 0.25, reasoning: 0.25 },
  },
  cerebras: {
    "gpt-oss-120b": { input: 0.35, output: 0.75, reasoning: 0.75 },
  },
  openai: {
    o3: { input: 2, output: 8, cached: 0.5, reasoning: 8 },
  },
  longcat: {
    "LongCat-2.0": { input: 0.75, output: 2.95, cached: 0.015, reasoning: 2.95 },
    "LongCat-2.5-Preview": { input: 0.75, output: 2.95, cached: 0.015, reasoning: 2.95 },
  },
  "longcat-intl": {
    "LongCat-2.0": { input: 0.75, output: 2.95, cached: 0.015, reasoning: 2.95 },
    "LongCat-2.5-Preview": { input: 0.75, output: 2.95, cached: 0.015, reasoning: 2.95 },
  },
};

/**
 * Pattern-based pricing fallback — matched when no exact model entry found.
 * Patterns use simple glob: "*" matches any substring.
 * First match wins — order matters.
 */
export const PATTERN_PRICING = [
  // --- Codex variants ---
  { pattern: "*-codex-xhigh",   pricing: { input: 10.00, output: 40.00, cached: 5.00,  reasoning: 60.00,  cache_creation: 10.00 } },
  { pattern: "*-codex-high",    pricing: { input: 8.00,  output: 32.00, cached: 4.00,  reasoning: 48.00,  cache_creation: 8.00  } },
  { pattern: "*-codex-max",     pricing: { input: 8.00,  output: 32.00, cached: 4.00,  reasoning: 48.00,  cache_creation: 8.00  } },
  { pattern: "*-codex-mini-*",  pricing: { input: 1.50,  output: 6.00,  cached: 0.75,  reasoning: 9.00,   cache_creation: 1.50  } },
  { pattern: "*-codex-mini",    pricing: { input: 1.50,  output: 6.00,  cached: 0.75,  reasoning: 9.00,   cache_creation: 1.50  } },
  { pattern: "*-codex-low",     pricing: { input: 1.75,  output: 14.00, cached: 0.175, reasoning: 14.00,  cache_creation: 1.75  } },
  { pattern: "*-codex-none",    pricing: { input: 1.75,  output: 14.00, cached: 0.175, reasoning: 14.00,  cache_creation: 1.75  } },
  { pattern: "*-codex-spark",   pricing: { input: 3.00,  output: 12.00, cached: 0.30,  reasoning: 12.00,  cache_creation: 3.00  } },
  { pattern: "codex-*",         pricing: { input: 1.75,  output: 14.00, cached: 0.175, reasoning: 14.00,  cache_creation: 1.75  } },
  { pattern: "*-codex",         pricing: { input: 1.75,  output: 14.00, cached: 0.175, reasoning: 14.00,  cache_creation: 1.75  } },

  // --- Claude ---
  { pattern: "claude-opus-*",   pricing: { input: 5.00,  output: 25.00, cached: 0.50,  reasoning: 25.00,  cache_creation: 6.25  } },
  { pattern: "claude-sonnet-*", pricing: { input: 3.00,  output: 15.00, cached: 0.30,  reasoning: 15.00,  cache_creation: 3.75  } },
  { pattern: "claude-haiku-*",  pricing: { input: 1.00,  output: 5.00,  cached: 0.10,  reasoning: 5.00,   cache_creation: 1.25  } },
  { pattern: "claude-*",        pricing: { input: 3.00,  output: 15.00, cached: 0.30,  reasoning: 15.00,  cache_creation: 3.75  } },

  // --- Gemini (specific first, generic last) ---
  { pattern: "gemini-*-flash-lite", pricing: { input: 0.15, output: 1.25, cached: 0.015, reasoning: 1.875, cache_creation: 0.15 } },
  { pattern: "gemini-*-flash",  pricing: { input: 0.30,  output: 2.50,  cached: 0.03,  reasoning: 3.75,   cache_creation: 0.30  } },
  { pattern: "gemini-*-pro",    pricing: { input: 2.00,  output: 12.00, cached: 0.25,  reasoning: 18.00,  cache_creation: 2.00  } },
  { pattern: "gemini-3-*",      pricing: { input: 0.50,  output: 3.00,  cached: 0.03,  reasoning: 4.50,   cache_creation: 0.50  } },
  { pattern: "gemini-2.5-*",    pricing: { input: 0.30,  output: 2.50,  cached: 0.03,  reasoning: 3.75,   cache_creation: 0.30  } },
  { pattern: "gemini-*",        pricing: { input: 0.50,  output: 3.00,  cached: 0.03,  reasoning: 4.50,   cache_creation: 0.50  } },

  // --- GPT (specific first, generic last) ---
  { pattern: "gpt-5.6-*",       pricing: { input: 2.50,  output: 15.00, cached: 0.25,  reasoning: 15.00,  cache_creation: 2.50  } },
  { pattern: "gpt-5.3-*",       pricing: { input: 1.75,  output: 14.00, cached: 0.175, reasoning: 14.00,  cache_creation: 1.75  } },
  { pattern: "gpt-5.2-*",       pricing: { input: 1.75,  output: 14.00, cached: 0.175, reasoning: 14.00,  cache_creation: 1.75  } },
  { pattern: "gpt-5.1-*",       pricing: { input: 1.25,  output: 10.00, cached: 0.625, reasoning: 10.00,  cache_creation: 1.25  } },
  { pattern: "gpt-5-*",         pricing: { input: 1.25,  output: 10.00, cached: 0.625, reasoning: 10.00,  cache_creation: 1.25  } },
  { pattern: "gpt-5*",          pricing: { input: 1.25,  output: 10.00, cached: 0.625, reasoning: 10.00,  cache_creation: 1.25  } },
  { pattern: "gpt-4o-*",        pricing: { input: 0.15,  output: 0.60,  cached: 0.075, reasoning: 0.90,   cache_creation: 0.15  } },
  { pattern: "gpt-4o",          pricing: { input: 2.50,  output: 10.00, cached: 1.25,  reasoning: 15.00,  cache_creation: 2.50  } },
  { pattern: "gpt-4*",          pricing: { input: 2.50,  output: 10.00, cached: 1.25,  reasoning: 15.00,  cache_creation: 2.50  } },

  // --- o1 / o-series ---
  { pattern: "o1-*",            pricing: { input: 3.00,  output: 12.00, cached: 1.50,  reasoning: 18.00,  cache_creation: 3.00  } },
  { pattern: "o1",              pricing: { input: 15.00, output: 60.00, cached: 7.50,  reasoning: 90.00,  cache_creation: 15.00 } },
  { pattern: "o3-*",            pricing: { input: 10.00, output: 40.00, cached: 5.00,  reasoning: 60.00,  cache_creation: 10.00 } },
  { pattern: "o4-*",            pricing: { input: 2.00,  output: 8.00,  cached: 1.00,  reasoning: 12.00,  cache_creation: 2.00  } },

  // --- Qwen ---
  { pattern: "qwen3-coder-*",   pricing: { input: 1.00,  output: 4.00,  cached: 0.50,  reasoning: 6.00,   cache_creation: 1.00  } },
  { pattern: "qwen*-coder-*",   pricing: { input: 1.00,  output: 4.00,  cached: 0.50,  reasoning: 6.00,   cache_creation: 1.00  } },
  { pattern: "qwen*",           pricing: { input: 0.50,  output: 2.00,  cached: 0.25,  reasoning: 3.00,   cache_creation: 0.50  } },

  // --- Kimi ---
  { pattern: "kimi-*-thinking",  pricing: { input: 1.80,  output: 7.20,  cached: 0.90,  reasoning: 10.80,  cache_creation: 1.80  } },
  { pattern: "kimi-k3*",        pricing: { input: 3.00,  output: 15.00, cached: 0.30,  reasoning: 15.00,  cache_creation: 3.00  } },
  { pattern: "kimi-k2*",        pricing: { input: 1.20,  output: 4.80,  cached: 0.60,  reasoning: 7.20,   cache_creation: 1.20  } },
  { pattern: "kimi-*",          pricing: { input: 1.00,  output: 4.00,  cached: 0.50,  reasoning: 6.00,   cache_creation: 1.00  } },

  // --- DeepSeek ---
  { pattern: "deepseek-*reasoner*", pricing: { input: 0.14, output: 0.28, cached: 0.0028, reasoning: 0.28, cache_creation: 0.14 } },
  { pattern: "deepseek-r*",     pricing: { input: 0.14,  output: 0.28,  cached: 0.0028, reasoning: 0.28,   cache_creation: 0.14  } },
  { pattern: "deepseek-v*",     pricing: { input: 0.14,  output: 0.28,  cached: 0.0028, reasoning: 0.28,   cache_creation: 0.14  } },
  { pattern: "deepseek-*",      pricing: { input: 0.14,  output: 0.28,  cached: 0.0028, reasoning: 0.28,   cache_creation: 0.14  } },

  // --- GLM ---
  { pattern: "glm-5*",          pricing: { input: 1.00,  output: 4.00,  cached: 0.50,  reasoning: 6.00,   cache_creation: 1.00  } },
  { pattern: "glm-4*",          pricing: { input: 0.75,  output: 3.00,  cached: 0.375, reasoning: 4.50,   cache_creation: 0.75  } },
  { pattern: "glm-*",           pricing: { input: 0.50,  output: 2.00,  cached: 0.25,  reasoning: 3.00,   cache_creation: 0.50  } },

  // --- MiniMax ---
  { pattern: "MiniMax-*",       pricing: { input: 0.50,  output: 2.00,  cached: 0.25,  reasoning: 3.00,   cache_creation: 0.50  } },
  { pattern: "minimax-*",       pricing: { input: 0.50,  output: 2.00,  cached: 0.25,  reasoning: 3.00,   cache_creation: 0.50  } },

  // --- Grok ---
  { pattern: "grok-code-*",     pricing: { input: 0.50,  output: 2.00,  cached: 0.25,  reasoning: 3.00,   cache_creation: 0.50  } },
  { pattern: "grok-*",          pricing: { input: 0.50,  output: 2.00,  cached: 0.25,  reasoning: 3.00,   cache_creation: 0.50  } },
];

/**
 * Match a model ID against a glob pattern (* = wildcard). Case-insensitive:
 * registry ids mix casing (e.g. "MiniMax-M2.5" vs "minimax-m2.5").
 */
export function matchPattern(pattern, model) {
  const regex = new RegExp("^" + pattern.split("*").map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");
  return regex.test(model);
}

/**
 * Resolve pricing for a model using the 3-step fallback chain:
 *   1. PROVIDER_PRICING[provider][model]
 *   2. MODEL_PRICING[model]
 *   3. PATTERN_PRICING (glob match)
 *
 * @param {string} provider
 * @param {string} model
 * @returns {object|null}
 */
export function getPricingForModel(provider, model) {
  if (!model) return null;

  // 1. Provider-specific override
  if (provider && PROVIDER_PRICING[provider]?.[model]) {
    return PROVIDER_PRICING[provider][model];
  }

  // 2. Free namespaces bill $0 regardless of the model name behind them.
  if (isFreeModel(model)) return ZERO_PRICING;

  // 3. Canonical model pricing (strip vendor prefix if needed: "deepseek/deepseek-chat" → "deepseek-chat")
  const baseModel = model.includes("/") ? model.split("/").pop() : model;
  if (MODEL_PRICING[baseModel]) return MODEL_PRICING[baseModel];
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];

  // 4. Pattern match
  for (const { pattern, pricing } of PATTERN_PRICING) {
    if (matchPattern(pattern, baseModel) || matchPattern(pattern, model)) {
      return pricing;
    }
  }

  return null;
}

/**
 * Get all provider pricing (for UI / API).
 * Returns PROVIDER_PRICING — consumers should fall back to MODEL_PRICING for unlisted models.
 */
export function getDefaultPricing() {
  return PROVIDER_PRICING;
}

/**
 * Format cost for display
 * @param {number} cost
 * @returns {string}
 */
export function formatCost(cost) {
  if (cost === null || cost === undefined || isNaN(cost)) return "$0.00";
  return `$${cost.toFixed(2)}`;
}

/**
 * Calculate cost from tokens and pricing
 * @param {object} tokens
 * @param {object} pricing
 * @returns {number} cost in dollars
 */
export function calculateCostFromTokens(tokens, pricing) {
  if (!tokens || !pricing) return 0;

  let cost = 0;

  const inputTokens = tokens.prompt_tokens || tokens.input_tokens || 0;
  const cachedTokens = tokens.cached_tokens || tokens.cache_read_input_tokens || 0;
  const cacheCreationTokens = tokens.cache_creation_input_tokens || 0;
  // prompt_tokens is cache-inclusive (see canonicalizeUsage): cached + cache_creation
  // are subsets, so subtract both to avoid charging them at the full input rate.
  const nonCachedInput = Math.max(0, inputTokens - cachedTokens - cacheCreationTokens);

  cost += nonCachedInput * (pricing.input / 1000000);

  if (cachedTokens > 0) {
    cost += cachedTokens * ((pricing.cached || pricing.input) / 1000000);
  }

  const outputTokens = tokens.completion_tokens || tokens.output_tokens || 0;
  cost += outputTokens * (pricing.output / 1000000);

  const reasoningTokens = tokens.reasoning_tokens || 0;
  if (reasoningTokens > 0) {
    cost += reasoningTokens * ((pricing.reasoning || pricing.output) / 1000000);
  }

  if (cacheCreationTokens > 0) {
    cost += cacheCreationTokens * ((pricing.cache_creation || pricing.input) / 1000000);
  }

  return cost;
}
