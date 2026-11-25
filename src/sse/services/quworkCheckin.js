// QuWork 每日签到积分 — 自动领取调度器（与 meooCheckin / codebuddyCheckin 同构）。
//
// 状态门控：先 GET /api/user/daily-reward/status，can_claim 才 POST claim，绝不
// 盲打。当日闭环（claimed / 今日已领取 / 需绑定微信）的连接 memoize 到设置项
// quworkDailyDone，当天不再重复；失败不记，下一轮再试。Scheduler ticks every
// ~2h (+ jitter). Setting key: quworkCheckin（实验功能页开关）。
//
// 网络：连接的通用代理配置（resolveConnectionProxyConfig：连接代理 / 代理池），
// 未配置时走全局 fetch（全局出站代理）。账号 token 失效时用通用 quwork 刷新器
// 续期一次再重试。
import * as log from "../utils/logger.js";

const TICK_MS = 2 * 60 * 60 * 1000;
const TICK_JITTER_MS = 10 * 60 * 1000;

let started = false;
let timerHandle = null;

function isNonServerRuntime() {
  if (typeof window !== "undefined") return true;
  const phase = process.env.NEXT_PHASE || "";
  if (phase === "phase-production-build" || phase === "phase-export" || phase === "phase-static") return true;
  if (process.env.NEXT_RUNTIME === "edge") return true;
  return false;
}

/** QuWork 日界按北京时间（UTC+8）。 */
export function quworkDayKey(nowMs = Date.now()) {
  return new Date(nowMs + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

export function isEligibleQuworkConnection(conn) {
  if (!conn || conn.isActive === false || conn.external) return false;
  if (conn.provider !== "quwork") return false;
  return Boolean(String(conn.refreshToken || "").trim()) && conn.providerSpecificData?.quworkTokenOnly !== true;
}

function label(conn) {
  return `QuWork: ${conn.name || conn.displayName || String(conn.id || "?").slice(0, 8)}`;
}

async function proxyOptionsFor(conn) {
  const { resolveConnectionProxyConfig } = await import("../../lib/network/connectionProxy.js");
  const cfg = await resolveConnectionProxyConfig(conn.providerSpecificData);
  return {
    connectionProxyEnabled: cfg.connectionProxyEnabled === true,
    connectionProxyUrl: cfg.connectionProxyUrl || "",
    connectionNoProxy: cfg.connectionNoProxy || "",
    vercelRelayUrl: cfg.vercelRelayUrl || "",
    strictProxy: cfg.strictProxy === true,
  };
}

/**
 * Claim today's reward for one connection (manual card button + scheduler).
 * @returns {{claimed:boolean, outcome:string, points:number, balance:number|null, message:string}}
 */
export async function claimQuworkDaily(conn) {
  if (!isEligibleQuworkConnection(conn)) {
    return { claimed: false, outcome: "ineligible", points: 0, balance: null, message: "该连接没有账号 access token（仅 llm_token），无法签到——请用短信登录或补充 access token" };
  }
  const { quworkClaimDailyReward, quworkSelfInfo, quworkPointsFromSelf } = await import("open-sse/shared/quwork/client.js");
  const proxyOptions = await proxyOptionsFor(conn);
  let token = conn.accessToken;
  let result;
  try {
    try {
      result = await quworkClaimDailyReward(token, { proxyOptions });
    } catch (e) {
      if (!e?.expired) throw e;
      const { refreshQuworkToken } = await import("open-sse/services/tokenRefresh.js");
      const refreshed = await refreshQuworkToken(conn.refreshToken, log, proxyOptions);
      if (!refreshed?.accessToken) throw new Error("账号 token 已失效且续期失败，请重新登录 QuWork（推理不受影响）");
      const { updateProviderCredentials } = await import("./tokenRefresh.js");
      await updateProviderCredentials(conn.id, refreshed);
      token = refreshed.accessToken;
      result = await quworkClaimDailyReward(token, { proxyOptions });
    }
  } catch (e) {
    return { claimed: false, outcome: "failed", points: 0, balance: null, message: e?.message || String(e) };
  }
  let balance = null;
  try {
    balance = quworkPointsFromSelf(await quworkSelfInfo(token, { proxyOptions })).remaining;
  } catch { /* best-effort */ }
  try {
    const { getProviderConnectionById, updateProviderConnection } = await import("../../lib/localDb.js");
    const latest = (await getProviderConnectionById(conn.id)) || conn;
    await updateProviderConnection(conn.id, {
      providerSpecificData: {
        ...(latest.providerSpecificData || {}),
        quworkLastClaim: { day: quworkDayKey(), outcome: result.outcome, message: result.message, at: new Date().toISOString() },
        ...(balance !== null ? { quworkPoints: balance, quworkPointsAt: new Date().toISOString() } : {}),
      },
    });
  } catch { /* best-effort */ }
  return { claimed: result.claimed, outcome: result.outcome, points: result.points, balance, message: result.message };
}

export async function runQuworkCheckinTick({ skipIfCheckedToday = true, nowMs = Date.now() } = {}) {
  const { getProviderConnections, getSettings, updateSettings } = await import("../../lib/localDb.js");
  const conns = ((await getProviderConnections({ provider: "quwork" })) || []).filter(isEligibleQuworkConnection);
  if (conns.length === 0) return [];
  const settings = (await getSettings()) || {};
  const today = quworkDayKey(nowMs);
  const raw = settings.quworkDailyDone && typeof settings.quworkDailyDone === "object" ? settings.quworkDailyDone : {};
  const done = Object.fromEntries(Object.entries(raw).filter(([, d]) => d === today));
  const results = [];
  for (const conn of conns) {
    if (skipIfCheckedToday && done[conn.id] === today) continue;
    const r = await claimQuworkDaily(conn);
    results.push({ id: conn.id, label: label(conn), ...r });
    if (r.outcome === "claimed" || r.outcome === "done" || r.outcome === "wechat_required") {
      done[conn.id] = today;
      log.info("QUWORK_CHECKIN", `${label(conn)}：${r.message}`);
    } else {
      log.warn("QUWORK_CHECKIN", `${label(conn)}：${r.message}`);
    }
  }
  try {
    await updateSettings({ quworkDailyDone: done });
  } catch (e) {
    log.warn("QUWORK_CHECKIN", `persist daily-done failed: ${e?.message || e}`);
  }
  return results;
}

async function safeTick(how) {
  try {
    const { getSettings } = await import("../../lib/localDb.js");
    if (((await getSettings()) || {}).quworkCheckin !== true) return;
    await runQuworkCheckinTick({ skipIfCheckedToday: true });
  } catch (err) {
    log.warn("QUWORK_CHECKIN", `定时领取（${how}）失败：${err?.message ?? String(err)}`);
  }
}

function scheduleNext() {
  if (!started) return;
  if (timerHandle) clearTimeout(timerHandle);
  timerHandle = setTimeout(() => {
    safeTick("tick").finally(() => scheduleNext());
  }, TICK_MS + Math.floor(Math.random() * TICK_JITTER_MS));
  if (timerHandle && typeof timerHandle.unref === "function") timerHandle.unref();
}

/** Start the scheduler: immediate boot pass, then every ~2h. */
export function startQuworkCheckin() {
  if (started) return false;
  if (isNonServerRuntime()) return false;
  started = true;
  safeTick("boot");
  scheduleNext();
  return true;
}

export function stopQuworkCheckin() {
  if (!started) return false;
  started = false;
  if (timerHandle) clearTimeout(timerHandle);
  timerHandle = null;
  return true;
}
