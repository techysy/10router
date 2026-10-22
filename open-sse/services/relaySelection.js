/**
 * Single-point relay carrier selection — the multi-account counterpart of the
 * "earliest-expiry quota package" strategy.
 *
 * The quota-package feature only ever ranked accounts by soonest expiry and
 * re-sorted on every request. For providers whose quota is a RECURRING dual
 * bucket (Antigravity/Gemini: a 5h short-window leaky bucket + a 7d base
 * reservoir), that re-sort is exactly wrong: the moment the front account's 5h
 * window refills it jumps back to the front, so the pool round-robins on its
 * own — every account's short bucket drains at once and the whole channel
 * black-holes together. The "carrier" never gets to run a bucket to the bottom.
 *
 * Relay fixes that with three rules (the group's "环形单向闭环接力" design):
 *
 *   1. Single-point dead-burn. One account carries 100% of traffic until it is
 *      genuinely spent — never spread the load across the ring.
 *   2. Forward-only, never jump back. The ring is a fixed priority order
 *      (1→2→3→4→1). When the carrier crosses the red zone we step to the NEXT
 *      account; an already-refilled earlier account stays parked even at 100%,
 *      because cutting back mid-stream is the jitter the design forbids.
 *   3. Aggressive pre-switch. The switch fires on the LIVE remaining-percentage
 *      crossing a red-zone threshold (< 5%), not on a 429 from upstream — the
 *      client never sees an error, the handoff is invisible.
 *
 * The carrier is not stored separately: it is derived from `lastUsedAt`, the
 * same field round-robin already maintains. That keeps selection stateless
 * (survives restarts, no new column) and makes relay and round-robin share one
 * source of truth for "who is carrying right now".
 */

// Red zone: below this live remaining-percentage the carrier is swapped out.
// 5% is the group's threshold — early enough that the next request lands on a
// fresh bucket, late enough that we still squeeze the current one.
export const RELAY_RED_ZONE_PCT = 5;

/**
 * A connection is a valid carrier while it is present, not red-zone, and not
 * already exhausted.
 *
 * The percentage read here is the SHORT window — the fastest-resetting one
 * (CodeBuddy's 5h-ish refill window, Antigravity's 5h, Minimax's 1h50m), NOT
 * "the smallest of every bucket". Those are different numbers and the
 * difference is what drains an account: a one-shot bonus pack sitting at 55%
 * of its own allowance simultaneously means "plenty of short-window headroom"
 * while the account's long-run allowance is nearly gone. The short window is
 * what throttles throughput, so it is what the handoff must watch.
 *
 * Unknown data (first request after enabling, a provider with no percentage
 * quota) is treated as healthy — never pre-emptively switch on missing data;
 * upstream 429/lock stays the final backstop.
 */
function isCarrierHealthy(conn, redZonePct) {
  if (!conn) return false;
  const remaining = conn.shortWindowRemaining;
  if (typeof remaining === "number" && Number.isFinite(remaining)) {
    if (remaining <= 0) return false;
    if (remaining < redZonePct) return false;
  }
  return true;
}

function mostRecentUsed(connections) {
  let best = null;
  let bestTime = -Infinity;
  for (const c of connections) {
    if (!c.lastUsedAt) continue;
    const t = new Date(c.lastUsedAt).getTime();
    if (Number.isFinite(t) && t > bestTime) {
      bestTime = t;
      best = c;
    }
  }
  return best;
}

/**
 * Choose the relay carrier.
 *
 * @param {Array<object>} connections - available connections, ALREADY in ring
 *   order (ascending priority — the fixed 1→2→3→4→1 lane). Not mutated.
 * @param {{ redZonePct?: number }} [opts]
 * @returns {{ connection: object, stepped: boolean } | null} `stepped` is true
 *   when the carrier moved off the previously-most-recently-used account, so the
 *   caller can log the handoff.
 */
export function selectRelayCarrier(connections, opts = {}) {
  const redZonePct = Number.isFinite(opts.redZonePct) ? opts.redZonePct : RELAY_RED_ZONE_PCT;
  if (!Array.isArray(connections) || connections.length === 0) return null;
  if (connections.length === 1) return { connection: connections[0], stepped: false };

  const ring = connections;
  const previous = mostRecentUsed(ring);
  const prevIdx = previous ? ring.findIndex((c) => c.id === previous.id) : -1;

  // Rule 1 + 3: keep the current carrier while it is still healthy — even if an
  // earlier-priority account has refilled. This is the "绝不插队" guarantee.
  if (prevIdx >= 0 && isCarrierHealthy(previous, redZonePct)) {
    return { connection: previous, stepped: false };
  }

  // Rule 2: step FORWARD around the ring from the carrier (or from the head when
  // nothing has carried yet). Wrap past the end back to index 0. Never scan
  // backward — a refilled earlier account stays parked until the ring wraps to it.
  const startIdx = prevIdx >= 0 ? prevIdx : -1;
  for (let i = 1; i <= ring.length; i++) {
    const cand = ring[(startIdx + i + ring.length) % ring.length];
    if (isCarrierHealthy(cand, redZonePct)) {
      // No prior carrier ⇒ this is the initial pick, not a handoff — only
      // report `stepped` when we actually moved off a previous carrier.
      return { connection: cand, stepped: prevIdx >= 0 };
    }
  }

  // Nothing healthy: fall back to the head of the ring and let the normal
  // 429/lock path handle it (better than returning null and failing the request).
  return { connection: ring[0], stepped: prevIdx !== 0 };
}
