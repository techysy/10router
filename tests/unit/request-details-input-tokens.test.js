// Regression: the request-details view swapped 输入 for 缓存 on cache-heavy
// Claude-format providers. Request-detail records store the raw translator
// usage — prompt_tokens cache-exclusive, cache_read_input_tokens beside it —
// while the old getter treated "prompt < cache" as a legacy row and displayed
// the cache value as input. zcode-free runs ~99% cache hit, so every row
// rendered 输入 == 缓存 (1:1) and the real uncached input vanished.
//
// The canonical usageHistory shape (prompt cache-inclusive, cached_tokens set)
// must keep flowing through untouched, and the legacy fallback stays for rows
// that carry neither marker field.
import { describe, expect, it } from "vitest";
import { getInputTokens, getCachedTokens, getCacheCreationTokens } from "../../src/shared/utils/usageDisplay.js";

describe("getInputTokens — raw Claude-shape vs canonical usage rows", () => {
  it("folds unfolded Claude-shape rows (prompt cache-exclusive) instead of swapping in the cache value", () => {
    // Real shape stored by saveRequestDetail for a zcode-free request.
    const raw = { prompt_tokens: 8, completion_tokens: 119, cache_read_input_tokens: 263296 };
    expect(getInputTokens(raw)).toBe(263304);
    expect(getCachedTokens(raw)).toBe(263296);
    expect(getInputTokens(raw)).toBeGreaterThan(getCachedTokens(raw));
  });

  it("folds cache_creation into the total as well", () => {
    const raw = { prompt_tokens: 200, completion_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 };
    expect(getInputTokens(raw)).toBe(1250);
    expect(getCacheCreationTokens(raw)).toBe(50);
  });

  it("keeps canonical (cache-inclusive) rows as stored", () => {
    const canonical = { prompt_tokens: 149429, completion_tokens: 1560, cached_tokens: 147456, cache_creation_input_tokens: 0 };
    expect(getInputTokens(canonical)).toBe(149429);
    expect(getCachedTokens(canonical)).toBe(147456);
  });

  it("keeps the legacy fallback for rows with neither marker field", () => {
    const legacy = { prompt_tokens: 10, cache_read_input_tokens: undefined, cached_tokens: undefined };
    expect(getInputTokens(legacy)).toBe(10);
    // Legacy shape without any cache field but a larger cache via cached path is
    // not reachable — cached_tokens presence means canonical, covered above.
  });

  it("handles empty / zero-token records", () => {
    expect(getInputTokens({})).toBe(0);
    expect(getInputTokens(null)).toBe(0);
    expect(getInputTokens({ prompt_tokens: 0, completion_tokens: 0 })).toBe(0);
  });
});
