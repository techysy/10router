// CodeBuddy CN auto daily check-in (experimental).
// Checks every active codebuddy-cn connection into the CodeBuddy CN "billing
// meter" once per day at a random 00:00-06:00 local slot, so free daily
// quota is renewed without user action. Fail-open everywhere: a tick error or
// a single connection failure never rejects the whole run or kills the server.

import * as log from "../utils/logger.js";

const DAILY_CHECKIN_URL = "https://www.codebuddy.cn/v2/billing/meter/daily-checkin";
const STATUS_URL = "https://www.codebuddy.cn/v2/billing/meter/checkin-activity-status";

// Random daily slot window: 00:00 - 06:00 local time (exclusive of 06:00).
const SLOT_HOUR_MIN = 0;
const SLOT_HOUR_MAX = 6; // upper bound exclusive for Math.floor(rand*(max-min))

let started = false;
let timerHandle = null;

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

/**
 * Random delay (ms) until the next 00:00-06:00 local daily slot, strictly in
 * the future within roughly (0, ~30h]. `rand` is injectable for tests.
 * @param {number} [nowMs]
 * @param {() => number} [rand] 0..1 uniform
 * @returns {number}
 */
export function msUntilNextSlot(nowMs = Date.now(), rand = Math.random) {
  const now = new Date(nowMs);
  const hour = SLOT_HOUR_MIN + Math.floor(rand() * (SLOT_HOUR_MAX - SLOT_HOUR_MIN));
  const minute = Math.floor(rand() * 60);
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  let diff = target.getTime() - now.getTime();
  if (diff <= 0) {
    // Past today → next day (also keeps the timer far enough from the loop edge).
    target.setDate(target.getDate() + 1);
    diff = target.getTime() - now.getTime();
  }
  // Sanity guard: never schedule a pathological 0ms/loop. In tests callers pass
  // a deterministic rand so this is only a belt-and-braces floor.
  return Math.max(diff, 1000);
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

async function isEnabledSetting() {
  const { getSettings } = await import("../../lib/localDb.js");
  const settings = await getSettings();
  return settings.codeBuddyCheckin === true;
}

// Reuse the existing proactive refresh pipeline (refreshes + persists the new
// access token) exactly like backgroundTokenRefresh on a 401.
async function refreshOne(connection) {
  const { checkAndRefreshToken } = await import("./tokenRefresh.js");
  const creds = await checkAndRefreshToken("codebuddy-cn", connection, { force: true });
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
async function postDailyCheckin(accessToken, uid, proxyOptions) {
  const { proxyAwareFetch } = await import("open-sse/utils/proxyFetch.js");
  const res = await proxyAwareFetch(
    DAILY_CHECKIN_URL,
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
    rawBody: body,
  };
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

// Is the account already signed in today? Used by the boot safety pass so we
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
  const refresh = deps?.refreshConnection || refreshOne;
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

// Prefer status-check to skip already-checked-in accounts (boot safety pass).
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

/**
 * One tick: list active codebuddy-cn connections and check each in. Fail-open
 * (never rejects on a single account error). `skipIfCheckedToday` uses the
 * status endpoint first (boot safety) to avoid duplicate renewals.
 *
 * @param {{ loadConnections?: Function, refreshConnection?: Function,
 *           checkinConnection?: Function, skipIfCheckedToday?: boolean }} [deps]
 * @returns {Promise<Array<{id: string, name: string, status: string, error?: string}>>}
 */
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

  for (const conn of eligible) {
    try {
      const checkin = deps.checkinConnection || (deps.skipIfCheckedToday ? checkinIfNotDone : checkinOne);
      const outcome = await checkin(conn, deps);
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

// ─── Scheduler ─────────────────────────────────────────────────────────────

// Run one guarded check-in pass, reading the enable flag each fire so turning
// the toggle off stops further work without a restart (fail-open, never throws).
async function safeTick(how) {
  try {
    const on = await isEnabledSetting();
    if (!on) {
      log.debug("CB_CN_CHECKIN", `Scheduled ${how}: setting off, skipping`);
      return;
    }
    await runCodebuddyCheckinTick({ skipIfCheckedToday: how === "boot" });
  } catch (err) {
    log.warn("CB_CN_CHECKIN", `Scheduled ${how} rejected (swallowed)`, {
      error: err?.message ?? String(err),
    });
  }
}

function scheduleNext() {
  if (!started) return;
  const delayMs = msUntilNextSlot();
  clearTimer();
  timerHandle = setTimeout(() => {
    safeTick("daily").finally(() => scheduleNext());
  }, delayMs);
  if (timerHandle.unref) timerHandle.unref();
  log.info("CB_CN_CHECKIN", "Next daily check-in slot scheduled", {
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
 * Start the daily check-in scheduler. Runs an immediate boot safety pass
 * (status-check + check-in of not-yet-checked-in accounts) then schedules the
 * next random 00:00-06:00 local slot. Safe to call repeatedly (idempotent).
 * @param {{ nowMs?: number, rand?: Function, skipBoot?: boolean }} [opts]
 * @returns {boolean} true if started this call
 */
export function startCodebuddyCheckin(opts = {}) {
  if (started) return false;
  if (isNonServerRuntime()) {
    log.debug("CB_CN_CHECKIN", "Skip start outside long-running server runtime");
    return false;
  }
  started = true;

  // Boot safety pass (only acts when the setting is on & accounts not yet in).
  if (opts.skipBoot !== true) {
    safeTick("boot");
  }
  scheduleNext();

  log.info("CB_CN_CHECKIN", "Scheduler started");
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
};
