// Trae CN / Trae SOLO CN daily check-in.
//
// Ported from agent2api `providers/trae/checkin.rs` (itself verified against the
// official client). This is the ug/checkin_credits family:
//   POST {UG_HOST}/trae/api/v2/ug/checkin_credits/status  body {}
//   POST {UG_HOST}/trae/api/v2/ug/checkin_credits/claim   body {}
//   POST .../status again with the SAME device id         (confirmation)
//
// The claim's `code:0` is a fake-success trap for already-checked accounts, so
// success is only reported when the follow-up status flips checked_in /
// did_checked_in. A fresh 16-digit device id is generated per round (the login
// device id and machine id are known to trip 9074); it stays constant across
// the three calls so the confirmation asks about the same device.
//
// Intl Trae has no check-in activity at all. Accounts without a device-bound
// login (no devicePublicKeyPem/deviceId) are refused with a re-login message
// rather than risking the 9074 risk-control path.
import crypto from "node:crypto";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";

const UG_HOST = "https://api.trae.cn";
const STATUS_PATH = "/trae/api/v2/ug/checkin_credits/status";
const CLAIM_PATH = "/trae/api/v2/ug/checkin_credits/claim";
const REQUEST_TIMEOUT_MS = 20_000;
const CODE_OK = 0;
const CODE_REJECTED = 9074;
const CODE_TOKEN_DEAD = 1001;

const RUNNING = new Set();
// 9074 / dead-token days are not retried by the periodic sweep. A manual
// "run now" (force) bypasses this, matching the reference implementation's
// "one round per click, no all-day backoff ladder".
const BLOCKED_DAY = new Map();

