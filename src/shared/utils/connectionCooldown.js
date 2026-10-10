// Single source of truth for "what state is this connection in, given its
// model locks?" (issue #46)
//
// The same heuristic used to be written out three times — providerCardOrder.js
// (counts on the providers list), ConnectionRow.js and ConnectionsCard.js (the
// two detail rows) — and each copy answered a two-way question (active vs
// unavailable), which forced a single boolean to stand in for what are really
// independent per-model states. Google/Antigravity bucket quota per model and
// we lock per model (markAccountUnavailable writes modelLock_<model>), so one
// model running out leaves every sibling model serving traffic for the rest of
// the window. Painting that row red and calling the account unavailable is what
// the reporter saw.
//
// The account-level flag is a separate, genuinely account-wide signal: it is
// written alongside the lock and cleared lazily (clearAccountError only resets
// testStatus once no locks remain), so an "unavailable" with no live lock means
// "recovered". That two-part reading is what all three sites were reaching for
// by hand; it is spelled out here once so they cannot drift.
//
// PURE and dependency-light on purpose: this is imported by client components
// (ConnectionRow / ConnectionsCard are "use client"), and vitest cannot import
// JSX .js files, so the logic lives here where it can be unit-tested for real
// instead of being pinned by source-text assertions like its callers must be.

import { MODEL_LOCK_ALL, MODEL_LOCK_PREFIX } from "open-sse/services/accountFallback.js";

/**
 * Classify one connection's live model locks.
 *
 * @param {object} connection - a connection row (flat modelLock_* fields)
 * @param {number} [now] - injectable clock, for tests
 * @returns {{
 *   state: "active" | "partial" | "unavailable",
 *   lockedModels: string[],   // models still cooling down, "__all" excluded
 *   accountLocked: boolean,   // a live modelLock___all
 *   earliestUntil: string|null // ISO of the soonest LIVE lock
 * }}
 *
 * state:
 *   "needs-reauth" — the refresh token is dead (unrecoverable refresh error) and
 *                   only re-authorization fixes it. Outranks every lock: it is
 *                    the one state that needs a human.
 *   "unavailable" — a live account-wide lock (modelLock___all). This is the one
 *                   case where "some models are fine" is not true.
 *   "partial"     — at least one model is cooling down but the account as a
 *                   whole is fine: sibling models still route. Amber, not red.
 *   "active"      — nothing is cooling down (and, absent a testStatus, a
 *                   connection that simply has never been probed).
 *   anything else — the connection's own testStatus, passed through untouched
 *                   ("error", "unknown", …). This helper is about cooldown
 *                   scope, not about re-deciding auth failures.
 *
 * Note the deliberate absence of an "unavailable just because testStatus says
 * so" branch: that flag is written next to the lock and reset lazily
 * (clearAccountError only restores it once NO locks remain), so "unavailable
 * with nothing locked" means the account recovered. All three previous copies
 * relied on exactly this reading; folding it in here keeps them honest.
 */
export function classifyConnectionCooldown(connection, now = Date.now()) {
  const conn = connection || {};
  const lockedModels = [];
  let accountLocked = false;
  let earliestMs = null;

  for (const [key, value] of Object.entries(conn)) {
    if (!key.startsWith(MODEL_LOCK_PREFIX) || !value) continue;
    const until = new Date(value).getTime();
    if (Number.isNaN(until) || until <= now) continue; // expired or unparseable

    // Tracked in this same pass rather than via getEarliestModelLockUntil(),
    // which reads the wall clock itself and so cannot honour the injected `now`
    // these tests rely on.
    if (earliestMs === null || until < earliestMs) earliestMs = until;

    if (key === MODEL_LOCK_ALL) {
      accountLocked = true;
    } else {
      lockedModels.push(key.slice(MODEL_LOCK_PREFIX.length));
    }
  }

  const status = conn.testStatus;

  // "needs-reauth" outranks everything, locks included: it says the refresh
  // token is dead and only a human re-authorization fixes it. A per-model lock
  // hiding it behind an amber "partial" would bury the one state that needs
  // action (the mark is sticky and survives request successes — see
  // accountFallback.js).
  //
  // "error"/"expired" outrank everything else but an account-wide lock: they are
  // written by credential-test flows, so the credentials are genuinely broken
  // and a stale live model lock must not soften that into an amber "partial"
  // (or worse, count the connection as healthy). "unavailable" is different —
  // it is the lazily-cleared account flag, so a live per-model lock means
  // "partial" and a lapsed one means "recovered".
  const state = status === "needs-reauth"
    ? status
    : accountLocked
      ? "unavailable"
      : (status === "error" || status === "expired")
        ? status
        : lockedModels.length > 0
          ? "partial"
          : status === "unavailable"
            ? "active" // stale flag, every lock has lapsed → recovered
            : (status ?? "active");

  return {
    state,
    lockedModels,
    accountLocked,
    earliestUntil: earliestMs === null ? null : new Date(earliestMs).toISOString(),
  };
}

/**
 * Whether two classification results would render identically. Used by the
 * components' 1s tick to bail out of setState: classifyConnectionCooldown
 * returns a fresh object every call, and comparing by identity would re-render
 * a locked row every second even though nothing observable changed — the
 * countdown itself is CooldownTimer's own clock.
 */
export function sameConnectionCooldown(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.state === b.state
    && a.accountLocked === b.accountLocked
    && a.earliestUntil === b.earliestUntil
    && a.lockedModels.length === b.lockedModels.length
    && a.lockedModels.every((m, i) => m === b.lockedModels[i]);
}
