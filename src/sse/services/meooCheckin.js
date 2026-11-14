// Meoo（秒悟）每日领积分 — 自动领取调度器。
//
// Meoo 每天**首次登录**送 2000 积分（daily_login 权益），没有领取端点——
// 「领取」= 做一次登录等价动作（OAuth 强制刷新 / 控制面 Key 身份读），
// 再以积分账面 totalGranted 差值核验是否到账。核心例程在
// src/app/api/usage/[connectionId]/meoo-daily-claim/route.js 的
// claimMeooDailyPoints（HTTP 路由与调度器共用同一份实现）。
//
// Scheduler ticks every ~2h (+ jitter)，与 qoderCheckin / traeCheckin 同构：
// 当日已闭环（claimed=true，或「今日可能已领取」= 已领过的判定）的账号
// memoize，当天不再重复触发；失败/无凭证不记，下一轮还试。Setting key:
// meooCheckin。

import * as log from "../utils/logger.js";

const TICK_MS = 2 * 60 * 60 * 1000;
const TICK_JITTER_MS = 10 * 60 * 1000;
// claimed=false 且带「今日可能已领取」的判定也算当日闭环：再触发也只是
// 白做一次登录动作，账面不会变。
const ALREADY_CLAUSED_RE = /今日可能已领取/;

let started = false;
let timerHandle = null;
let doneMap = null;

function isNonServerRuntime() {
  if (typeof window !== "undefined") return true;
  const phase = process.env.NEXT_PHASE || "";
  if (phase === "phase-production-build" || phase === "phase-export" || phase === "phase-static") return true;
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
  const raw = settings?.meooDailyDone;
  doneMap = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
  return doneMap;
}

function dayKey(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function accountLabel(conn) {
  return `Meoo: ${conn.name || conn.displayName || conn.email || `${String(conn.id || "?").slice(0, 8)}…`}`;
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
    await updateSettings({ meooDailyDone: pruned });
    for (const k of Object.keys(doneMap)) delete doneMap[k];
    Object.assign(doneMap, pruned);
  } catch (err) {
    log.warn("MEOO_CHECKIN", `Persist daily-done map failed: ${err?.message ?? String(err)}`);
  }
}

export function isEligibleMeooConnection(conn) {
  if (!conn || conn.isActive === false) return false;
  if (conn.provider !== "meoo" || conn.external) return false;
  const psd = conn.providerSpecificData || {};
  return Boolean(
    (typeof conn.accessToken === "string" && conn.accessToken.trim()) ||
      (typeof psd.meooControlKey === "string" && psd.meooControlKey.trim())
  );
}

/**
 * Execute an auto-claim run across all eligible Meoo connections.
 * Exported for tests; the scheduler calls it via safeTick.
 */
export async function runMeooCheckinTick({ skipIfCheckedToday = true, doneMap: injectedDone = null } = {}) {
  const { getProviderConnections } = await import("../../lib/localDb.js");
  const { claimMeooDailyPoints } = await import(
    "../../app/api/usage/[connectionId]/meoo-daily-claim/route.js"
  );
  const { resolveConnectionProxyConfig } = await import("../../lib/network/connectionProxy.js");

  const done = injectedDone || (await getDoneMap());
  const conns = (await getProviderConnections({ provider: "meoo" })) || [];
  const eligible = conns.filter(isEligibleMeooConnection);
  if (eligible.length === 0) {
    log.debug("MEOO_CHECKIN", "Tick: no eligible Meoo connections");
    return [];
  }
  const today = dayKey();
  const results = [];

  for (const conn of eligible) {
    const label = accountLabel(conn);
    if (skipIfCheckedToday && done[conn.id] === today) {
      log.debug("MEOO_CHECKIN", `${label}: 已闭环，跳过`);
      continue;
    }
    try {
      const proxyConfig = await resolveConnectionProxyConfig(conn.providerSpecificData);
      const proxyOptions = {
        connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
        connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
        connectionNoProxy: proxyConfig.connectionNoProxy || "",
        vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
        strictProxy: false,
      };
      const r = await claimMeooDailyPoints(conn, proxyOptions);
      results.push({ id: conn.id, label, ...r });
      if (r.claimed === true) {
        done[conn.id] = today;
        log.info("MEOO_CHECKIN", `${label}：${r.message}`);
      } else if (ALREADY_CLAUSED_RE.test(String(r.message || ""))) {
        // 已领过的判定也算闭环——再触发只是白做动作
        done[conn.id] = today;
        log.debug("MEOO_CHECKIN", `${label}：${r.message}`);
      } else {
        log.warn("MEOO_CHECKIN", `${label}：${r.message}`);
      }
    } catch (err) {
      log.warn("MEOO_CHECKIN", `${label}：${err?.message ?? String(err)}`);
      results.push({ id: conn.id, label, claimed: false, delta: 0, balance: null, message: String(err?.message ?? err) });
    }
  }

  await persistDoneMap();
  return results;
}

async function safeTick(how) {
  try {
    const settings = await loadSettingsSafe();
    if (settings.meooCheckin !== true) {
      log.debug("MEOO_CHECKIN", `Scheduled ${how}: setting off, skipping`);
      return;
    }
    const done = await getDoneMap();
    await runMeooCheckinTick({ skipIfCheckedToday: true, doneMap: done });
    await persistDoneMap();
  } catch (err) {
    log.warn("MEOO_CHECKIN", `定时领取（${how}）失败：${err?.message ?? String(err)}`);
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
  log.debug("MEOO_CHECKIN", `下次领取约 ${Math.round(delayMs / 60000)}m 后`);
  return delayMs;
}

/**
 * Start the scheduler. Runs an immediate boot pass then ticks every ~2h.
 * @returns {boolean} true if started this call
 */
export function startMeooCheckin() {
  if (started) return false;
  if (isNonServerRuntime()) {
    log.debug("MEOO_CHECKIN", "Skip start outside long-running server runtime");
    return false;
  }
  started = true;
  safeTick("boot");
  scheduleNext();
  return true;
}

export function stopMeooCheckin() {
  if (!started) return false;
  started = false;
  clearTimer();
  return true;
}

/** Test hooks: reset in-memory scheduler state. */
export function _resetMeooCheckinState() {
  started = false;
  doneMap = null;
  clearTimer();
}
