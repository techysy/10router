/**
 * Token getters for views that render usage rows from BOTH storage shapes:
 *
 *  - Canonical (usageHistory, saveUsageStats): prompt_tokens is cache-INCLUSIVE
 *    and cached_tokens is set — see canonicalizeUsage in open-sse/utils/usageTracking.js.
 *  - Raw translator usage (requestDetails records, usage rings): Claude-shape
 *    rows carry prompt_tokens cache-EXCLUSIVE with cache_read_input_tokens
 *    (and optionally cache_creation_input_tokens) beside it. zcode-free, for
 *    example, stores prompt_tokens=8 next to cache_read_input_tokens=263296.
 *
 * Callers must NOT infer the shape from "prompt < cache" — for cache-heavy
 * providers that is true for every request and collapses 输入 into 缓存.
 * Discriminate on the marker fields instead (same rule as canonicalizeUsage).
 */

export function isUnfoldedClaudeUsage(tokens) {
  return tokens?.cached_tokens === undefined &&
    (tokens?.cache_read_input_tokens !== undefined || tokens?.cache_creation_input_tokens !== undefined);
}

export function getCachedTokens(tokens) {
  return tokens?.cached_tokens || tokens?.cache_read_input_tokens || 0;
}

export function getCacheCreationTokens(tokens) {
  return tokens?.cache_creation_input_tokens || 0;
}

export function getInputTokens(tokens) {
  const prompt = tokens?.prompt_tokens || tokens?.input_tokens || 0;
  if (isUnfoldedClaudeUsage(tokens)) {
    return prompt + getCachedTokens(tokens) + getCacheCreationTokens(tokens);
  }
  // Canonical rows: prompt already includes the cache. Legacy rows (neither
  // marker field) may still have prompt cache-exclusive; fall back to cache
  // when it's larger so old rows don't under-report input.
  const cache = getCachedTokens(tokens);
  return prompt < cache ? cache : prompt;
}
