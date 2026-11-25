// Daily-grant midnight reset scheduler — the reopen half of the
// "每日赠送积分优先" policy (2026-11-12, user spec):
//
//   烧尽自动关闭（auth.js dailyRelay）→ 当日不再服务
//   0 点自动重开（本调度器）→ 新一天的每日赠送重新可用
//
// What it does at local midnight:
//   1. Reopen connections that were auto-disabled by the drain guard
//      (`isActive:false` + a drained dailyGrantRemaining snapshot).
//   2. Reset the persisted snapshot to the full grant
//      (`dailyGrantRemaining = dailyGrantTotal`) so the very first request after
//      midnight routes to a healthy carrier without waiting for a usage fetch.
//
// Scope: only providers whose per-provider strategy has `dailyGrantFirst === true`
// (Loomy today — DAILY_GRANT_PROVIDERS in the providers page gates the toggle).
// A connection is "ours to touch" when it carries BOTH markers this system wrote:
// `dailyGrantRemaining` (the snapshot) and `dailyGrantAutoDisabled` (the drain
// guard's stamp — see auth.js). A connection the user disabled manually (no
// stamp) is left alone: the scheduler must never resurrect a deliberate choice.
//
// The flag is re-read on every tick, so toggling the strategy off stops the
// behavior without a restart. Toggling it ON is wired from PATCH /api/settings
// (same pattern as the checkin schedulers).

import * as log from "../utils/logger.js";

let started = false;
let timerHandle = null;

const TICK_JITTER_MS = 5 * 60 * 1000; // ±5 min around midnight

function isNonServerRuntime() {
  if (typeof window !== "undefined") return true;
  const phase = process.env.NEXT_PHASE || "";
  if (phase === "phase-production-build" || phase === "phase-export" || phase === "phase-static") return true;
  if (process.env.NEXT_RUNTIME === "edge") return true;
  return false;
}

// ms until the next local midnight (scheduler anchor — same day boundary the
// daily grants themselves refresh on; see nextMidnightMs in auth.js).
export function msUntilMidnight(nowMs = Date.now()) {
  const d = new Date(nowMs);
  d.setHours(24, 0, 0, 0);
  return d.getTime() - nowMs;
}

/**
 * One reset pass. Exported for tests and for the settings toggle to run an
 * immediate pass when the strategy is first enabled mid-day (a drain happened
 * before the toggle existed).
 */
export async function runDailyGrantResetTick() {
  const { getSettings, getProviderConnections, updateProviderConnection } = await import("../../lib/localDb.js");
  const settings = await getSettings();
  const strategies = settings?.providerStrategies || {};
  const grantProviders = Object.entries(strategies)
    .filter(([, o]) => o?.dailyGrantFirst === true)
    .map(([p]) => p);
  if (grantProviders.length === 0) return { reopened: 0, reset: 0 };

  let reopened = 0;
  let reset = 0;
  for (const providerId of grantProviders) {
    // 全量取（含 isActive:false）：要找的正是被烧尽守卫关掉的号。
    const conns = await getProviderConnections({ provider: providerId });
    for (const c of conns) {
      if (c.dailyGrantAutoDisabled !== true) continue;
      const total = typeof c.dailyGrantTotal === "number" && c.dailyGrantTotal > 0 ? c.dailyGrantTotal : null;
      await updateProviderConnection(c.id, {
        isActive: true,
        dailyGrantRemaining: total ?? 0,
        dailyGrantAutoDisabled: false,
        ...(total != null ? {} : {}),
      });
      reopened += 1;
      if (total != null) reset += 1;
      log.info("DAILY_GRANT_RESET", `${providerId} | reopened ${c.id?.slice(0, 8)} (${c.name || c.email || "unnamed"}) — daily grant reset${total != null ? ` to ${total}` : ""}`);
    }
  }
  if (reopened > 0) {
    log.info("DAILY_GRANT_RESET", `midnight reset done: ${reopened} reopened, ${reset} snapshots reset`);
  }
  return { reopened, reset };
}

function clearTimer() {
  if (timerHandle) {
    clearTimeout(timerHandle);
    timerHandle = null;
  }
}

function scheduleNext() {
  const delayMs = Math.max(1000, msUntilMidnight() + Math.floor(Math.random() * TICK_JITTER_MS));
  timerHandle = setTimeout(async () => {
    try {
      await runDailyGrantResetTick();
    } catch (e) {
      log.warn("DAILY_GRANT_RESET", `tick failed: ${e.message}`);
    }
    scheduleNext();
  }, delayMs);
  if (typeof timerHandle.unref === "function") timerHandle.unref();
  return delayMs;
}

/**
 * Start the midnight reset scheduler. Idempotent; no-ops outside the long-running
 * server runtime. Runs an immediate boot pass so drains that happened while the
 * server was down (or before this scheduler existed) are rolled back on boot —
 * the reopen must not wait a full day to first fire.
 */
export function startDailyGrantReset(opts = {}) {
  if (started) return false;
  if (isNonServerRuntime()) {
    log.debug("DAILY_GRANT_RESET", "Skip start outside long-running server runtime");
    return false;
  }
  started = true;
  if (opts.skipBoot !== true) {
    runDailyGrantResetTick().catch((e) => log.warn("DAILY_GRANT_RESET", `boot pass failed: ${e.message}`));
  }
  const delayMs = scheduleNext();
  log.info("DAILY_GRANT_RESET", `midnight reset scheduler started — next tick in ${Math.round(delayMs / 60000)} min`);
  return true;
}

export function stopDailyGrantReset() {
  clearTimer();
  if (started) {
    started = false;
    log.info("DAILY_GRANT_RESET", "Scheduler stopped");
  }
}
