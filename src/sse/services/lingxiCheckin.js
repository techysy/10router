// Lingxi auto daily check-in (每日灵点领取).
//
// Mirrors qoderCheckin: ticks every ~2h (+ jitter); an account is checked until
// today's check-in is confirmed (or already claimed), then memoized in
// `lingxiDailyDone` for the rest of the day. The claim protocol itself never
// blind-fires — the tasks endpoint's "claimed" state gates the POST (see
// open-sse/services/lingxiCheckin.js).
//
// Gated by settings.lingxiCheckin (default off), same opt-in contract as the
// qoder/minimax/trae/meoo schedulers; each tick re-reads the flag, so turning
// it off needs no restart.

import * as log from "../utils/logger.js";
import { lingxiDailyCheckin } from "../../../open-sse/services/lingxiCheckin.js";

const TICK_MS = 2 * 60 * 60 * 1000;
const TICK_JITTER_MS = 10 * 60 * 1000;

let started = false;
let timerHandle = null;
let doneMap = null;

function isNonServerRuntime() {
  if (typeof window !== "undefined") return true;
  const phase = process.env.NEXT_PHASE || "";
  if (phase === "phase-production-build" || phase === "phase-export" || phase === "phase-static") {
    return true;
  }
  if (process.env.NEXT_RUNTIME === "edge") return true;
  return false;
}

export function msUntilNextTick(nowMs = Date.now(), rand = Math.random) {
  const jitter = Math.floor(rand() * TICK_JITTER_MS);
  return Math.max(TICK_MS + jitter, 1000);
}

async function loadSettingsSafe() {
  try {
    const { getSettings } = await import("../../lib/localDb.js");
    return (await getSettings()) || {};
  } catch {
    return {};
  }
}

async function getDoneMap() {
  if (doneMap) return doneMap;
  const settings = await loadSettingsSafe();
  const raw = settings?.lingxiDailyDone;
  doneMap = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
  return doneMap;
}

