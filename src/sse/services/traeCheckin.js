// Trae（国内站）每日签到 — trae / trae-cn 连接线的 ug/checkin_credits 领积分。
//
// 协议与风控口径整体移植自 CreditDaddy 的 traeClient.checkinTrae（issue #28/#31
// 的多账号/风控沉淀）：
//   POST https://api.trae.cn/trae/api/v2/ug/checkin_credits/status {}   已签 / 预告额度
//   POST https://api.trae.cn/trae/api/v2/ug/checkin_credits/claim  {}   领取（~150 通用积分/天）
// 鉴权 `Authorization: Cloud-IDE-JWT <jwt>`（连接上的 accessToken，与 SOLO 执行器同源），
// 响应信封 { code, message, ... }，code !== 0 即业务失败；HTTP 401 / code 1001 = 凭据失效。
//
// 站点边界：ug 签到接口只在 api.trae.cn 注册（#99 情报），国际站 token 打过去没有
// 对应产品线——只有 site=cn 的连接参与签到，intl 连接在 eligible 过滤时跳过。
//
// 设备指纹：10R 的 trae 执行器按 uid 派生（traeDeviceIdentity，open-sse/executors/
// trae.js），签到沿用同一把指纹——本连接登录时上游注册的就是这套派生身份，签到与
// SOLO 共用一套设备视图。CD 同步进来的连接若带了 CD 注册过的真机号
//（psd.creditDaddyTraeDevice.deviceId，transfer 导入时落库），优先用它——服务端把
// 「号-设备」绑在登录时注册的那台上，陌生设备号领积分吃 9074（CD #31 实测）。
//
// claim 9074 重试：间隔 3s/8s/15s，每次换一个派生设备号（attempt 1/2/3），耗尽归
// failed（不写 memo，下一轮调度还试）。
//
// Scheduler ticks every ~2h (+ jitter)，与 qoderCheckin / minimaxCheckin 同构：
// 今日确认到账后 memoize，当天不再重复请求。Setting key: traeCheckin。

import crypto from "crypto";
import * as log from "../utils/logger.js";
import { proxyAwareFetch } from "../../../open-sse/utils/proxyFetch.js";
import { resolveConnectionProxyConfig } from "../../lib/network/connectionProxy.js";

const TICK_MS = 2 * 60 * 60 * 1000;
const TICK_JITTER_MS = 10 * 60 * 1000;
const TRAE_PROVIDERS = new Set(["trae", "trae-cn"]);
const TRAE_API = "https://api.trae.cn";
const STATUS_PATH = "/trae/api/v2/ug/checkin_credits/status";
const CLAIM_PATH = "/trae/api/v2/ug/checkin_credits/claim";
// claim 有时只回 { code: 0 } 不带 credits 字段（status 预告值也拿不到时兜底）
const DEFAULT_DAILY_CREDITS = 100;

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
  const raw = settings?.traeDailyDone;
  doneMap = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
  return doneMap;
}

function dayKey(nowMs = Date.now()) {
  const d = new Date(nowMs);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function accountLabel(conn) {
  const id = conn.name || conn.displayName || conn.email || `${String(conn.id || "?").slice(0, 8)}…`;
  return `Trae: ${id}`;
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
    await updateSettings({ traeDailyDone: pruned });
    for (const k of Object.keys(doneMap)) delete doneMap[k];
    Object.assign(doneMap, pruned);
  } catch (err) {
    log.warn("TRAE_CHECKIN", `Persist daily-done map failed: ${err?.message ?? String(err)}`);
  }
}

export function isEligibleTraeConnection(conn) {
  if (!conn || conn.isActive === false) return false;
  if (!TRAE_PROVIDERS.has(conn.provider)) return false;
  // 签到接口只在国内站注册：intl 连接不参与（也不该在卡面上亮签到按钮）。
  const site = String(conn.providerSpecificData?.site || "").toLowerCase();
  if (conn.provider === "trae-cn") return typeof conn.accessToken === "string" && conn.accessToken.trim().length > 0;
  // trae 条目（国际站为主）：只放行 site 明确为 cn 的存量连接（拆线前的老连接）。
  return site === "cn" && typeof conn.accessToken === "string" && conn.accessToken.trim().length > 0;
}

// ── 设备指纹 ────────────────────────────────────────────────────────────────
// 与 open-sse/executors/trae.js 的 traeDeviceIdentity 同一派生（uid → sha256 →
// 16 位数字 device_id + uuid 形 machine_id）。CD 推送的真机号（psd.creditDaddyTraeDevice）
// 存在时优先——那是在 CD 浏览器登录时向上游注册过的设备。