function localDayKey(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function markBlocked(key, day) {
  BLOCKED_DAY.set(key, day || localDayKey());
}

function isBlocked(key, day) {
  return BLOCKED_DAY.get(key) === (day || localDayKey());
}

/** Fresh 16-digit device id (uniform; crypto.randomInt avoids modulo bias). */
export function checkinDeviceId() {
  let out = "";
  while (out.length < 16) out += String(crypto.randomInt(0, 10));
  return out;
}

/** `status`/`claim` payload → the fields the decision needs. */
export function statusOf(payload) {
  if (!payload || typeof payload !== "object") {
    return { checkedIn: false, didCheckedIn: false, enable: false, credits: 0, extraCredits: 0, code: 0, message: "" };
  }
  return {
    checkedIn: payload.checked_in === true,
    didCheckedIn: payload.did_checked_in === true,
    enable: payload.enable === true,
    credits: Number(payload.credits) || 0,
    extraCredits: Number(payload.extra_credits) || 0,
    code: Number(payload.code) || 0,
    message: typeof payload.message === "string" ? payload.message.trim() : "",
  };
}

export function doneToday(status) {
  return !!(status?.checkedIn || status?.didCheckedIn);
}

export function awardOf(status) {
  return (status?.credits || 0) + (status?.extraCredits || 0);
}

/**
 * Decision table (status → claim → same-device status).
 * Returns `{kind, amount, message, code}`; `kind` is one of
 * already | claimed | not-enabled | rejected | unconfirmed.
 */
export function decideTraeOutcome(before, claim, after) {
  if (!before.enable) {
    return { kind: "not-enabled", amount: 0, message: "当前账号没有可签到的活动" };
  }
  if (doneToday(before)) {
    return { kind: "already", amount: awardOf(before), message: "今日已签到" };
  }
  if (claim.code !== CODE_OK) {
    return {
      kind: "rejected",
      amount: 0,
      code: claim.code,
      message: claim.message || `领取被拒 code=${claim.code}`,
    };
  }
  if (!doneToday(after)) {
    return {
      kind: "unconfirmed",
      amount: 0,
      message: "领取返回成功，但同一设备回查未确认到账",
    };
  }
  return { kind: "claimed", amount: awardOf(after), message: "签到成功" };
}

function variantOf(conn) {
  const site = String(conn?.providerSpecificData?.site || "").toLowerCase();
  if (site === "intl") return conn.provider === "trae-solo" ? "solo-intl" : "intl";
  return conn.provider === "trae-solo" ? "solo" : "cn";
}

function headersFor(variant, token, deviceId) {
  const solo = variant === "solo" || variant === "solo-intl";
  const requestId = crypto.randomUUID();
  const traceRandom = crypto.randomBytes(16).toString("hex");
  const traceTaken = requestId.replace(/-/g, "").slice(0, 16);
  return {
    "Content-Type": "application/json",
    Accept: "*/*",
    "User-Agent": `VSCode 1.107.1 (${solo ? "TRAE SOLO CN" : "TRAE CN"})`,
    "X-User-Region": "CN",
    "Accept-Language": "zh-CN",
    "Package-Type": "stable_cn",
    "X-Lgw-Req-Sdk-Type": "3",
    "X-Market-Client-Id": "VSCode 1.107.1",
    "X-Device-Brand": "83DG",
    "X-Device-Type": "windows",
    "X-OS-Version": "Windows 11 Pro",
    "App-Version": "0.1.61",
    "X-Request-Id": requestId,
    "X-TT-Trace-Id": `00-${traceRandom}-${traceTaken}-01`,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "no-cors",
    "Sec-Fetch-Site": "none",
    Authorization: `Cloud-IDE-JWT ${token}`,
    "X-Device-Id": deviceId,
  };
}

async function post(path, headers) {
  const response = await proxyAwareFetch(
    `${UG_HOST}${path}`,
    {
      method: "POST",
      headers,
      body: "{}",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
    null
  );
  const text = await response.text().catch(() => "");
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  return { httpStatus: response.status, payload, text };
}

function isAuthFailure(httpStatus, payload) {
  if (httpStatus === 401 || httpStatus === 403) return true;
  const status = statusOf(payload);
  if (status.code === CODE_TOKEN_DEAD) return true;
  return /not able to authenticate|unable to authenticate/i.test(status.message);
}

function failed(message) {
  return { status: "failed", message };
}

export async function runTraeCheckin(conn, { dryRun = false, force = false, today = "" } = {}) {
  const variant = variantOf(conn);
  if (variant === "intl" || variant === "solo-intl") {
    return { status: "no-activity", message: "国际版 Trae 没有签到通道（上游无此活动）" };
  }
  const token = String(conn?.accessToken || conn?.apiKey || "").trim();
  if (!token) return { status: "needs-reauth", message: "该 Trae 账号没有可用凭证，请重新登录" };

  const psd = conn.providerSpecificData || {};
  if (!psd.deviceId && !psd.devicePublicKeyPem && !psd.devicePrivateKeyPem) {
    return {
      status: "needs-reauth",
      message: "该 Trae 账号没有设备绑定（多为手工粘贴凭据），请重新登录后再签到",
    };
  }

  const key = String(conn.id || psd.userId || psd.email || "trae");
  if (RUNNING.has(key)) return { status: "limited", message: "该账号签到正在进行中" };
  const day = today || localDayKey();
  if (!force && isBlocked(key, day)) {
    return { status: "limited", message: "今日已触发上游限流或登录失效，自动重试已停止；可手动重试或明日再试" };
  }
  RUNNING.add(key);
  try {
    const deviceId = checkinDeviceId();
    const headers = headersFor(variant, token, deviceId);

    const beforeRes = await post(STATUS_PATH, headers);
    if (isAuthFailure(beforeRes.httpStatus, beforeRes.payload)) {
      markBlocked(key, day);
      return { status: "needs-reauth", message: "Trae 登录态已失效，请重新登录" };
    }
    if (!beforeRes.payload) {
      return failed(`签到状态接口返回非 JSON（HTTP ${beforeRes.httpStatus}）：${beforeRes.text.slice(0, 160)}`);
    }
    const before = statusOf(beforeRes.payload);
    if (before.code !== CODE_OK) {
      if (before.code === CODE_REJECTED) {
        markBlocked(key, day);
        return { status: "limited", code: before.code, message: before.message || "当前签到人数过多，今日不再自动重试" };
      }
      return failed(before.message || `签到状态返回 code=${before.code}`);
    }
    if (!before.enable || doneToday(before)) {
      const decision = decideTraeOutcome(before, { code: CODE_OK }, null);
      if (dryRun) {
        return {
          status: decision.kind === "already" ? "already" : "no-activity",
          amount: decision.amount,
          unit: "积分",
          message: `dry-run：${decision.message}`,
        };
      }
      return {
        status: decision.kind === "already" ? "already" : "no-activity",
        amount: decision.amount,
        unit: "积分",
        message: decision.message,
      };
    }
    if (dryRun) {
      return { status: "ok", amount: 0, unit: "积分", message: "dry-run：今天可签到（未提交）" };
    }

    const claimRes = await post(CLAIM_PATH, headers);
    if (isAuthFailure(claimRes.httpStatus, claimRes.payload)) {
      markBlocked(key, day);
      return { status: "needs-reauth", message: "Trae 登录态已失效，请重新登录" };
    }
    if (!claimRes.payload) {
      return failed(`签到接口返回非 JSON（HTTP ${claimRes.httpStatus}）：${claimRes.text.slice(0, 160)}`);
    }
    const claim = statusOf(claimRes.payload);
    if (claim.code !== CODE_OK) {
      const decision = decideTraeOutcome(before, claim, null);
      if (claim.code === CODE_REJECTED) {
        markBlocked(key, day);
        return { status: "limited", code: claim.code, message: decision.message };
      }
      return { status: "failed", code: claim.code, message: decision.message };
    }

    let after = null;
    try {
      const afterRes = await post(STATUS_PATH, headers);
      if (afterRes.payload) after = statusOf(afterRes.payload);
    } catch {
      after = null;
    }
    const decision = decideTraeOutcome(before, claim, after);
    if (decision.kind === "claimed") {
      return {
        status: "ok",
        amount: decision.amount,
        unit: "积分",
        message: decision.amount > 0 ? `签到成功，官方报出 +${decision.amount} 积分` : "签到成功",
      };
    }
    return {
      status: decision.kind === "unconfirmed" ? "failed" : "limited",
      message: decision.message,
    };
  } catch (error) {
    return failed(`Trae 签到请求失败：${error?.message || error}`);
  } finally {
    RUNNING.delete(key);
  }
}

export default {
  id: "trae",
  providers: ["trae", "trae-solo"],
  settingsKey: "traeCheckin",
  cadence: "daily",
  run: (conn, ctx) => runTraeCheckin(conn, ctx),
};

/** Test seam. */
export function __resetTraeCheckinState() {
  RUNNING.clear();
  BLOCKED_DAY.clear();
}
