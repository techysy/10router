// Combo member transport circuit breaker (#176).
//
// A combo seat whose upstream is "假死" (accepts TCP, never returns response
// headers) is a TRANSPORT failure — no HTTP status comes back at all. That is a
// different animal from a real 4xx/5xx: those are handled by the account-level
// semantic cooldown (issue #91, errorConfig.js). This breaker only remembers
// transport-level dead seats ACROSS requests, so the second request does not
// re-pay the full probe budget on a member that was already found dead.
//
// Pure in-memory, process-scoped, deliberately NOT persisted: a restart clears
// it, and so does saving the combo / global settings (see resetComboBreaker /
// resetAllBreakers — a config edit must not be held hostage by an old trip).
//
// Two rules the issue is explicit about:
//   - a cooled member is DEFERRED, never dropped. If every other member also
//     fails, the cooled one still runs as the last resort (partition order in
//     combo.js) — a live-but-flaky channel must not be removed from rotation.
//   - any real HTTP answer resets the streak. Only "no response at all" counts,
//     so this never double-counts with #91's account cooldown.

// Positive-integer env override, same shape as runtimeConfig's envMs (that
// helper is module-private, and importing a second copy would only drift).
function envMs(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

// Consecutive transport failures before the seat cools down. One flaky timeout
// should not retire a member; two back-to-back with nothing in between means the
// upstream is genuinely not answering.
export const TRANSPORT_TRIP_THRESHOLD = envMs("COMBO_TRANSPORT_TRIP_THRESHOLD", 2);

// Base cooldown, doubling per additional trip, capped. 5min → 10min → … → 1h.
const BREAKER_BASE_MS = envMs("COMBO_TRANSPORT_COOLDOWN_MS", 5 * 60 * 1000);
const BREAKER_MAX_MS = envMs("COMBO_TRANSPORT_COOLDOWN_MAX_MS", 60 * 60 * 1000);

// comboName|memberModel -> { streak, trips, until (epoch ms) }
const breakers = new Map();

function key(comboName, memberModel) {
  return `${comboName}|${memberModel}`;
}

/**
 * Is this member currently cooling (should be pushed to the back of the seat
 * order)? Reads lazily expire: once a window has passed the streak resets and
 * the member gets probed again from scratch — but the trip COUNT survives, so a
 * member that keeps dying earns a longer window each time (the exponential
 * escalation the issue asks for). A full reset only comes from a real answer
 * (recordTransportSuccess) or a config edit.
 */
export function isTransportCooling(comboName, memberModel) {
  if (!comboName) return false;
  const rec = breakers.get(key(comboName, memberModel));
  if (!rec || !rec.until) return false;
  if (rec.until <= Date.now()) {
    // Window elapsed: re-open the seat for probing, keep the trip history so the
    // NEXT trip is longer. Clearing the record here would pin every dead member
    // to the base cooldown forever — no escalation, exactly the failure mode
    // "首撞之后每次都只等一个固定窗口" the issue is trying to avoid compounding.
    rec.streak = 0;
    rec.until = 0;
    return false;
  }
  return true;
}

/** How long (ms) this member still cools, or 0 when not cooling. */
export function transportCoolingRemainingMs(comboName, memberModel) {
  const rec = breakers.get(key(comboName, memberModel));
  if (!rec?.until) return 0;
  return Math.max(0, rec.until - Date.now());
}

/**
 * Record one transport-level failure for a member (a probe that got no HTTP
 * response). At the threshold the seat trips a cooldown; each further trip
 * doubles it up to the cap.
 *
 * @returns {{ trips: number, cooldownMs: number }} the new state (for logging)
 */
export function recordTransportFailure(comboName, memberModel) {
  if (!comboName) return { trips: 0, cooldownMs: 0 };
  const k = key(comboName, memberModel);
  const rec = breakers.get(k) || { streak: 0, trips: 0, until: 0 };
  rec.streak++;
  if (rec.streak < TRANSPORT_TRIP_THRESHOLD) {
    rec.until = 0;
    breakers.set(k, rec);
    return { trips: rec.trips, cooldownMs: 0 };
  }
  // Tripping: the Nth failure opens (or extends) a window. trips counts how many
  // windows this member has already burned through → exponential backoff.
  rec.trips++;
  const cooldownMs = Math.min(BREAKER_BASE_MS * 2 ** (rec.trips - 1), BREAKER_MAX_MS);
  rec.until = Date.now() + cooldownMs;
  breakers.set(k, rec);
  return { trips: rec.trips, cooldownMs };
}

/**
 * A member answered — any real HTTP status, or a success. Reset the streak and
 * drop the trip entirely: a channel that came back is not a dead seat, and
 * re-earning trust immediately is what "deferred, not removed" means.
 */
export function recordTransportSuccess(comboName, memberModel) {
  if (!comboName) return;
  breakers.delete(key(comboName, memberModel));
}

/** Drop every record for one combo (its definition changed → stale trips moot). */
export function resetComboBreaker(comboName) {
  if (!comboName) return;
  const prefix = `${comboName}|`;
  for (const k of breakers.keys()) {
    if (k.startsWith(prefix)) breakers.delete(k);
  }
}

/** Drop everything (global settings saved). */
export function resetAllBreakers() {
  breakers.clear();
}

// Test/diagnostic introspection — not used on the request path.
export function _breakState(comboName, memberModel) {
  return breakers.get(key(comboName, memberModel)) || null;
}
export function _breakCount() {
  return breakers.size;
}