function deriveDeviceIdentity(seedSource) {
  const digest = crypto.createHash("sha256").update(`10router-trae:${seedSource}`).digest("hex");
  const deviceId = digest.slice(0, 16).replace(/\D/g, "").padEnd(16, "7");
  const machineId = [
    digest.slice(16, 24), digest.slice(24, 28), `4${digest.slice(28, 31)}`,
    [["8", "9", "a", "b"][parseInt(digest.slice(31, 32), 16) % 4], digest.slice(32, 35)].join(""),
    digest.slice(35, 47),
  ].join("-");
  return { deviceId, machineId };
}

// attempt > 0 = 9074 重试轮换：在派生源里拌入 attempt，结果同样确定（同 attempt 重放一致）。
function checkinDevice(conn, attempt = 0) {
  const psd = conn.providerSpecificData || {};
  const cdDev = psd.creditDaddyTraeDevice;
  if (attempt === 0 && cdDev && /^\d{8,}$/.test(String(cdDev.deviceId || ""))) {
    const uid = String(psd.userId || conn.email || conn.id || "anonymous");
    const market = crypto.createHash("sha256").update(`cd-market:${uid}`).digest("hex");
    return {
      deviceId: String(cdDev.deviceId),
      machineId: cdDev.machineId || deriveDeviceIdentity(uid).machineId,
      marketUserId: `${market.slice(0, 8)}-${market.slice(8, 12)}-${market.slice(12, 16)}-${market.slice(16, 20)}-${market.slice(20, 32)}`,
    };
  }
  const uidSource = String(psd.userId || psd.email || `tok:${String(conn.accessToken || "").slice(0, 64)}` || "anonymous");
  const base = deriveDeviceIdentity(uidSource);
  if (attempt === 0) {
    const market = crypto.createHash("sha256").update(`10router-market:${uidSource}`).digest("hex");
    return {
      ...base,
      marketUserId: `${market.slice(0, 8)}-${market.slice(8, 12)}-${market.slice(12, 16)}-${market.slice(16, 20)}-${market.slice(20, 32)}`,
    };
  }
  const rotated = deriveDeviceIdentity(`${uidSource}:checkin-retry:${attempt}`);
  const market = crypto.createHash("sha256").update(`10router-market:${uidSource}:${attempt}`).digest("hex");
  return {
    deviceId: rotated.deviceId,
    machineId: rotated.machineId,
    marketUserId: `${market.slice(0, 8)}-${market.slice(8, 12)}-${market.slice(12, 16)}-${market.slice(16, 20)}-${market.slice(20, 32)}`,
  };
}

// 签到端点是 IDE 自己调的 web 接口，头组合按 CD traeClient 实测口径（社区逆向互证）。
function checkinHeaders(conn, dev) {
  const token = String(conn.accessToken || "").trim();
  const jwt = token.startsWith("Cloud-IDE-JWT ") ? token : `Cloud-IDE-JWT ${token}`;
  return {
    accept: "*/*",
    "accept-language": "zh-CN",
    authorization: jwt,
    "content-type": "application/json",
    "user-agent": "VSCode 1.107.1 (TRAE SOLO CN)",
    "x-market-client-id": "VSCode 1.107.1",
    "x-market-user-id": dev.marketUserId,
    "x-user-region": "CN",
    "x-device-id": dev.deviceId,
    "x-lgw-req-sdk-type": "3",
    "package-type": "stable_cn",
    "x-request-id": crypto.randomBytes(16).toString("hex"),
    "x-lscbd-aid": "787976",
    "x-lscbd-platform": process.platform === "win32" ? "windows" : process.platform,
    "app-version": "0.1.45",
    "x-tt-trace-id": `00-${crypto.randomBytes(8).toString("hex")}-01`,
    "vscode-sessionid": crypto.createHash("sha256").update(`cd-sess:${dev.deviceId}`).digest("hex"),
  };
}

// checked_in / credits 可能包在 data / result 信封里，只读顶层会把已签判成未签而重复领取。
function findField(obj, key, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 2) return undefined;
  if (key in obj) return obj[key];
  for (const child of [obj.data, obj.result, obj.Result]) {
    const v = findField(child, key, depth + 1);
    if (v !== undefined) return v;
  }
  return undefined;
}

const withCode = (message, code) => (Number.isFinite(code) && code !== 0 ? `${message}（code ${code}）` : message);

