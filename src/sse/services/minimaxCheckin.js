// MiniMax Code 每日签到（免费体验包算力币）— minimax-code / minimax-code-global。
//
// 免费体验包的算力币靠每日签到累积（signin/status → status:3 = 已领、1 = 待领，
// POST signin/claim 领取；接口幂等）。鉴权直接用 10R 订阅线连接上已有的
// accessToken（与 M Plan 用量探针同一把）——签到是账号动作，不是路由动作。
//
// 边界（issue #75 讨论）：本服务只扫订阅线连接；minimax-free 免登录网关线的
// 签到与配额都在 CreditDaddy 内闭环，10R 不做、也不显示任何签到入口。
//
// Scheduler ticks every ~2h (+ jitter), same shape as qoderCheckin: an account
// is checked until today's claim is confirmed, then memoized for the rest of
// the day. Setting key: minimaxCheckin.

import * as log from "../utils/logger.js";
import { DEFAULT_CHECKIN_TIME, checkinTimeReached, nextCheckinDelay, normalizeCheckinTime } from "./checkin/schedule.js";
import { signedAccountRequest } from "../../../open-sse/services/usage/minimax-code.js";

const MINIMAX_PROVIDERS = new Set(["minimax-code", "minimax-code-global"]);

let started = false;
let timerHandle = null;
let scheduledTime = DEFAULT_CHECKIN_TIME;
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
  const raw = settings?.minimaxDailyDone;
  doneMap = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
  return doneMap;
}

function dayKey(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Human label for log lines — "MiniMax Code: name", never a bare UUID.
function accountLabel(conn) {
  const name = conn.provider === "minimax-code-global" ? "MiniMax Global" : "MiniMax Code";
  const id = conn.name || conn.displayName || conn.email || `${String(conn.id || "?").slice(0, 8)}…`;
  return `${name}: ${id}`;
}

function fmtDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
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
    await updateSettings({ minimaxDailyDone: pruned });
    for (const k of Object.keys(doneMap)) delete doneMap[k];
    Object.assign(doneMap, pruned);
  } catch (err) {
    log.warn("MINIMAX_CHECKIN", `Persist daily-done map failed: ${err?.message ?? String(err)}`);
  }
}

export function isEligibleMinimaxConnection(conn) {
  if (!conn || conn.isActive === false) return false;
  if (!MINIMAX_PROVIDERS.has(conn.provider)) return false;
  const token = conn.accessToken;
  return typeof token === "string" && token.trim().length > 0;
}

// Signed request for the signin endpoints (same signing scheme as the
// membership probe in usage/minimax-code.js — signedAccountRequest builds the
// full URL + headers). signedAccountRequest picks the verb from `body`:
// undefined → GET, anything else → POST. The two endpoints differ and the
// wrong verb is a bare 404, not a signature error:
//   signin/status → GET only  (POST = 404 "Not Found")
//   signin/claim  → POST only (GET  = 404 "Not Found")
function signinRequest(conn, path, body) {
  const site = conn.provider === "minimax-code-global"
    ? { agent: "https://agent.minimax.io", lang: "en" }
    : { agent: "https://agent.minimax.cn", lang: "zh" };
  return signedAccountRequest(site, path, {
    access: conn.accessToken,
    userID: conn.providerSpecificData?.realUserID,
    body,
  });
}

/**
 * Check in a single MiniMax connection (status → claim if pending).
 * Status shape mirrors checkinOneQoder so the dashboard can render both the
 * same way.
 */
