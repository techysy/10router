// Croli（croli.net）每日任务调度器 — 签到 + 每日 say-hi。
//
// Croli 的积分任务里两条是每日的（2026-11-20 CD 侧全链实测，协议见
// open-sse/providers/registry/croli.js 注释）：
//   1. 每日签到   POST ds.croli.net/credits/v1/ops/checkin {taskId:1} → +100
//      （连续 3 天起每日额外 +20，服务端 streak 自记）
//   2. 每日首次对话 POST …/v1/ops/events {eventKey:"agent_turn_completed"} → +200
//      事件由网关真实对话触发——即用连接的网关 key（csk_）对最便宜可用模型
//      发一条 say-hi，网关上报事件后 credits 落账
// 网关 key 领取幂等（POST relay/api/deepseek/sk 同账号恒回同一把），连接
// postExchange 已领过；此处缺失时重领（网络抖动兜底）。
//
// Scheduler ticks every ~2h (+ jitter)，与 meooCheckin / lingxiCheckin 同构：
// 当日已闭环的账号 memoize（settings.croliDailyDone），当天不再重复触发；
// 失败/无凭证不记，下一轮还试。Setting key: croliCheckin。

import * as log from "../utils/logger.js";

const TICK_MS = 2 * 60 * 60 * 1000;
const TICK_JITTER_MS = 10 * 60 * 1000;
// say-hi 用的模型：探活矩阵里最轻的可用线（gpt 系直连池，max_tokens 需 ≥16）。
// 计费走 trial 每日 2000 免费额度，一条 hi 的消耗远小于 +200 的事件奖励。
const SAYHI_MODEL = "gpt-5.6-luna";
const SAYHI_MAX_TOKENS = 16;

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
  const raw = settings?.croliDailyDone;
  doneMap = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
  return doneMap;
}

function dayKey(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function accountLabel(conn) {
  return `Croli: ${conn.name || conn.displayName || conn.email || `${String(conn.id || "?").slice(0, 8)}…`}`;
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
    await updateSettings({ croliDailyDone: pruned });
    for (const k of Object.keys(doneMap)) delete doneMap[k];
    Object.assign(doneMap, pruned);
  } catch (err) {
    log.warn("CROLI_CHECKIN", `Persist daily-done map failed: ${err?.message ?? String(err)}`);
  }
}

export function isEligibleCroliConnection(conn) {
  if (!conn || conn.isActive === false) return false;
  if (conn.provider !== "croli" || conn.external) return false;
  return Boolean(
    (typeof conn.accessToken === "string" && conn.accessToken.trim()) ||
      (typeof conn.apiKey === "string" && conn.apiKey.trim())
  );
}