// 统一 POST → { ok, code, message, body }；401 / code 1001 = 凭据失效（authDead）。
async function traePost(conn, path, body, attempt, fetchFn) {
  const dev = checkinDevice(conn, attempt);
  const res = await fetchFn(`${TRAE_API}${path}`, {
    method: "POST",
    headers: checkinHeaders(conn, dev),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 401 || res.status === 403) {
    return { ok: false, authDead: true, code: res.status, message: `Authentication failed (${res.status})`, body: null };
  }
  const parsed = await res.json().catch(() => null);
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, code: res.status, message: `Trae 接口返回无法解析（HTTP ${res.status}）`, body: null };
  }
  const code = Number(parsed.code);
  if (code === 1001) {
    return { ok: false, authDead: true, code, message: String(parsed.message || "Trae JWT 已被服务端吊销"), body: null };
  }
  return { ok: true, code: Number.isFinite(code) ? code : null, message: String(parsed.message || ""), body: parsed };
}

const authDead = (r) => Boolean(r && r.authDead);

// claim 9074 重试：3s/8s/15s，逐次换派生设备号（CD #31 口径）。
async function claimWithRetry(conn, fetchFn, log) {
  const backoff = [0, 3000, 8000, 15000];
  let res = await traePost(conn, CLAIM_PATH, {}, 0, fetchFn);
  for (let i = 1; i < backoff.length && res.code === 9074; i++) {
    log?.(`服务端拒绝（code 9074），${backoff[i] / 1000}s 后换设备号重试（${i}/${backoff.length - 1}）`);
    await new Promise((ok) => setTimeout(ok, backoff[i]));
    res = await traePost(conn, CLAIM_PATH, {}, i, fetchFn);
  }
  return res;
}

function finalizeClaim(claimRes, base, fallbackCredits = 0) {
  if (claimRes.code !== 0) {
    if (/已经签到|已签到|already.*sign/i.test(String(claimRes.message || ""))) {
      return { ...base, status: "already", message: withCode(claimRes.message || "今天已签到", claimRes.code) };
    }
    return { ...base, status: "failed", error: withCode(claimRes.message || `code ${claimRes.code}`, claimRes.code) };
  }
  const claimed = Number(findField(claimRes.body, "credits")) || fallbackCredits;
  return {
    ...base,
    status: "checked-in",
    claimedAmount: claimed,
    message: claimed ? `签到成功，+${claimed} 积分` : "签到成功",
  };
}

/**
 * Check in a single Trae connection (status → claim if pending; 9074 rotate-retry).
 * Result shape mirrors checkinOneMinimax so the dashboard renders both the same way.
 */
export async function checkinOneTrae(conn, deps = {}) {
  const base = {
    connectionId: conn.id,
    account: conn.name || conn.email || conn.id,
    provider: conn.provider,
  };
  if (!conn.accessToken) {
    return { ...base, status: "failed", error: "Token unavailable" };
  }
  const proxyOptions = await resolveConnectionProxyConfig(conn.providerSpecificData || {});
  const fetchFn = deps.fetch || ((url, init) => proxyAwareFetch(url, init, proxyOptions));
  const step = (msg) => (typeof deps.log === "function" ? deps.log(msg) : log.debug("TRAE_CHECKIN", msg));

  try {
    const statusRes = await traePost(conn, STATUS_PATH, {}, 0, fetchFn);
    if (authDead(statusRes)) {
      return { ...base, status: "failed", error: statusRes.message };
    }
    if (statusRes.code !== 0) {
      // 「当前设备今日已经签到」类文案归 already（CD #28：多账号同 IP 被风控合并时走这条）
      if (/已经签到|已签到|already.*sign/i.test(String(statusRes.message || ""))) {
        return { ...base, status: "already", message: withCode(statusRes.message || "今天已签到", statusRes.code) };
      }
      if (statusRes.code === 9074) {
        return finalizeClaim(await claimWithRetry(conn, fetchFn, step), base, DEFAULT_DAILY_CREDITS);
      }
      return { ...base, status: "failed", error: withCode(statusRes.message || `code ${statusRes.code}`, statusRes.code) };
    }
    const already = findField(statusRes.body, "checked_in");
    if (already === true || already === 1) {
      return { ...base, status: "already", message: "今天已签到" };
    }
    const expectedCredits = Number(findField(statusRes.body, "credits") ?? findField(statusRes.body, "extra_credits")) || DEFAULT_DAILY_CREDITS;
    return finalizeClaim(await claimWithRetry(conn, fetchFn, step), base, expectedCredits);
  } catch (err) {
    return { ...base, status: "failed", error: err?.message || "Network error" };
  }
}

