// AutoClaw（智谱澳龙）每日签到 — 自动领取调度器（国际 + 国内两条线）。
//
// 签到 = 任务面 POST /autoclaw-proxy/proxy/autoclaw-task-complete
// { task_id: "daily_signin" }（服务端幂等；文档里的 /userapi/v1/user-info
// 实测 code:0 但不给分）。端点两域同路径同形状，按连接 token 的 JWT
// source_id 选域（国内号打国内域）。移植自 AutoClaw2api handler/autoclaim.go
// 与 opencode-autoclaw-auth 的 dailySignin。
//
// Scheduler ticks every ~2h (+ jitter)，与 meooCheckin / qoderCheckin 同构：
// 当日已闭环（claimed，或 already_completed）的账号 memoize，当天不再触发；
// 失败/无凭证不记，下一轮还试。签到前经 checkAndRefreshToken 取鲜 token——
// refresh token 轮换由框架原子落库，调度器不自己写凭据。Setting key:
// autoclawCheckin（默认关）。手动触发：POST /api/oauth/{autoclaw|autoclaw-cn}/checkin。

import * as log from "../utils/logger.js";

const TICK_MS = 2 * 60 * 60 * 1000;
const TICK_JITTER_MS = 10 * 60 * 1000;
export const AUTOCLAW_CHECKIN_PROVIDERS = ["autoclaw", "autoclaw-cn"];

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
  const raw = settings?.autoclawDailyDone;
  doneMap = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
  return doneMap;
}

// 北京时间日界：上游任务按北京时间换日（opencode-autoclaw-auth 同口径）。
export function dayKey(nowMs = Date.now()) {
  const d = new Date(nowMs + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function accountLabel(conn) {
  const head = conn.provider === "autoclaw-cn" ? "AutoClaw CN" : "AutoClaw";
  return `${head}: ${conn.name || conn.displayName || conn.email || `${String(conn.id || "?").slice(0, 8)}…`}`;
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
    await updateSettings({ autoclawDailyDone: pruned });
    for (const k of Object.keys(doneMap)) delete doneMap[k];
    Object.assign(doneMap, pruned);
  } catch (err) {
    log.warn("AUTOCLAW_CHECKIN", `Persist daily-done map failed: ${err?.message ?? String(err)}`);
  }
}

export function isEligibleAutoclawConnection(conn) {
  if (!conn || conn.isActive === false || conn.external) return false;
  if (!AUTOCLAW_CHECKIN_PROVIDERS.includes(conn.provider)) return false;
  return Boolean(
    (typeof conn.accessToken === "string" && conn.accessToken.trim()) ||
      (typeof conn.refreshToken === "string" && conn.refreshToken.trim())
  );
}

/**
 * Claim today's sign-in for one connection. Refreshes first when the access
 * token is due (the framework persists the rotated pair), then calls the
 * task endpoint on the token's own region.
 */
export async function claimAutoclawCheckin(conn, { proxyOptions = null, deps = {} } = {}) {
  const { checkAndRefreshToken } = deps.checkAndRefreshToken
    ? deps
    : await import("./tokenRefresh.js");
  const { claimAutoclawDailySignin, autoclawRegionFor } = deps.claimAutoclawDailySignin
    ? deps
    : await import("open-sse/shared/autoclaw/client.js");
  const creds = await checkAndRefreshToken(conn.provider, { ...conn, connectionId: conn.id });
  const token = creds?.accessToken;
  if (!token) return { claimed: false, already: false, points: 0, streak: 0, message: "无可用登录凭据" };
  const region = autoclawRegionFor(conn.provider, creds);
  return claimAutoclawDailySignin(token, { region, proxyOptions });
}

/**
 * Execute a check-in run across eligible AutoClaw connections.
 * Exported for tests and the manual route; the scheduler calls it via safeTick.
 * @param {{ provider?: string|null, skipIfCheckedToday?: boolean, doneMap?: object|null }} opts
 */
export async function runAutoclawCheckinTick({ provider = null, skipIfCheckedToday = true, doneMap: injectedDone = null } = {}) {
  const { getProviderConnections } = await import("../../lib/localDb.js");
  const { resolveConnectionProxyConfig } = await import("../../lib/network/connectionProxy.js");

  const done = injectedDone || (await getDoneMap());
  const providers = provider ? [provider] : AUTOCLAW_CHECKIN_PROVIDERS;
  const conns = [];
  for (const p of providers) conns.push(...((await getProviderConnections({ provider: p })) || []));
  const eligible = conns.filter(isEligibleAutoclawConnection);
  if (eligible.length === 0) {
    log.debug("AUTOCLAW_CHECKIN", "Tick: no eligible AutoClaw connections");
    return [];
  }
  const today = dayKey();
  const results = [];

  for (const conn of eligible) {
    const label = accountLabel(conn);
    if (skipIfCheckedToday && done[conn.id] === today) {
      log.debug("AUTOCLAW_CHECKIN", `${label}: 已闭环，跳过`);
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
      const r = await claimAutoclawCheckin(conn, { proxyOptions });
      results.push({ id: conn.id, label, ...r });
      if (r.claimed || r.already) {
        done[conn.id] = today;
        log.info("AUTOCLAW_CHECKIN", `${label}：${r.message}`);
      } else {
        log.warn("AUTOCLAW_CHECKIN", `${label}：${r.message}`);
      }
    } catch (err) {
      log.warn("AUTOCLAW_CHECKIN", `${label}：${err?.message ?? String(err)}`);
      results.push({ id: conn.id, label, claimed: false, already: false, points: 0, streak: 0, message: String(err?.message ?? err) });
    }
  }

  await persistDoneMap();
  return results;
}

async function safeTick(how) {
  try {
    const settings = await loadSettingsSafe();
    if (settings.autoclawCheckin !== true) {
      log.debug("AUTOCLAW_CHECKIN", `Scheduled ${how}: setting off, skipping`);
      return;
    }
    const done = await getDoneMap();
    await runAutoclawCheckinTick({ skipIfCheckedToday: true, doneMap: done });
  } catch (err) {
    log.warn("AUTOCLAW_CHECKIN", `定时签到（${how}）失败：${err?.message ?? String(err)}`);
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
  log.debug("AUTOCLAW_CHECKIN", `下次签到约 ${Math.round(delayMs / 60000)}m 后`);
  return delayMs;
}

/**
 * Start the scheduler. Runs an immediate boot pass then ticks every ~2h.
 * @returns {boolean} true if started this call
 */
export function startAutoclawCheckin() {
  if (started) return false;
  if (isNonServerRuntime()) {
    log.debug("AUTOCLAW_CHECKIN", "Skip start outside long-running server runtime");
    return false;
  }
  started = true;
  safeTick("boot");
  scheduleNext();
  return true;
}

export function stopAutoclawCheckin() {
  if (!started) return false;
  started = false;
  clearTimer();
  return true;
}

/** Test hooks: reset in-memory scheduler state. */
export function _resetAutoclawCheckinState() {
  started = false;
  doneMap = null;
  clearTimer();
}
