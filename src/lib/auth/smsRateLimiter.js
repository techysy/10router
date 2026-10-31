// In-memory sliding-window rate limiter for the Loomy SMS endpoints
// (/api/oauth/loomy/sms-send, /api/oauth/loomy/sms-login).
//
// Same accepted tradeoff as loginLimiter.js (issue #43 item 2): state lives in
// memory, a process restart wipes it — an adversary able to restart the server
// already owns the host. Unlike login lockout (counts FAILURES), SMS sends and
// code attempts are chargeable actions regardless of outcome, so this is a
// plain sliding-window counter per bucket. Buckets are pruned opportunistically
// so garbage keys (random phones) can't grow the map without bound.

const windows = new Map(); // bucket → number[] hit timestamps (ascending)
const PRUNE_THRESHOLD = 512;
const PRUNE_MAX_AGE_MS = 60 * 60 * 1000; // every window we use is ≤ 1h

/**
 * Record one hit and decide whether it's allowed.
 * @param {string} bucket stable key, e.g. `loomy-send:phone:<phone>`
 * @param {number} limit max hits inside the window
 * @param {number} windowMs window length
 * @param {number} [now] injectable clock for tests
 * @returns {{ ok: true } | { ok: false, retryAfterSeconds: number }}
 */
export function smsRateLimit(bucket, limit, windowMs, now = Date.now()) {
  const cut = now - windowMs;
  const hits = (windows.get(bucket) || []).filter((t) => t > cut);
  if (hits.length >= limit) {
    windows.set(bucket, hits);
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((hits[0] + windowMs - now) / 1000)) };
  }
  hits.push(now);
  windows.set(bucket, hits);
  if (windows.size > PRUNE_THRESHOLD) {
    const staleCut = Date.now() - PRUNE_MAX_AGE_MS;
    for (const [k, v] of windows) {
      if (v.length === 0 || v[v.length - 1] < staleCut) windows.delete(k);
    }
  }
  return { ok: true };
}