/**
 * Execute a check-in run across all eligible Trae connections.
 */
export async function runTraeCheckinTick(deps = {}) {
  const { getProviderConnections } = await import("../../lib/localDb.js");
  const conns = await getProviderConnections();
  const eligible = conns.filter(isEligibleTraeConnection);
  if (eligible.length === 0) {
    log.debug("TRAE_CHECKIN", "Tick: no eligible Trae CN connections");
    return [];
  }

  log.debug("TRAE_CHECKIN", `领取轮次开始：${eligible.map((c) => accountLabel(c)).join("、")}`);

  const memo = deps.doneMap || (await getDoneMap());
  const today = dayKey(deps.nowMs);
  const results = [];

  for (const conn of eligible) {
    try {
      if (deps.skipIfCheckedToday && memo[conn.id] === today) {
        log.debug("TRAE_CHECKIN", `${accountLabel(conn)}：今日已确认完成，跳过`);
        results.push({ connectionId: conn.id, account: conn.name || conn.email || conn.id, provider: conn.provider, status: "already", memoized: true });
        continue;
      }
      const checkinFn = deps.checkinConnection || checkinOneTrae;
      const outcome = await checkinFn(conn, deps);
      results.push(outcome);
      if (outcome.status === "checked-in") {
        memo[conn.id] = today;
        log.info("TRAE_CHECKIN", `${accountLabel(conn)} 签到成功 +${outcome.claimedAmount} 积分`);
      } else if (outcome.status === "already") {
        memo[conn.id] = today;
        log.debug("TRAE_CHECKIN", `${accountLabel(conn)}：${outcome.message || "今日已签"}`);
      } else {
        log.warn("TRAE_CHECKIN", `${accountLabel(conn)} 签到失败：${outcome.error || outcome.status}`);
      }
    } catch (err) {
      results.push({
        connectionId: conn.id,
        account: conn.name || conn.id,
        provider: conn.provider,
        status: "failed",
        error: err?.message || String(err),
      });
      log.warn("TRAE_CHECKIN", `${accountLabel(conn)} 签到异常：${err?.message || err}`);
    }
  }

  const claimed = results.filter((r) => r.status === "checked-in");
  const failed = results.filter((r) => r.status === "failed");
  const already = results.length - claimed.length - failed.length;
  const totalPoints = claimed.reduce((a, r) => a + (r.claimedAmount || 0), 0);
  const summary = `签到汇总：成功 ${claimed.length}（+${totalPoints} 积分）、已签 ${already}、失败 ${failed.length}`;
  if (claimed.length > 0 || failed.length > 0) {
    log.info("TRAE_CHECKIN", summary);
  } else {
    log.debug("TRAE_CHECKIN", summary);
  }

  await persistDoneMap();
  return results;
}

async function safeTick(how) {
  try {
    const settings = await loadSettingsSafe();
    if (settings.traeCheckin !== true) {
      log.debug("TRAE_CHECKIN", `Scheduled ${how}: setting off, skipping`);
      return;
    }
    const done = await getDoneMap();
    await runTraeCheckinTick({ skipIfCheckedToday: true, doneMap: done });
    await persistDoneMap();
  } catch (err) {
    log.warn("TRAE_CHECKIN", `定时签到（${how}）失败：${err?.message ?? String(err)}`);
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
  log.debug("TRAE_CHECKIN", `下次签到约 ${fmtDuration(delayMs)} 后`);
  return delayMs;
}

/**
 * Start the scheduler. Runs an immediate boot pass then ticks every ~2h.
 * @param {{ skipBoot?: boolean }} [opts]
 * @returns {boolean} true if started this call
 */
export function startTraeCheckin(opts = {}) {
  if (started) return false;
  if (isNonServerRuntime()) {
    log.debug("TRAE_CHECKIN", "Skip start outside long-running server runtime");
    return false;
  }
  started = true;
  if (opts.skipBoot !== true) {
    safeTick("boot");
  }
  const delayMs = scheduleNext();
  log.info("TRAE_CHECKIN", `每日签到调度已启动（全天轮询）— 下次约 ${fmtDuration(delayMs)} 后`);
  return true;
}

export function stopTraeCheckin() {
  clearTimer();
  if (started) {
    started = false;
    log.info("TRAE_CHECKIN", "Scheduler stopped");
  }
}
