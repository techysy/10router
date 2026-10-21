// CodeBuddy auto daily check-in (CN). The intl daily active-session probe was
// removed 2026-10: CodeBuddy withdrew that campaign, so the pass had nothing
// left to earn while still spending a request per account per day.
//
// Checks every active codebuddy-cn connection into the CodeBuddy CN
// "billing meter" (daily-checkin) so free daily quota is renewed without user
// action. The scheduler ticks ALL DAY (~every 2h + jitter): an account is
// attempted only until the day's check-in is confirmed (status endpoint or a
// successful POST), then it is memoized for the rest of the local day — no
// more repeated "已签到" churn across the day.
//
// Fail-open everywhere: a tick error or a single connection failure never
// rejects the whole run or kills the server.

import * as log from "../utils/logger.js";
import { DEFAULT_CHECKIN_TIME, checkinTimeReached, nextCheckinDelay, normalizeCheckinTime } from "./checkin/schedule.js";
import { isNeedsReauthCooling } from "open-sse/services/accountFallback.js";

const DAILY_CHECKIN_URL = "https://www.codebuddy.cn/v2/billing/meter/daily-checkin";
const STATUS_URL = "https://www.codebuddy.cn/v2/billing/meter/checkin-activity-status";

// CodeBuddy CN compensation & gift claim endpoints (no /v2 prefix, same host & auth).
const COMPENSATION_STATUS_URL = "https://www.codebuddy.cn/billing/meter/compensation-status";
const CLAIM_COMPENSATION_URL = "https://www.codebuddy.cn/billing/meter/claim-compensation";
const GIFT_STATUS_URL = "https://www.codebuddy.cn/billing/meter/check-gift-claimed";
const CLAIM_GIFT_URL = "https://www.codebuddy.cn/billing/meter/claim-gift";

// All-day cadence: retry every ~2h (plus jitter) until each account is done
// for the day; the per-day memo keeps already-done accounts fully idle.

let started = false;
let timerHandle = null;
let scheduledTime = DEFAULT_CHECKIN_TIME;

// connId -> local "YYYY-MM-DD" the account was last confirmed done. Persisted
// in settings as `codeBuddyDailyDone` (lazy-loaded into this cache) so a
// restart doesn't re-verify already-done accounts until the day rolls over;
// entries are pruned to today on every write. The manual check-in route never
// touches this memo.
let doneMap = null;
let compensationDoneMap = null;

async function getDoneMap() {
  if (doneMap) return doneMap;
  const settings = await loadSettingsSafe();
  const raw = settings?.codeBuddyDailyDone;
  doneMap = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
  return doneMap;
}

async function getCompensationDoneMap() {
  if (compensationDoneMap) return compensationDoneMap;
  const settings = await loadSettingsSafe();
  const raw = settings?.codeBuddyCompensationDone;
  compensationDoneMap = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
  return compensationDoneMap;
}

// Write the in-memory memo back to settings, pruned to today. Called by the
// scheduler after each pass (the ticks only mutate the passed memo object).
async function persistDoneMap() {
  if (!doneMap) return;
  const today = dayKey();
  const pruned = {};
  for (const [id, day] of Object.entries(doneMap)) {
    if (day === today) pruned[id] = day;
  }
  try {
    const { updateSettings } = await import("../../lib/localDb.js");
    await updateSettings({ codeBuddyDailyDone: pruned });
    for (const k of Object.keys(doneMap)) delete doneMap[k];
    Object.assign(doneMap, pruned);
  } catch (err) {
    // Persist is best-effort — the in-memory cache still prevents same-process
    // repeats; a failed write just means one extra status check after restart.
    log.warn("CB_CN_CHECKIN", "Persist daily-done map failed (swallowed)", {
      error: err?.message ?? String(err),
    });
  }
}

