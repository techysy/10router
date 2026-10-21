// Qoder auto daily credit claim (both Domestic/CN and International).
//
// Automatically claims daily Credits (e.g. 100 Credits refreshed at 10:00 UTC+8,
// and other platform campaign benefits) for all active Qoder accounts without
// requiring the user to open the desktop app.
//
// Scheduler ticks every ~2h (+ jitter): an account is checked until today's claim
// is confirmed, then memoized in `qoderDailyDone` for the rest of the day.

import * as log from "../utils/logger.js";
import { DEFAULT_CHECKIN_TIME, checkinTimeReached, nextCheckinDelay, normalizeCheckinTime } from "./checkin/schedule.js";
import {
  QODER_OPENAPI_BASE,
  QODER_CN_OPENAPI_BASE,
} from "../../../open-sse/shared/qoder/constants.js";


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
  const raw = settings?.qoderDailyDone;
  doneMap = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
  return doneMap;
}

function dayKey(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Human label for log lines — "Qoder CN: ShiYanG Yu", never a bare UUID.
// Falls back to an 8-char id prefix only when the account has no name/email.
function accountLabel(conn) {
  const provider = conn.provider === "qoder-cn" ? "Qoder CN" : "Qoder";
  const name = conn.name || conn.displayName || conn.email || `${String(conn.id || "?").slice(0, 8)}…`;
  return `${provider}: ${name}`;
}

// 7595000 -> "2h06m", 45000 -> "45s" — durations read at a glance.
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
    await updateSettings({ qoderDailyDone: pruned });
    for (const k of Object.keys(doneMap)) delete doneMap[k];
    Object.assign(doneMap, pruned);
  } catch (err) {
    log.warn("QODER_CHECKIN", `Persist daily-done map failed: ${err?.message ?? String(err)}`);
  }
}

export function getQoderOpenApiBase(provider) {
  return provider === "qoder-cn" ? QODER_CN_OPENAPI_BASE : QODER_OPENAPI_BASE;
}

export function isEligibleQoderConnection(conn) {
  if (!conn || conn.isActive === false) return false;
  if (conn.provider !== "qoder" && conn.provider !== "qoder-cn") return false;
  const token = conn.accessToken || conn.apiKey;
  return typeof token === "string" && token.trim().length > 0;
}

export function buildQoderHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Cosy-ClientType": "10",
    "Cosy-Version": "0.3.3",
    "Cosy-MachineOS": process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
    "User-Agent": "Qoder",
    Accept: "application/json",
  };
}

/**
 * Resolve effective token (exchange PAT to job token if needed).
 */
async function resolveToken(conn) {
  let token = conn.accessToken || conn.apiKey;
  if (typeof token !== "string") return null;
  token = token.trim();

  // If PAT (pt-...), exchange for short-lived job token
  if (token.startsWith("pt-")) {
    try {
      const { exchangePatToJobToken } = await import(
        "../../../open-sse/services/qoderModels.js"
      );
      const isCn = conn.provider === "qoder-cn";
      token = await exchangePatToJobToken(token, isCn);
    } catch (e) {
      log.warn("QODER_CHECKIN", "PAT exchange failed", { connectionId: conn.id, error: e.message });
      return null;
    }
  }
  return token;
}

/**
 * Claim campaigns for a single Qoder connection.
 */