export async function checkinOneMinimax(conn, deps = {}) {
  const fetchFn = deps.fetch || fetch;
  const token = conn.accessToken;
  const base = {
    connectionId: conn.id,
    account: conn.name || conn.email || conn.id,
    provider: conn.provider,
  };

  if (!token) {
    return { ...base, status: "failed", error: "Token unavailable" };
  }

  try {
    // 1. Status
    const { url: statusUrl, init: statusInit } = signinRequest(conn, "/minimax-cloud/api/v1/signin/status");
    const statusRes = await fetchFn(statusUrl, {
      ...statusInit,
      signal: AbortSignal.timeout(15000),
    });
    if (statusRes.status === 401 || statusRes.status === 403) {
      return { ...base, status: "failed", error: `Authentication failed (${statusRes.status})` };
    }
    if (!statusRes.ok) {
      return { ...base, status: "failed", error: `Status check failed: HTTP ${statusRes.status}` };
    }
    const statusData = await statusRes.json().catch(() => null);
    const br = statusData?.base_resp;
    if (!statusData || (br && br.status_code !== 0)) {
      return { ...base, status: "failed", error: `Status check error: ${br?.status_msg || "unknown"}` };
    }

    const today = (statusData?.data?.days || []).find((d) => d.is_today);
    // status: 3 = already claimed, 1 = pending
    if (today && today.status === 3) {
      return {
        ...base,
        status: "already",
        message: `今日第 ${today.day_no || 1} 天已签到（+${(today.points || 0) + (today.bonus_points || 0)} 积分）`,
        claimedAmount: 0,
      };
    }

    // 2. Claim
    const { url: claimUrl, init: claimInit } = signinRequest(conn, "/minimax-cloud/api/v1/signin/claim", {});
    const claimRes = await fetchFn(claimUrl, {
      ...claimInit,
      signal: AbortSignal.timeout(15000),
    });
    if (claimRes.status === 401 || claimRes.status === 403) {
      return { ...base, status: "failed", error: `Authentication failed (${claimRes.status})` };
    }
    if (!claimRes.ok) {
      return { ...base, status: "failed", error: `Claim failed: HTTP ${claimRes.status}` };
    }
    const claimData = await claimRes.json().catch(() => null);
    const cbr = claimData?.base_resp;
    if (!claimData || (cbr && cbr.status_code !== 0)) {
      return { ...base, status: "failed", error: `Claim error: ${cbr?.status_msg || "unknown"}` };
    }

    const cdata = claimData.data || {};
    // claim_result: 1 = newly claimed, 2 = duplicate (already claimed today)
    const pts = Number(cdata.points) || ((today?.points || 0) + (today?.bonus_points || 0));
    if (cdata.claim_result === 2) {
      return {
        ...base,
        status: "already",
        message: `今日已领取（+${pts} 积分）`,
        claimedAmount: 0,
      };
    }
    return {
      ...base,
      status: "checked-in",
      message: `签到成功第 ${cdata.day_no || 1} 天（+${pts} 积分）`,
      claimedAmount: pts,
    };
  } catch (err) {
    return { ...base, status: "failed", error: err?.message || "Network error" };
  }
}

/**
 * Execute a check-in run across all eligible MiniMax connections.
 */