async function persistCompensationDoneMap() {
  if (!compensationDoneMap) return;
  const today = dayKey();
  const pruned = {};
  for (const [id, day] of Object.entries(compensationDoneMap)) {
    if (day === today) pruned[id] = day;
  }
  try {
    const { updateSettings } = await import("../../lib/localDb.js");
    await updateSettings({ codeBuddyCompensationDone: pruned });
    for (const k of Object.keys(compensationDoneMap)) delete compensationDoneMap[k];
    Object.assign(compensationDoneMap, pruned);
  } catch (err) {
    log.warn("CB_CN_COMP", "Persist compensation-done map failed (swallowed)", {
      error: err?.message ?? String(err),
    });
  }
}

// ─── Pure helpers (unit-testable, no I/O) ──────────────────────────────────

function decodeJwt(jwt) {
  try {
    const seg = String(jwt).split(".")[1];
    const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(pad, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function isCodeBuddyCnRealm(iss) {
  return (
    typeof iss === "string" &&
    (iss.includes("codebuddy.cn") || iss.includes("copilot.tencent.com"))
  );
}

function dayKey(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Eligibility: an active codebuddy-cn OAuth connection whose access token is
 * signed by a CodeBuddy CN Keycloak realm (has an access token at all).
 * @param {object} conn
 * @returns {boolean}
 */
export function isEligibleCbcnConnection(conn) {
  if (!conn || !conn.accessToken) return false;
  if (conn.provider !== "codebuddy-cn") return false;
  if (conn.isActive === false) return false;
  // Needs-reauth cooling: the token set is known-dead. A check-in would 401,
  // its refresh re-marks the account and re-extends the cooldown window forever.
  if (isNeedsReauthCooling(conn)) return false;
  const claims = decodeJwt(conn.accessToken) || {};
  return isCodeBuddyCnRealm(claims.iss || "");
}

function isIdempotentAlready(msg) {
  if (typeof msg !== "string") return false;
  // CN "今天已签到" / generic "repeat/already" markers from the CodeBuddy gateway.
  return /已签到|签到过|重复签到|already|repeat/i.test(msg);
}

/**
 * Map a daily-checkin HTTP result to a stable status string.
 * @param {{ httpStatus: number, code?: number|string, msg?: string }} res
 * @returns {"checked-in"|"already"|"failed"}
 */
export function mapDailyCheckinStatus({ httpStatus, code, msg } = {}) {
  if (httpStatus >= 200 && httpStatus < 300) return "checked-in";
  // HTTP 400 + known idempotent codes/messages ⇒ already signed in today.
  if (httpStatus === 400) {
    if (code === 10001 || code === "10001" || isIdempotentAlready(msg)) return "already";
  }
  return "failed";
}

function isNonServerRuntime() {
  if (typeof window !== "undefined") return true;
  const phase = process.env.NEXT_PHASE || "";
  if (phase === "phase-production-build" || phase === "phase-export" || phase === "phase-static") {
    return true;
  }
  if (process.env.NEXT_RUNTIME === "edge") return true;
  return false;
}

// ─── Dynamic I/O (lazy imports to avoid circular/coupling at eval time) ────

async function loadActiveConnections() {
  const { getProviderConnections } = await import("../../lib/db/repos/connectionsRepo.js");
  return getProviderConnections({ provider: "codebuddy-cn" });
}

async function loadSettingsSafe() {
  try {
    const { getSettings } = await import("../../lib/localDb.js");
    return await getSettings();
  } catch {
    return {};
  }
}

// Reuse the existing proactive refresh pipeline (refreshes + persists the new
// access token) exactly like backgroundTokenRefresh on a 401.
async function refreshOne(provider, connection) {
  const { checkAndRefreshToken } = await import("./tokenRefresh.js");
  const creds = await checkAndRefreshToken(provider, connection, { force: true });
  return creds?.accessToken ? creds : null;
}

function proxyOptionsOf(conn) {
  return conn?.proxyOptions || {
    enabled: conn?.connectionProxyEnabled,
    url: conn?.connectionProxyUrl,
    noProxy: conn?.connectionNoProxy,
  };
}

function cnHeaders(accessToken, uid) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "X-User-Id": String(uid),
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

// One account check-in POST (no 401 retry here — caller decides) → raw result.
async function postCnApi(url, accessToken, uid, proxyOptions) {
  const { proxyAwareFetch } = await import("open-sse/utils/proxyFetch.js");
  const res = await proxyAwareFetch(
    url,
    { method: "POST", headers: cnHeaders(accessToken, uid), body: "{}" },
    proxyOptions
  );
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return {
    httpStatus: res.status,
    code: body?.code ?? body?.error_code,
    msg: body?.msg ?? body?.message,
    data: body?.data,
    rawBody: body,
  };
}

async function postDailyCheckin(accessToken, uid, proxyOptions) {
  return postCnApi(DAILY_CHECKIN_URL, accessToken, uid, proxyOptions);
}

async function postStatus(accessToken, uid, proxyOptions) {
  const { proxyAwareFetch } = await import("open-sse/utils/proxyFetch.js");
  const res = await proxyAwareFetch(
    STATUS_URL,
    { method: "POST", headers: cnHeaders(accessToken, uid), body: "{}" },
    proxyOptions
  );
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { httpStatus: res.status, body };
}

// Is the account already signed in today? Used by the scheduled pass so we
// don't re-check-in accounts that already renewed.
function isCheckedInToday(status) {
  const data = status?.body?.data || {};
  return status.httpStatus === 200 && (data.today_checked_in === true || data.checked_in === true);
}

/**
 * Check in one connection (with a single 401 → refresh → retry). Fail-open.
 * @param {object} conn
 * @param {{ refreshConnection?: Function }} deps
 * @returns {Promise<{status: string, error?: string}>}
 */
async function checkinOne(conn, deps) {
  const refresh = deps?.refreshConnection || ((c) => refreshOne("codebuddy-cn", c));
  let accessToken = conn.accessToken;
  const claims = decodeJwt(accessToken) || {};
  const uid = claims.sub || conn.id;
  const proxyOptions = proxyOptionsOf(conn);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await postDailyCheckin(accessToken, uid, proxyOptions);
      const status = mapDailyCheckinStatus(result);
      if (status !== "failed") return { status };
      // 401 (invalid/expired token) → refresh once and retry.
      if (result.httpStatus === 401 && attempt === 0) {
        log.info("CB_CN_CHECKIN", "401 on daily-check-in, refreshing token once", {
          id: conn.id,
        });
        const refreshed = await refresh(conn);
        if (refreshed?.accessToken) accessToken = refreshed.accessToken;
        else return { status: "failed", error: "refresh_failed" };
        continue;
      }
      return { status, error: result.msg || `http_${result.httpStatus}` };
    } catch (err) {
      return { status: "failed", error: err?.message || String(err) };
    }
  }
  return { status: "failed", error: "unexpected" };
}

// Prefer status-check to skip already-checked-in accounts.
async function checkinIfNotDone(conn, deps) {
  const proxyOptions = proxyOptionsOf(conn);
  const claims = decodeJwt(conn.accessToken) || {};
  const uid = claims.sub || conn.id;
  try {
    const status = await postStatus(conn.accessToken, uid, proxyOptions);
    if (isCheckedInToday(status)) return { status: "already" };
  } catch {
    // Status check is best-effort — fall through to a plain check-in.
  }
  return checkinOne(conn, deps);
}

export async function runCodebuddyCheckinTick(deps = {}) {
  const results = [];
  const load = deps.loadConnections || loadActiveConnections;
  let connections = [];
  try {
    connections = await load();
  } catch (err) {
    log.warn("CB_CN_CHECKIN", "Tick: failed to load codebuddy-cn connections (swallowed)", {
      error: err?.message ?? String(err),
    });
    return results;
  }

  const eligible = (Array.isArray(connections) ? connections : []).filter(isEligibleCbcnConnection);
  if (eligible.length === 0) {
    log.debug("CB_CN_CHECKIN", "Tick: no eligible codebuddy-cn connections", {
      total: Array.isArray(connections) ? connections.length : 0,
    });
    return results;
  }

  log.info("CB_CN_CHECKIN", "Daily check-in pass started", {
    eligible: eligible.length,
    ids: eligible.map((c) => c.id).filter(Boolean),
  });

  const memo = deps.memo || null;
  const today = dayKey();
  const checkin = deps.checkinConnection || (deps.skipIfCheckedToday ? checkinIfNotDone : checkinOne);

  for (const conn of eligible) {
    try {
      if (memo && memo[conn.id] === today) {
        log.debug("CB_CN_CHECKIN", `${conn.name || conn.id}: 已确认今日完成,跳过`, {
          id: conn.id,
        });
        continue;
      }
      const outcome = await checkin(conn, deps);
      if (memo && (outcome.status === "checked-in" || outcome.status === "already")) {
        memo[conn.id] = today;
      }
      results.push({
        id: conn.id,
        name: conn.name || conn.id,
        status: outcome.status,
        ...(outcome.error ? { error: outcome.error } : {}),
      });
      const statusLabel =
        outcome.status === "checked-in"
          ? "签到成功"
          : outcome.status === "already"
            ? "今日已签到"
            : `失败${outcome.error ? `(${outcome.error})` : ""}`;
      log.info("CB_CN_CHECKIN", `${conn.name || conn.id}: ${statusLabel}`, {
        id: conn.id,
      });
    } catch (err) {
      results.push({ id: conn.id, name: conn.name || conn.id, status: "failed" });
      log.warn("CB_CN_CHECKIN", "Connection check-in failed (swallowed)", {
        id: conn?.id,
        error: err?.message ?? String(err),
      });
    }
  }
  return results;
}

/**
 * Claim compensation and first-month gifts for one connection (with single 401 -> refresh -> retry).
 * @param {object} conn
 * @param {{ refreshConnection?: Function }} [deps]
 * @returns {Promise<{status: string, claimedAmount?: number, details?: Array, error?: string}>}
 */
export async function claimCompensationOne(conn, deps) {
  const refresh = deps?.refreshConnection || ((c) => refreshOne("codebuddy-cn", c));
  let accessToken = conn.accessToken;
  const claims = decodeJwt(accessToken) || {};
  const uid = claims.sub || conn.id;
  const proxyOptions = proxyOptionsOf(conn);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // 1. Check compensation status
      const compStatusRes = await postCnApi(COMPENSATION_STATUS_URL, accessToken, uid, proxyOptions);
      if (compStatusRes.httpStatus === 401 && attempt === 0) {
        log.info("CB_CN_COMP", "401 on compensation status, refreshing token once", { id: conn.id });
        const refreshed = await refresh(conn);
        if (refreshed?.accessToken) {
          accessToken = refreshed.accessToken;
          continue;
        }
        return { status: "failed", error: "refresh_failed" };
      }

      // 2. Check gift status (best effort)
      let giftStatusRes = null;
      try {
        giftStatusRes = await postCnApi(GIFT_STATUS_URL, accessToken, uid, proxyOptions);
        if (giftStatusRes.httpStatus === 401 && attempt === 0) {
          log.info("CB_CN_COMP", "401 on gift status, refreshing token once", { id: conn.id });
          const refreshed = await refresh(conn);
          if (refreshed?.accessToken) {
            accessToken = refreshed.accessToken;
            continue;
          }
        }
      } catch {
        // gift check error is non-fatal
      }

      if (compStatusRes.httpStatus !== 200) {
        return { status: "failed", error: compStatusRes.msg || `http_${compStatusRes.httpStatus}` };
      }

      const compData = compStatusRes.data || {};
      const giftData = giftStatusRes?.data || {};

      let totalClaimed = 0;
      const claimedItems = [];
      let anyClaimFailed = false;
      let lastClaimError = null;

      // Claim compensation if active and not claimed
      if (compData.active === true && !compData.claimed) {
        const claimRes = await postCnApi(CLAIM_COMPENSATION_URL, accessToken, uid, proxyOptions);
        if (claimRes.httpStatus === 200 && (claimRes.code === 0 || claimRes.code === "0")) {
          const amount = Number(compData.credit_num) || 0;
          totalClaimed += amount;
          claimedItems.push({ type: "compensation", amount, endTime: compData.end_time });
        } else {
          anyClaimFailed = true;
          lastClaimError = claimRes.msg || `http_${claimRes.httpStatus}`;
        }
      }

      // Claim gift if active and not claimed
      if (giftData.active === true && !giftData.claimed) {
        const claimGiftRes = await postCnApi(CLAIM_GIFT_URL, accessToken, uid, proxyOptions);
        if (claimGiftRes.httpStatus === 200 && (claimGiftRes.code === 0 || claimGiftRes.code === "0")) {
          const amount = Number(giftData.credit_num) || 0;
          totalClaimed += amount;
          claimedItems.push({ type: "gift", amount, endTime: giftData.end_time });
        } else {
          anyClaimFailed = true;
          lastClaimError = claimGiftRes.msg || `http_${claimGiftRes.httpStatus}`;
        }
      }

      if (totalClaimed > 0) {
        return {
          status: "claimed",
          claimedAmount: totalClaimed,
          details: claimedItems,
        };
      }

      if (anyClaimFailed) {
        return { status: "failed", error: lastClaimError || "claim_failed" };
      }

      if (compData.claimed === true || giftData.claimed === true) {
        return { status: "already", claimedAmount: 0 };
      }

      if (compData.active === false && (!giftData || giftData.active === false)) {
        return { status: "no-activity", claimedAmount: 0 };
      }

      return { status: "already", claimedAmount: 0 };
    } catch (err) {
      return { status: "failed", error: err?.message || String(err) };
    }
  }

  return { status: "failed", error: "unexpected" };
}

