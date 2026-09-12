// CodeBuddy auto daily check-in (CN) + daily active-session probe (intl).
//
// CN: checks every active codebuddy-cn connection into the CodeBuddy CN
// "billing meter" (daily-checkin) so free daily quota is renewed without user
// action. The scheduler ticks ALL DAY (~every 2h + jitter): an account is
// attempted only until the day's check-in is confirmed (status endpoint or a
// successful POST), then it is memoized for the rest of the local day — no
// more repeated "已签到" churn across the day.
//
// intl: CodeBuddy's activity campaign grants daily credits (Free 30 / Pro 50)
// to accounts with ≥1 valid conversation request that day (official docs:
// "当天有对话请求即视为活跃用户"). There is no claim endpoint, so the intl
// pass sends one minimal stream chat request per active codebuddy-intl
// connection per day on a free-tier model (rateMultiplier 0, ~0 credit cost),
// memoized the same way. Experimental, separate settings toggle.
//
// Fail-open everywhere: a tick error or a single connection failure never
// rejects the whole run or kills the server.

import * as log from "../utils/logger.js";

const DAILY_CHECKIN_URL = "https://www.codebuddy.cn/v2/billing/meter/daily-checkin";
const STATUS_URL = "https://www.codebuddy.cn/v2/billing/meter/checkin-activity-status";

// intl daily active-session probe. Free-tier model (rateMultiplier 0) so the
// request itself costs ~0 credits; body shape mirrors executors/codebuddy-intl
// (stream-only gateway: leading system prompt + user content as typed blocks,
// otherwise 11101 invalid request).
const INTL_CHAT_URL = "https://www.codebuddy.ai/v2/chat/completions";
const INTL_PROBE_MODEL = "hy4-preview";
const INTL_PROBE_MAX_TOKENS = 16;

// All-day cadence: retry every ~2h (plus jitter) until each account is done
// for the day; the per-day memo keeps already-done accounts fully idle.
const TICK_MS = 2 * 60 * 60 * 1000;
const TICK_JITTER_MS = 10 * 60 * 1000;

let started = false;
let timerHandle = null;

// connId -> local "YYYY-MM-DD" the account was last confirmed done. Persisted
// in settings as `codeBuddyDailyDone` (lazy-loaded into this cache) so a
// restart doesn't re-verify already-done accounts until the day rolls over;
// entries are pruned to today on every write. The manual check-in route never
// touches this memo.
let doneMap = null;

async function getDoneMap() {
  if (doneMap) return doneMap;
  const settings = await loadSettingsSafe();
  const raw = settings?.codeBuddyDailyDone;
  doneMap = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
  return doneMap;
}