function dayKey(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function persistDoneMap() {
  if (!doneMap) return;
  const today = dayKey();
  const pruned = {};
  for (const [id, day] of Object.entries(doneMap)) {
    if (day === today) pruned[id] = day;
  }
  try {
    const { updateSettings } = await import("../../lib/localDb.js");
    await updateSettings({ lingxiDailyDone: pruned });
    for (const k of Object.keys(doneMap)) delete doneMap[k];
    Object.assign(doneMap, pruned);
  } catch (err) {
    log.warn("LINGXI_CHECKIN", `Persist daily-done map failed: ${err?.message ?? String(err)}`);
  }
}

function accountLabel(conn) {
  const name = conn.name || conn.displayName || conn.email || `${String(conn.id || "?").slice(0, 8)}…`;
  return `Lingxi: ${name}`;
}

function fmtDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

// The cookie jar lives in apiKey (new rows) or accessToken (CD-transfer legacy,
// #133 fallback) — same priority the usage handler uses.
export function isEligibleLingxiConnection(conn) {
  if (!conn || conn.isActive === false) return false;
  if (conn.provider !== "lingxi") return false;
  const cookie = conn.apiKey || conn.accessToken;
  return typeof cookie === "string" && cookie.trim().length > 0;
}

/**
 * Check in a single Lingxi connection.
 */
export async function checkinOneLingxi(conn, deps = {}) {
  const cookie = conn.apiKey || conn.accessToken;
  try {
    const outcome = await lingxiDailyCheckin({ cookie, proxyOptions: deps.proxyOptions ?? null });
    return { connectionId: conn.id, account: conn.name || conn.email || conn.id, ...outcome };
  } catch (err) {
    return {
      connectionId: conn.id,
      account: conn.name || conn.email || conn.id,
      status: "failed",
      error: err?.message || String(err),
    };
  }
}

/**
 * One check-in pass over every eligible connection.
 * Exported for tests and for the settings toggle's immediate first pass.
 */
export async function runLingxiCheckinTick(deps = {}) {
  const { getProviderConnections } = await import("../../lib/localDb.js");
  const connections = await getProviderConnections();
  const eligible = (connections || []).filter(isEligibleLingxiConnection);
  if (eligible.length === 0) {
    log.debug("LINGXI_CHECKIN", "Tick: no eligible Lingxi connections");
    return [];
  }

  log.debug("LINGXI_CHECKIN", `签到轮次开始：${eligible.map((c) => accountLabel(c)).join("、")}`);

  const memo = deps.doneMap || (await getDoneMap());
  const today = dayKey(deps.nowMs);
  const results = [];

  for (const conn of eligible) {
    try {
      if (deps.skipIfCheckedToday && memo[conn.id] === today) {
        results.push({ connectionId: conn.id, account: conn.name || conn.email || conn.id, status: "already", memoized: true });
        continue;
      }

      const checkinFn = deps.checkinConnection || checkinOneLingxi;
      const outcome = await checkinFn(conn, { ...deps });
      results.push(outcome);

      if (outcome.status === "checked-in") {
        memo[conn.id] = today;
        log.info("LINGXI_CHECKIN", `${accountLabel(conn)} 签到成功 +${outcome.claimedAmount} 灵点`);
      } else if (outcome.status === "already") {
        memo[conn.id] = today;
        log.debug("LINGXI_CHECKIN", `${accountLabel(conn)}：${outcome.message || "今日已签到"}`);
      } else {
        log.warn("LINGXI_CHECKIN", `${accountLabel(conn)} 签到失败：${outcome.message || outcome.error || outcome.status}`);
      }
    } catch (err) {
      results.push({
        connectionId: conn.id,
        account: conn.name || conn.id,
        status: "failed",
        error: err?.message || String(err),
      });
      log.warn("LINGXI_CHECKIN", `${accountLabel(conn)} 签到异常：${err?.message || err}`);
    }
  }

  const claimed = results.filter((r) => r.status === "checked-in");
  const failed = results.filter((r) => r.status === "failed");
  const already = results.length - claimed.length - failed.length;
  const totalCredits = claimed.reduce((a, r) => a + (r.claimedAmount || 0), 0);
  const summary = `签到汇总：成功 ${claimed.length}（+${totalCredits} 灵点）、已签 ${already}、失败 ${failed.length}`;
  if (claimed.length > 0 || failed.length > 0) {
    log.info("LINGXI_CHECKIN", summary);
  } else {
    log.debug("LINGXI_CHECKIN", summary);
  }

  await persistDoneMap();
  return results;
}

async function safeTick(how) {
  try {
    const settings = await loadSettingsSafe();
    if (settings.lingxiCheckin !== true) {
      log.debug("LINGXI_CHECKIN", `Scheduled ${how}: setting off, skipping`);
      return;
    }
    const done = await getDoneMap();
    await runLingxiCheckinTick({ skipIfCheckedToday: true, doneMap: done });
    await persistDoneMap();
  } catch (err) {
    log.warn("LINGXI_CHECKIN", `定时签到（${how}）失败：${err?.message ?? String(err)}`);
  }
}

function clearTimer() {
  if (timerHandle) {
    clearTimeout(timerHandle);
    timerHandle = null;
  }
}

function scheduleNext() {
  if (!started) return 0;
  const delayMs = msUntilNextTick();
  clearTimer();
  timerHandle = setTimeout(() => {
    safeTick("tick").finally(() => scheduleNext());
  }, delayMs);
  if (timerHandle && typeof timerHandle.unref === "function") {
    timerHandle.unref();
  }
  log.debug("LINGXI_CHECKIN", `下次签到约 ${fmtDuration(delayMs)} 后`);
  return delayMs;
}

/**
 * Start the scheduler. Runs an immediate boot pass then ticks every ~2h.
 * @param {{ skipBoot?: boolean }} [opts]
 * @returns {boolean} true if started this call
 */
export function startLingxiCheckin(opts = {}) {
  if (started) return false;
  if (isNonServerRuntime()) {
    log.debug("LINGXI_CHECKIN", "Skip start outside long-running server runtime");
    return false;
  }
  started = true;

  if (opts.skipBoot !== true) {
    safeTick("boot");
  }
  const delayMs = scheduleNext();
  log.info("LINGXI_CHECKIN", `自动签到调度已启动（全天轮询）— 下次约 ${fmtDuration(delayMs)} 后`);
  return true;
}

export function stopLingxiCheckin() {
  clearTimer();
  if (started) {
    started = false;
    log.info("LINGXI_CHECKIN", "Scheduler stopped");
  }
}