/** Resolve the gateway key for a connection: stored apiKey (csk_) or re-claim by JWT. */
async function resolveGatewayKey(conn, proxyOptions) {
  const stored = typeof conn.apiKey === "string" ? conn.apiKey.trim() : "";
  if (stored) return { sk: stored, reused: true };
  const jwt = typeof conn.accessToken === "string" ? conn.accessToken.trim() : "";
  if (!jwt) return { sk: "", reused: false };
  const { CROLI_CONFIG } = await import("../../lib/oauth/constants/oauth.js");
  const { resolveConnectionProxyConfig } = await import("../../lib/network/connectionProxy.js");
  const cfg = proxyOptions || (await resolveConnectionProxyConfig(conn.providerSpecificData));
  const headers = { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json", Accept: "application/json" };
  const fetchImpl = (cfg?.connectionProxyEnabled && cfg?.connectionProxyUrl)
    ? (await import("open-sse/index.js"), globalThis.fetch)
    : globalThis.fetch;
  const res = await fetchImpl(CROLI_CONFIG.skClaimUrl, {
    method: "POST",
    headers,
    body: "{}",
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || typeof body.sk !== "string" || !body.sk) {
    throw new Error(body.error || body.message || `sk claim failed: HTTP ${res.status}`);
  }
  // 领到的 sk 回写连接（apiKey 槽）——下次直接复用
  try {
    const { updateProviderConnection } = await import("../../lib/localDb.js");
    await updateProviderConnection(conn.id, {
      apiKey: body.sk,
      providerSpecificData: {
        ...(conn.providerSpecificData || {}),
        croliSk: body.sk,
        croliSkResolvedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    log.debug("CROLI_CHECKIN", `sk 回写连接失败（本轮仍可用）：${err?.message ?? String(err)}`);
  }
  return { sk: body.sk, reused: false };
}

/** 每日签到：POST /v1/ops/checkin {taskId:1}。返回 {claimed, message, streakDays}。 */
async function croliCheckin(jwt, retried = false) {
  const { CROLI_CONFIG } = await import("../../lib/oauth/constants/oauth.js");
  const res = await fetch(`${CROLI_CONFIG.creditsBaseUrl}/v1/ops/checkin`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ taskId: 1 }),
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403 || body.code === "unauthenticated") {
    return { claimed: false, authExpired: true, message: "凭据已失效（unauthenticated）——请重新授权" };
  }
  // 新授权账号的 credits 账户可能尚未开户——只对精确的 account_not_found
  // 走一次官方开户链（resource 目录 provision → bootstrap）再重试，
  // 其余 404/错误一律按普通失败处理，不误建号。
  if (res.status === 404 && (body.code === "account_not_found" || body.error === "account_not_found") && !retried) {
    try {
      const { bootstrapCroliAccount } = await import("../../../open-sse/services/croli.js");
      await bootstrapCroliAccount(jwt);
      return croliCheckin(jwt, true);
    } catch {
      return { claimed: false, message: "credits 账户初始化失败——请稍后重试" };
    }
  }
  if (!res.ok) {
    return { claimed: false, message: body.message || body.code || `HTTP ${res.status}` };
  }
  if (body.alreadyCheckedIn === true) {
    return { claimed: false, already: true, message: "今日已签到" };
  }
  const awarded = Number(body.creditsAwarded) || 0;
  return { claimed: true, message: `签到成功 +${awarded} 积分`, streakDays: Number(body.streak?.current) || null };
}

/**
 * 每日首次对话（say-hi）：用网关 key 对最便宜可用模型发一条 hi——
 * 网关上报 agent_turn_completed 事件后 credits 落账 +200。
 * 返回 {claimed, message}。
 */
async function croliSayHi(sk, proxyOptions) {
  const { CROLI_CONFIG } = await import("../../lib/oauth/constants/oauth.js");
  const res = await fetch(`${CROLI_CONFIG.gatewayBaseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${sk}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: SAYHI_MODEL,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: SAYHI_MAX_TOKENS,
    }),
    signal: AbortSignal.timeout(60000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { claimed: false, message: body?.error?.message || `say-hi HTTP ${res.status}` };
  }
  return { claimed: true, message: `say-hi 完成（${body.model || SAYHI_MODEL}）` };
}

/**
 * Execute an auto-claim run across all eligible Croli connections.
 * 每号两件事：签到（积分主任务）+ say-hi（对话事件任务）——两者独立判定，
 * 签到已领但对话未领时仍执行 say-hi；两者都闭环才记当日 done。
 */
export async function runCroliCheckinTick({ skipIfCheckedToday = true, doneMap: injectedDone = null } = {}) {
  const { getProviderConnections } = await import("../../lib/localDb.js");
  const { resolveConnectionProxyConfig } = await import("../../lib/network/connectionProxy.js");

  const done = injectedDone || (await getDoneMap());
  const conns = (await getProviderConnections({ provider: "croli" })) || [];
  const eligible = conns.filter(isEligibleCroliConnection);
  if (eligible.length === 0) {
    log.debug("CROLI_CHECKIN", "Tick: no eligible Croli connections");
    return [];
  }
  const today = dayKey();
  const results = [];

  for (const conn of eligible) {
    const label = accountLabel(conn);
    if (skipIfCheckedToday && done[conn.id] === today) {
      log.debug("CROLI_CHECKIN", `${label}: 已闭环，跳过`);
      continue;
    }
    let jwt = typeof conn.accessToken === "string" ? conn.accessToken.trim() : "";
    const messages = [];
    let sk = "";
    let sayHiDone = false;
    try {
      const proxyConfig = await resolveConnectionProxyConfig(conn.providerSpecificData);
      const proxyOptions = {
        connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
        connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
        connectionNoProxy: proxyConfig.connectionNoProxy || "",
        vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
        strictProxy: false,
      };

      // ① 签到（需要 JWT；过期时 attempt refresh，失败则跳过本号本轮）
      if (jwt) {
        const c = await croliCheckin(jwt);
        messages.push(c.message);
        if (c.claimed) log.info("CROLI_CHECKIN", `${label}：${c.message}`);
        else if (c.already) log.debug("CROLI_CHECKIN", `${label}：${c.message}`);
        else log.warn("CROLI_CHECKIN", `${label}：签到 ${c.message}`);
        if (c.authExpired) {
          // 401：refresh 后重试一次（backgroundTokenRefresh 不覆盖 OAuth 轮换制的
          //Croli——这里就地续，避免整轮作废）
          try {
            const { refreshAndUpdateCredentials } = await import("../../app/api/usage/[connectionId]/route.js");
            const refreshed = await refreshAndUpdateCredentials(conn, true).catch(() => null);
            const newTok = refreshed?.connection?.accessToken;
            if (newTok && newTok !== jwt) {
              jwt = newTok;
              const retry = await croliCheckin(jwt);
              messages.push(`重试: ${retry.message}`);
            }
          } catch { /* refresh 失败保持原状态，下一轮再试 */ }
        }
      }

      // ② say-hi（需要网关 key；JWT 有效时缺失即重领）
      try {
        const resolved = await resolveGatewayKey({ ...conn, accessToken: jwt }, proxyOptions);
        sk = resolved.sk;
        if (sk) {
          const hi = await croliSayHi(sk, proxyOptions);
          messages.push(hi.message);
          sayHiDone = hi.claimed;
          if (hi.claimed) log.info("CROLI_CHECKIN", `${label}：${hi.message}`);
          else log.warn("CROLI_CHECKIN", `${label}：say-hi ${hi.message}`);
        } else {
          messages.push("网关 key 未就绪");
          log.warn("CROLI_CHECKIN", `${label}：网关 key 领取失败（签到不受影响）`);
        }
      } catch (e) {
        messages.push(`say-hi 异常: ${e?.message ?? String(e)}`);
        log.warn("CROLI_CHECKIN", `${label}：say-hi 异常 ${e?.message ?? String(e)}`);
      }

      // ③ 闭环判定：签到（已领或已领过）+ say-hi 成功 → 当日 done
      const checkinDone = messages.some((m) => /签到成功|今日已签到/.test(m));
      const anyWork = checkinDone && (sayHiDone || !sk);
      if (anyWork) done[conn.id] = today;
      results.push({ id: conn.id, label, messages, done: anyWork });
    } catch (err) {
      log.warn("CROLI_CHECKIN", `${label}：${err?.message ?? String(err)}`);
      results.push({ id: conn.id, label, messages: [String(err?.message ?? err)], done: false });
    }
  }

  await persistDoneMap();
  return results;
}

async function safeTick(how) {
  try {
    const settings = await loadSettingsSafe();
    if (settings.croliCheckin !== true) {
      log.debug("CROLI_CHECKIN", `Scheduled ${how}: setting off, skipping`);
      return;
    }
    const done = await getDoneMap();
    await runCroliCheckinTick({ skipIfCheckedToday: true, doneMap: done });
    await persistDoneMap();
  } catch (err) {
    log.warn("CROLI_CHECKIN", `定时任务（${how}）失败：${err?.message ?? String(err)}`);
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
  log.debug("CROLI_CHECKIN", `下次任务约 ${Math.round(delayMs / 60000)}m 后`);
  return delayMs;
}

/**
 * Start the scheduler. Runs an immediate boot pass then ticks every ~2h.
 * @returns {boolean} true if started this call
 */
export function startCroliCheckin() {
  if (started) return false;
  if (isNonServerRuntime()) {
    log.debug("CROLI_CHECKIN", "Skip start outside long-running server runtime");
    return false;
  }
  started = true;
  safeTick("boot");
  scheduleNext();
  return true;
}

export function stopCroliCheckin() {
  if (!started) return false;
  started = false;
  clearTimer();
  return true;
}

/** Test hooks: reset in-memory scheduler state. */
export function _resetCroliCheckinState() {
  started = false;
  doneMap = null;
  clearTimer();
}