export async function checkinOneQoder(conn, deps = {}) {
  const fetchFn = deps.fetch || fetch;
  const baseUrl = getQoderOpenApiBase(conn.provider);
  const token = await resolveToken(conn);

  if (!token) {
    return {
      connectionId: conn.id,
      account: conn.name || conn.email || conn.id,
      provider: conn.provider,
      status: "failed",
      error: "Token unavailable",
    };
  }

  const headers = buildQoderHeaders(token);
  const campaignsUrl = `${baseUrl}/sash/api/v1/me/campaigns?clientType=10`;

  try {
    const listRes = await fetchFn(campaignsUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(15000),
    });

    if (listRes.status === 401 || listRes.status === 403) {
      return {
        connectionId: conn.id,
        account: conn.name || conn.email || conn.id,
        provider: conn.provider,
        status: "failed",
        error: `Authentication failed (${listRes.status})`,
      };
    }

    if (!listRes.ok) {
      return {
        connectionId: conn.id,
        account: conn.name || conn.email || conn.id,
        provider: conn.provider,
        status: "failed",
        error: `HTTP ${listRes.status}`,
      };
    }

    const payload = await listRes.json();
    const campaigns = Array.isArray(payload?.campaigns) ? payload.campaigns : [];

    const claimable = campaigns.filter(
      (c) => c.actionType === "CLAIM_BENEFIT" && c.claimStatus === "CLAIMABLE"
    );

    if (claimable.length === 0) {
      // Two different truths used to collapse into one result, and the dashboard
      // rendered both as "today's credits are already claimed":
      //
      //   - the account has no CLAIM_BENEFIT campaign at all. The intl qoder.sh
      //     deployment currently returns only the season promo, whose actionType
      //     is VIEW_DETAILS, for every account we have seen — so there is nothing
      //     to claim, and never was today;
      //   - a credits campaign exists and is already CLAIMED.
      //
      // The first is a normal "nothing on offer here" state, not a claim that
      // happened, so it gets its own status instead of borrowing the success one.
      const creditCampaigns = campaigns.filter((c) => c.actionType === "CLAIM_BENEFIT");
      if (creditCampaigns.length === 0) {
        return {
          connectionId: conn.id,
          account: conn.name || conn.email || conn.id,
          provider: conn.provider,
          status: "no-activity",
          message: "当前无可领取的活动",
          claimedAmount: 0,
        };
      }
      return {
        connectionId: conn.id,
        account: conn.name || conn.email || conn.id,
        provider: conn.provider,
        status: "already",
        message: "今日已领或无待领活动",
        claimedAmount: 0,
      };
    }

    // Claim each available campaign
    let totalClaimed = 0;
    const claimedList = [];

    for (const c of claimable) {
      try {
        const claimUrl = `${baseUrl}/sash/api/v1/me/campaigns/${encodeURIComponent(c.campaignId)}/claim`;
        const claimRes = await fetchFn(claimUrl, {
          method: "POST",
          headers,
          signal: AbortSignal.timeout(15000),
        });

        if (claimRes.ok) {
          const resJson = await claimRes.json().catch(() => ({}));
          const amount = resJson.benefit?.amount || c.benefit?.amount || 0;
          totalClaimed += amount;
          claimedList.push({
            campaignId: c.campaignId,
            campaignKey: c.campaignKey,
            amount,
            status: "claimed",
          });
        }
      } catch (err) {
        log.warn("QODER_CHECKIN", `Failed to claim campaign ${c.campaignId}`, { error: err.message });
      }
    }

    if (claimedList.length > 0) {
      return {
        connectionId: conn.id,
        account: conn.name || conn.email || conn.id,
        provider: conn.provider,
        status: "checked-in",
        claimedAmount: totalClaimed,
        campaigns: claimedList,
      };
    }

    return {
      connectionId: conn.id,
      account: conn.name || conn.email || conn.id,
      provider: conn.provider,
      status: "failed",
      error: "All claims failed",
    };
  } catch (err) {
    return {
      connectionId: conn.id,
      account: conn.name || conn.email || conn.id,
      provider: conn.provider,
      status: "failed",
      error: err.message || "Network error",
    };
  }
}

/**
 * Execute a check-in run across all eligible Qoder / Qoder CN connections.
 */