async function markDoneToday(connId, today) {
  const map = await getDoneMap();
  map[connId] = today;
  for (const [id, day] of Object.entries(map)) {
    if (day !== today) delete map[id];
  }
  try {
    const { updateSettings } = await import("../../lib/localDb.js");
    await updateSettings({ codeBuddyDailyDone: { ...map } });
  } catch (err) {
    // Persist is best-effort — the in-memory cache still prevents same-process
    // repeats; a failed write just means one extra status check after restart.
    log.warn("CB_CN_CHECKIN", "Persist daily-done map failed (swallowed)", {
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

// intl tokens are issued by the codebuddy.ai side; matching the "codebuddy"
// family keeps a workbuddy/other realm out without over-fitting the realm URL.
function isCodeBuddyRealm(iss) {
  return typeof iss === "string" && iss.includes("codebuddy");
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
  const claims = decodeJwt(conn.accessToken) || {};
  return isCodeBuddyCnRealm(claims.iss || "");
}

/**
 * Eligibility for the intl daily active-session probe.
 * @param {object} conn
 * @returns {boolean}
 */
export function isEligibleCbIntlConnection(conn) {
  if (!conn || !conn.accessToken) return false;
  if (conn.provider !== "codebuddy-intl") return false;
  if (conn.isActive === false) return false;
  const claims = decodeJwt(conn.accessToken) || {};
  return isCodeBuddyRealm(claims.iss || "");
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
 * Delay (ms) until the next all-day tick: fixed ~2h cadence plus jitter so
 * many instances don't tick in lockstep. `rand` is injectable for tests.
 * @param {number} [nowMs]
 * @param {() => number} [rand] 0..1 uniform
 * @returns {number}
 */
export function msUntilNextTick(nowMs = Date.now(), rand = Math.random) {
  const jitter = Math.floor(rand() * TICK_JITTER_MS);
  return Math.max(TICK_MS + jitter, 1000);
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

async function loadIntlConnections() {
  const { getProviderConnections } = await import("../../lib/db/repos/connectionsRepo.js");
  return getProviderConnections({ provider: "codebuddy-intl" });
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

// One intl active-session probe (with a single 401 → refresh → retry).
async function probeOne(conn, deps) {
  const refresh = deps?.refreshConnection || ((c) => refreshOne("codebuddy-intl", c));
  let accessToken = conn.accessToken;
  const proxyOptions = proxyOptionsOf(conn);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await postIntlProbe(accessToken, proxyOptions);
      if (result.httpStatus >= 200 && result.httpStatus < 300) return { status: "session-ok" };
      if (result.httpStatus === 401 && attempt === 0) {
        log.info("CB_INTL_SESSION", "401 on active-session probe, refreshing token once", {
          id: conn.id,
        });
        const refreshed = await refresh(conn);
        if (refreshed?.accessToken) accessToken = refreshed.accessToken;
        else return { status: "failed", error: "refresh_failed" };
        continue;
      }
      return { status: "failed", error: result.msg || `http_${result.httpStatus}` };
    } catch (err) {
      return { status: "failed", error: err?.message || String(err) };
    }
  }
  return { status: "failed", error: "unexpected" };
}

async function postIntlProbe(accessToken, proxyOptions) {
  const { proxyAwareFetch } = await import("open-sse/utils/proxyFetch.js");
  const { default: registry } = await import("open-sse/providers/registry/codebuddy-intl.js");
  const headers = {
    ...(registry?.transport?.headers || {}),
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  const body = JSON.stringify({
    model: INTL_PROBE_MODEL,
    stream: true,
    max_tokens: INTL_PROBE_MAX_TOKENS,
    messages: [
      { role: "system", content: "You are CodeBuddy Code." },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ],
  });
  const res = await proxyAwareFetch(
    INTL_CHAT_URL,
    { method: "POST", headers, body },
    proxyOptions
  );
  // Stream-only gateway: 2xx means a valid session was established — drain and
  // discard the SSE body (a few tokens on a rateMultiplier-0 model).
  let msg = "";
  if (res.ok && res.body) {
    try {
      await res.text();
    } catch {
      /* drain best-effort */
    }
  } else {
    try {
      const text = await res.text();
      msg = (text || "").slice(0, 200);
    } catch {
      /* ignore */
    }
  }
  return { httpStatus: res.status, msg };
}

/**
 * One CN tick: list active codebuddy-cn connections and check each in. Fail-open
 * (never rejects on a single account error). With `memo` (plain object), accounts
 * confirmed done for the local day are skipped entirely (no network) and
 * successful outcomes are recorded. The manual check-in route passes no memo.
 *
 * @param {{ loadConnections?: Function, refreshConnection?: Function,
 *           checkinConnection?: Function, skipIfCheckedToday?: boolean,
 *           memo?: Record<string, string> }} [deps]
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
 * One intl tick: one free-tier chat request per active codebuddy-intl
 * connection so the day's "活跃赠送" credits are granted. Same memo/fail-open
 * contract as the CN tick.
 *
 * @param {{ loadConnections?: Function, refreshConnection?: Function,
 *           probeConnection?: Function, memo?: Record<string, string> }} [deps]
 * @returns {Promise<Array<{id: string, name: string, status: string, error?: string}>>}
 */
export async function runCodebuddyIntlSessionTick(deps = {}) {
  const results = [];
  const load = deps.loadConnections || loadIntlConnections;
  let connections = [];
  try {
    connections = await load();
  } catch (err) {
    log.warn("CB_INTL_SESSION", "Tick: failed to load codebuddy-intl connections (swallowed)", {
      error: err?.message ?? String(err),
    });
    return results;
  }

  const eligible = (Array.isArray(connections) ? connections : []).filter(isEligibleCbIntlConnection);
  if (eligible.length === 0) {
    log.debug("CB_INTL_SESSION", "Tick: no eligible codebuddy-intl connections", {
      total: Array.isArray(connections) ? connections.length : 0,
    });
    return results;
  }

  log.info("CB_INTL_SESSION", "Daily active-session pass started", {
    eligible: eligible.length,
    ids: eligible.map((c) => c.id).filter(Boolean),
  });

  const memo = deps.memo || null;
  const today = dayKey();

  for (const conn of eligible) {
    try {
      if (memo && memo[conn.id] === today) {
        log.debug("CB_INTL_SESSION", `${conn.name || conn.id}: 已确认今日完成,跳过`, {
          id: conn.id,
        });
        continue;
      }
      const outcome = deps.probeConnection
        ? await deps.probeConnection(conn)
        : await probeOne(conn, deps);
      if (memo && outcome.status === "session-ok") {
        memo[conn.id] = today;
      }
      results.push({
        id: conn.id,
        name: conn.name || conn.id,
        status: outcome.status,
        ...(outcome.error ? { error: outcome.error } : {}),
      });
      log.info(
        "CB_INTL_SESSION",
        `${conn.name || conn.id}: ${outcome.status === "session-ok" ? "活跃会话完成" : `失败(${outcome.error || outcome.status})`}`,
        { id: conn.id }
      );
    } catch (err) {
      results.push({ id: conn.id, name: conn.name || conn.id, status: "failed" });
      log.warn("CB_INTL_SESSION", "Connection probe failed (swallowed)", {
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
    const done = await getDoneMap();
    if (settings.codeBuddyCheckin === true) {
      await runCodebuddyCheckinTick({ skipIfCheckedToday: true, memo: done });
    } else {
      log.debug("CB_CN_CHECKIN", `Scheduled ${how}: setting off, skipping`);
    }
    if (settings.codeBuddyIntlSession === true) {
      await runCodebuddyIntlSessionTick({ memo: done });
    } else {
      log.debug("CB_INTL_SESSION", `Scheduled ${how}: setting off, skipping`);
    }
  } catch (err) {
    log.warn("CB_CN_CHECKIN", `Scheduled ${how} rejected (swallowed)`, {
      error: err?.message ?? String(err),
    });
  }
}

function scheduleNext() {
  if (!started) return;
  const delayMs = msUntilNextTick();
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
  if (opts.skipBoot !== true) {
    safeTick("boot");
  }
  scheduleNext();

  log.info("CB_CN_CHECKIN", "Scheduler started (all-day cadence)");
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
  INTL_CHAT_URL,
  INTL_PROBE_MODEL,
  dayKey,
  msUntilNextTick,
  getDoneMap,
  markDoneToday,
  isEligibleCbIntlConnection,
};
