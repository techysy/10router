// Server-side freshness + in-flight coalescing for upstream usage calls.
//
// Upstream quota APIs are rate-sensitive and the per-connection endpoint has
// no auth beyond the dashboard session — every open dashboard tab polls it on
// its own 5-minute timer. The aggregated /api/usage/quotas route has always
// cached + coalesced (CACHE_TTL_MS / FORCE_MIN_INTERVAL_MS there); this is the
// same posture for GET /api/usage/[connectionId], which used to hit the
// provider console on every single call.
//
// Semantics (mirroring the aggregated route):
//   - cacheable results (200 with a non-empty quotas body) are fresh for
//     `freshMs` (5 min) for every caller;
//   - everything else (errors, message-only bodies, empty quota maps) cools
//     down for `forceMinIntervalMs` (30 s) so a broken connection is not
//     re-hammered on every poll but recovers quickly after a re-auth;
//   - `force` skips the fresh TTL but never fires upstream more often than
//     `forceMinIntervalMs` — within it the last settled result is returned;
//   - concurrent calls for one key share a single in-flight upstream call.

export function createUsageResultCache({
  freshMs = 5 * 60 * 1000,
  forceMinIntervalMs = 30 * 1000,
  maxEntries = 500,
} = {}) {
  const entries = new Map(); // key → { at, result, cacheable }
  const inflight = new Map(); // key → Promise<result>

  // Callers may mutate the body they receive (the quotas route post-processes
  // quotas rows), so every consumer gets a deep clone of the shared result.
  // Usage bodies are JSON API shapes by construction, so a JSON round-trip is
  // both safe and sufficient.
  const clone = (result) =>
    result?.body && typeof result.body === "object"
      ? { ...result, body: JSON.parse(JSON.stringify(result.body)) }
      : result;

  const isCacheable = (result) =>
    result?.status === 200 &&
    !!result?.body?.quotas &&
    typeof result.body.quotas === "object" &&
    Object.keys(result.body.quotas).length > 0;

  return {
    async run(key, fn, { force = false } = {}) {
      const settled = entries.get(key);
      if (settled) {
        const age = Date.now() - settled.at;
        if (force) {
          if (age < forceMinIntervalMs) return clone(settled.result);
        } else if (age < (settled.cacheable ? freshMs : forceMinIntervalMs)) {
          return clone(settled.result);
        }
      }

      const pending = inflight.get(key);
      if (pending) return pending.then(clone);

      const flight = (async () => {
        const result = await fn();
        if (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
        entries.set(key, { at: Date.now(), result, cacheable: isCacheable(result) });
        return result;
      })();
      inflight.set(key, flight);
      try {
        return await flight;
      } finally {
        inflight.delete(key);
      }
    },
  };
}