export async function runQoderCheckinTick(deps = {}) {
  const { getProviderConnections } = await import("../../lib/localDb.js");
  const conns = await getProviderConnections();

  // deps.provider scopes the pass to ONE provider (manual per-provider claim
  // buttons); the scheduler leaves it unset and sweeps both in one pass.
  const eligible = conns.filter(
    (c) => isEligibleQoderConnection(c) && (!deps.provider || c.provider === deps.provider)
  );
  if (eligible.length === 0) {
    log.debug("QODER_CHECKIN", "Tick: no eligible Qoder connections");
    return [];
  }

  log.debug("QODER_CHECKIN", `领取轮次开始：${eligible.map((c) => accountLabel(c)).join("、")}`);

  const memo = deps.doneMap || (await getDoneMap());
  const today = dayKey(deps.nowMs);
  const results = [];

  for (const conn of eligible) {
    try {
      if (deps.skipIfCheckedToday && memo[conn.id] === today) {
        log.debug("QODER_CHECKIN", `${accountLabel(conn)}：今日已确认完成，跳过`);
        results.push({
          connectionId: conn.id,
          account: conn.name || conn.email || conn.id,
          provider: conn.provider,
          status: "already",
          memoized: true,
        });
        continue;
      }

      const checkinFn = deps.checkinConnection || checkinOneQoder;
      const outcome = await checkinFn(conn, { ...deps, doneMap: memo });
      results.push(outcome);

      if (outcome.status === "checked-in") {
        memo[conn.id] = today;
        log.info("QODER_CHECKIN", `${accountLabel(conn)} 领取成功 +${outcome.claimedAmount} Credits`);
      } else if (outcome.status === "already") {
        memo[conn.id] = today;
        log.debug("QODER_CHECKIN", `${accountLabel(conn)}：${outcome.message || "今日已领或无待领活动"}`);
      } else if (outcome.status === "no-activity") {
        // Deliberately NOT memoized: nothing was confirmed, and the campaign can
        // still appear later in the day (the daily window opens at 10:00 UTC+8),
        // so the next tick should look again. A debug line, not a warning — for a
        // deployment that has no such campaign this is the normal outcome.
        log.debug("QODER_CHECKIN", `${accountLabel(conn)}：${outcome.message || "当前无可领取的活动"}`);
      } else {
        log.warn("QODER_CHECKIN", `${accountLabel(conn)} 领取失败：${outcome.error || outcome.status}`);
      }
    } catch (err) {
      results.push({
        connectionId: conn.id,
        account: conn.name || conn.id,
        provider: conn.provider,
        status: "failed",
        error: err?.message || String(err),
      });
      log.warn("QODER_CHECKIN", `${accountLabel(conn)} 领取异常：${err?.message || err}`);
    }
  }

  // One consolidated summary replaces the old firehose of per-event JSON lines.
  const claimed = results.filter((r) => r.status === "checked-in");
  const failed = results.filter((r) => r.status === "failed");
  const none = results.filter((r) => r.status === "no-activity");
  const already = results.length - claimed.length - failed.length - none.length;
  const totalCredits = claimed.reduce((a, r) => a + (r.claimedAmount || 0), 0);
  const summary = `领取汇总：成功 ${claimed.length}（+${totalCredits} Credits）、已领 ${already}、无活动 ${none.length}、失败 ${failed.length}`;
  if (claimed.length > 0 || failed.length > 0) {
    log.info("QODER_CHECKIN", summary);
  } else {
    log.debug("QODER_CHECKIN", summary);
  }

  await persistDoneMap();
  return results;
}

async function safeTick(how) {
  try {
    const settings = await loadSettingsSafe();
    if (settings.qoderCheckin !== true) {
      log.debug("QODER_CHECKIN", `Scheduled ${how}: setting off, skipping`);
      return;
    }
    scheduledTime = normalizeCheckinTime(settings.checkinTime);
    if (!checkinTimeReached(scheduledTime)) {
      log.debug("QODER_CHECKIN", `Scheduled ${how}: before check-in time ${scheduledTime}, skipping`);
      return;
    }
    const done = await getDoneMap();
    await runQoderCheckinTick({ skipIfCheckedToday: true, doneMap: done });
    await persistDoneMap();
  } catch (err) {
    log.warn("QODER_CHECKIN", `定时领取（${how}）失败：${err?.message ?? String(err)}`);
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
  log.debug("QODER_CHECKIN", `下次领取约 ${fmtDuration(delayMs)} 后`);
  return delayMs;
}

/**
 * Start the scheduler. Runs an immediate boot pass then ticks every ~2h.
 * @param {{ skipBoot?: boolean }} [opts]
 * @returns {boolean} true if started this call
 */
export function startQoderCheckin(opts = {}) {
  if (started) return false;
  if (isNonServerRuntime()) {
    log.debug("QODER_CHECKIN", "Skip start outside long-running server runtime");
    return false;
  }
  started = true;

  // Boot pass first: it also reads `checkinTime`, so scheduleNext() below
  // waits for the configured time instead of a hard-coded 2h delay.
  const boot = opts.skipBoot === true ? Promise.resolve() : safeTick("boot");
  boot.finally(() => {
    if (!started) return;
    const delayMs = scheduleNext();
    log.info("QODER_CHECKIN", `自动领取调度已启动（每日 ${scheduledTime}）— 下次约 ${fmtDuration(delayMs)} 后`);
  });
  return true;
}

export function stopQoderCheckin() {
  clearTimer();
  if (started) {
    started = false;
    log.info("QODER_CHECKIN", "Scheduler stopped");
  }
}