export async function runMinimaxCheckinTick(deps = {}) {
  const { getProviderConnections } = await import("../../lib/localDb.js");
  const conns = await getProviderConnections();

  const eligible = conns.filter(
    (c) => isEligibleMinimaxConnection(c) && (!deps.provider || c.provider === deps.provider)
  );
  if (eligible.length === 0) {
    log.debug("MINIMAX_CHECKIN", "Tick: no eligible MiniMax connections");
    return [];
  }

  log.debug("MINIMAX_CHECKIN", `领取轮次开始：${eligible.map((c) => accountLabel(c)).join("、")}`);

  const memo = deps.doneMap || (await getDoneMap());
  const today = dayKey(deps.nowMs);
  const results = [];

  for (const conn of eligible) {
    try {
      if (deps.skipIfCheckedToday && memo[conn.id] === today) {
        log.debug("MINIMAX_CHECKIN", `${accountLabel(conn)}：今日已确认完成，跳过`);
        results.push({ connectionId: conn.id, account: conn.name || conn.email || conn.id, provider: conn.provider, status: "already", memoized: true });
        continue;
      }

      const checkinFn = deps.checkinConnection || checkinOneMinimax;
      const outcome = await checkinFn(conn, { ...deps, doneMap: memo });
      results.push(outcome);

      if (outcome.status === "checked-in") {
        memo[conn.id] = today;
        log.info("MINIMAX_CHECKIN", `${accountLabel(conn)} 签到成功 +${outcome.claimedAmount} 积分`);
      } else if (outcome.status === "already") {
        memo[conn.id] = today;
        log.debug("MINIMAX_CHECKIN", `${accountLabel(conn)}：${outcome.message || "今日已签"}`);
      } else {
        log.warn("MINIMAX_CHECKIN", `${accountLabel(conn)} 签到失败：${outcome.error || outcome.status}`);
      }
    } catch (err) {
      results.push({
        connectionId: conn.id,
        account: conn.name || conn.id,
        provider: conn.provider,
        status: "failed",
        error: err?.message || String(err),
      });
      log.warn("MINIMAX_CHECKIN", `${accountLabel(conn)} 签到异常：${err?.message || err}`);
    }
  }

  const claimed = results.filter((r) => r.status === "checked-in");
  const failed = results.filter((r) => r.status === "failed");
  const already = results.length - claimed.length - failed.length;
  const totalPoints = claimed.reduce((a, r) => a + (r.claimedAmount || 0), 0);
  const summary = `签到汇总：成功 ${claimed.length}（+${totalPoints} 积分）、已签 ${already}、失败 ${failed.length}`;
  if (claimed.length > 0 || failed.length > 0) {
    log.info("MINIMAX_CHECKIN", summary);
  } else {
    log.debug("MINIMAX_CHECKIN", summary);
  }

  await persistDoneMap();
  return results;
}

async function safeTick(how) {
  try {
    const settings = await loadSettingsSafe();
    if (settings.minimaxCheckin !== true) {
      log.debug("MINIMAX_CHECKIN", `Scheduled ${how}: setting off, skipping`);
      return;
    }
    scheduledTime = normalizeCheckinTime(settings.checkinTime);
    if (!checkinTimeReached(scheduledTime)) {
      log.debug("MINIMAX_CHECKIN", `Scheduled ${how}: before check-in time ${scheduledTime}, skipping`);
      return;
    }
    const done = await getDoneMap();
    await runMinimaxCheckinTick({ skipIfCheckedToday: true, doneMap: done });
    await persistDoneMap();
  } catch (err) {
    log.warn("MINIMAX_CHECKIN", `定时签到（${how}）失败：${err?.message ?? String(err)}`);
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
  const delayMs = nextCheckinDelay(Date.now(), scheduledTime);
  clearTimer();
  timerHandle = setTimeout(() => {
    safeTick("tick").finally(() => scheduleNext());
  }, delayMs);
  if (timerHandle && typeof timerHandle.unref === "function") {
    timerHandle.unref();
  }
  log.debug("MINIMAX_CHECKIN", `下次签到约 ${fmtDuration(delayMs)} 后`);
  return delayMs;
}

/**
 * Start the scheduler. Runs an immediate boot pass then ticks every ~2h.
 * @param {{ skipBoot?: boolean }} [opts]
 * @returns {boolean} true if started this call
 */
export function startMinimaxCheckin(opts = {}) {
  if (started) return false;
  if (isNonServerRuntime()) {
    log.debug("MINIMAX_CHECKIN", "Skip start outside long-running server runtime");
    return false;
  }
  started = true;

  const boot = opts.skipBoot === true ? Promise.resolve() : safeTick("boot");
  boot.finally(() => {
    if (!started) return;
    const delayMs = scheduleNext();
    log.info("MINIMAX_CHECKIN", `每日签到调度已启动（每日 ${scheduledTime}）— 下次约 ${fmtDuration(delayMs)} 后`);
  });
  return true;
}

export function stopMinimaxCheckin() {
  clearTimer();
  if (started) {
    started = false;
    log.info("MINIMAX_CHECKIN", "Scheduler stopped");
  }
}