/**
 * One CN compensation pass: list active codebuddy-cn connections and claim any
 * active temporary compensation or gifts. Fail-open.
 *
 * @param {{ loadConnections?: Function, refreshConnection?: Function,
 *           claimConnection?: Function, memo?: Record<string, string> }} [deps]
 * @returns {Promise<Array<{id: string, name: string, status: string, claimedAmount?: number, details?: Array, error?: string}>>}
 */
export async function runCodebuddyCompensationTick(deps = {}) {
  const results = [];
  const load = deps.loadConnections || loadActiveConnections;
  let connections = [];
  try {
    connections = await load();
  } catch (err) {
    log.warn("CB_CN_COMP", "Tick: failed to load codebuddy-cn connections (swallowed)", {
      error: err?.message ?? String(err),
    });
    return results;
  }

  const eligible = (Array.isArray(connections) ? connections : []).filter(isEligibleCbcnConnection);
  if (eligible.length === 0) {
    log.debug("CB_CN_COMP", "Tick: no eligible codebuddy-cn connections", {
      total: Array.isArray(connections) ? connections.length : 0,
    });
    return results;
  }

  log.info("CB_CN_COMP", "Compensation pass started", {
    eligible: eligible.length,
    ids: eligible.map((c) => c.id).filter(Boolean),
  });

  const memo = deps.memo || null;
  const today = dayKey();
  const claimFn = deps.claimConnection || claimCompensationOne;

  for (const conn of eligible) {
    try {
      if (memo && memo[conn.id] === today) {
        log.debug("CB_CN_COMP", `${conn.name || conn.id}: 已确认今日完成,跳过`, {
          id: conn.id,
        });
        continue;
      }
      const outcome = await claimFn(conn, deps);
      if (
        memo &&
        (outcome.status === "claimed" || outcome.status === "already" || outcome.status === "no-activity")
      ) {
        memo[conn.id] = today;
      }
      results.push({
        id: conn.id,
        name: conn.name || conn.id,
        status: outcome.status,
        claimedAmount: outcome.claimedAmount || 0,
        ...(outcome.details ? { details: outcome.details } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
      });
      const statusLabel =
        outcome.status === "claimed"
          ? `领取成功 +${outcome.claimedAmount || 0} 积分`
          : outcome.status === "already"
            ? "已领取"
            : outcome.status === "no-activity"
              ? "暂无活动"
              : `失败${outcome.error ? `(${outcome.error})` : ""}`;
      log.info("CB_CN_COMP", `${conn.name || conn.id}: ${statusLabel}`, {
        id: conn.id,
      });
    } catch (err) {
      results.push({ id: conn.id, name: conn.name || conn.id, status: "failed", error: err?.message || String(err) });
      log.warn("CB_CN_COMP", "Connection compensation claim failed (swallowed)", {
        id: conn?.id,
        error: err?.message ?? String(err),
      });
    }
  }
  return results;
}

// ─── Scheduler ─────────────────────────────────────────────────────────────

// Run one guarded pass, reading both enable flags each fire so toggling off
// stops further work without a restart (fail-open, never throws).
async function safeTick(how) {
  try {
    const settings = await loadSettingsSafe();
    scheduledTime = normalizeCheckinTime(settings.checkinTime);
    if (!checkinTimeReached(scheduledTime)) {
      log.debug("CB_CN_CHECKIN", `Scheduled ${how}: before check-in time ${scheduledTime}, skipping`);
      return;
    }
    const done = await getDoneMap();
    if (settings.codeBuddyCheckin === true) {
      await runCodebuddyCheckinTick({ skipIfCheckedToday: true, memo: done });
      await persistDoneMap();
    } else {
      log.debug("CB_CN_CHECKIN", `Scheduled ${how}: setting off, skipping`);
    }
    if (settings.codeBuddyCompensation === true) {
      const compDone = await getCompensationDoneMap();
      await runCodebuddyCompensationTick({ memo: compDone });
      await persistCompensationDoneMap();
    } else {
      log.debug("CB_CN_COMP", `Scheduled ${how}: setting off, skipping`);
    }
  } catch (err) {
    log.warn("CB_CN_CHECKIN", `Scheduled ${how} rejected (swallowed)`, {
      error: err?.message ?? String(err),
    });
  }
}

function scheduleNext() {
  if (!started) return;
  const delayMs = nextCheckinDelay(Date.now(), scheduledTime);
  clearTimer();
  timerHandle = setTimeout(() => {
    safeTick("tick").finally(() => scheduleNext());
  }, delayMs);
  if (timerHandle.unref) timerHandle.unref();
  log.info("CB_CN_CHECKIN", "Next all-day check-in tick scheduled", {
    delayMs: Math.round(delayMs / 1000),
  });
}

function clearTimer() {
  if (timerHandle) {
    clearTimeout(timerHandle);
    timerHandle = null;
  }
}

/**
 * Start the scheduler. Runs an immediate boot pass (status-check + check-in of
 * not-yet-done accounts) then ticks all day every ~2h. Safe to call repeatedly
 * (idempotent).
 * @param {{ skipBoot?: boolean }} [opts]
 * @returns {boolean} true if started this call
 */
export function startCodebuddyCheckin(opts = {}) {
  if (started) return false;
  if (isNonServerRuntime()) {
    log.debug("CB_CN_CHECKIN", "Skip start outside long-running server runtime");
    return false;
  }
  started = true;

  // Boot pass (only acts when a setting is on & accounts not yet done today).
  // Chain scheduleNext after it so `checkinTime` is loaded first.
  const boot = opts.skipBoot === true ? Promise.resolve() : safeTick("boot");
  boot.finally(() => {
    if (!started) return;
    scheduleNext();
    log.info("CB_CN_CHECKIN", `Scheduler started (daily ${scheduledTime})`);
  });
  return true;
}

export function stopCodebuddyCheckin() {
  clearTimer();
  if (started) {
    started = false;
    log.info("CB_CN_CHECKIN", "Scheduler stopped");
  }
}

export const __internals = {
  decodeJwt,
  isCodeBuddyCnRealm,
  isIdempotentAlready,
  DAILY_CHECKIN_URL,
  STATUS_URL,
  COMPENSATION_STATUS_URL,
  CLAIM_COMPENSATION_URL,
  GIFT_STATUS_URL,
  CLAIM_GIFT_URL,
  dayKey,
  getDoneMap,
  persistDoneMap,
  getCompensationDoneMap,
  persistCompensationDoneMap,
};
