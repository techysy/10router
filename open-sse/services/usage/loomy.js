/**
 * Loomy 积分查询 — `GET /api/v2/points/records` 的账户摘要字段。
 *
 * 上游没有独立余额接口：积分页读的是 V2 流水接口，响应 `data` 里同时带
 * `balance`（永久积分）与 `dailyBalance`（每日赠送积分，每日登录刷回）。
 * 口径与 Rust `loomy/balance.rs::query_usage` 一致：两者各一行，不做换算。
 *
 * 信封：HTTP 200 + `{code,desc,data}`；`000000` 成功，`020002` / `100002`
 * 登录失效。其他业务码按失败返回 message，绝不把「没读懂」渲染成余额 0
 * （0 会让账号看起来已耗尽）。
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { nextDailyResetIso } from "../../utils/dailyReset.js";

const LOOMY_BASE_URL = "https://loomyad.xunfei.cn";
const RECORDS_PATH =
  "/api/v2/points/records?pageNo=1&pageSize=1&direction=debit&granularity=chat";
const REQUEST_TIMEOUT_MS = 20_000;

const SUCCESS_CODES = new Set(["", "0", "000000"]);
const AUTH_ERROR_CODES = new Set(["020002", "100002"]);

const numberOrNull = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(number) ? number : null;
};

const pickNumber = (source, key) => {
  if (!source || typeof source !== "object") return null;
  return numberOrNull(source[key]);
};

const messageOf = (payload) => {
  const candidates = [payload?.desc, payload?.message, payload?.msg, payload?.error?.message];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 500);
  }
  return "";
};

const tokenOf = (session) => String(session || "").trim().replace(/^Bearer\s+/i, "");

function creditRow(name, balance, { daily = false, resetAt = null } = {}) {
  return {
    name,
    used: 0,
    total: balance,
    remaining: balance,
    remainingPercentage: balance > 0 ? 100 : 0,
    isCreditBalance: true,
    recurring: daily,
    ...(resetAt ? { resetAt } : {}),
    currency: "points",
  };
}

/**
 * Pure row builder (exported for tests).
 *
 * The daily pool resets at the provider's midnight; only a positive balance
 * gets a resetAt. A zero daily pool has nothing to spend, so it must not pull
 * its account to the front of the earliest-expiry queue.
 */
export function buildLoomyQuotas(permanent, daily, nowMs = Date.now()) {
  const quotas = {};
  const permanentRow = creditRow("永久积分 (积分)", permanent ?? 0);
  const dailyRow = creditRow("每日赠送积分 (积分)", daily ?? 0, {
    daily: true,
    resetAt: (daily ?? 0) > 0 ? nextDailyResetIso(nowMs) : null,
  });
  quotas[permanentRow.name] = permanentRow;
  quotas[dailyRow.name] = dailyRow;
  return quotas;
}

export async function getLoomyUsage(session, proxyOptions = null) {
  const token = tokenOf(session);
  if (!token) {
    return { message: "Loomy session 未配置：请导入客户端登录态（会话 14 天且无续期）。" };
  }

  let response;
  try {
    response = await proxyAwareFetch(
      `${LOOMY_BASE_URL}${RECORDS_PATH}`,
      {
        method: "GET",
        headers: {
          // 业务面只认 `token` 头；Bearer 一并带上（与 Rust token_request 同款）。
          token,
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
      proxyOptions
    );
  } catch (error) {
    return { message: `Loomy 积分查询失败：${error?.message || error}` };
  }

  if (response.status === 401 || response.status === 403) {
    return { message: "Loomy 登录态已失效，请重新导入 session（会话 14 天且无续期）。" };
  }
  if (response.status === 429) {
    return { message: "Loomy 积分接口被限流（HTTP 429），请稍后重试。" };
  }
  if (!response.ok) {
    return { message: `Loomy 积分接口返回 HTTP ${response.status}。` };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return { message: "Loomy 积分响应不是 JSON。" };
  }
  if (!payload || typeof payload !== "object") {
    return { message: "Loomy 积分响应格式不认识。" };
  }

  const code = payload.code === undefined || payload.code === null ? "" : String(payload.code).trim();
  if (AUTH_ERROR_CODES.has(code)) {
    return { message: "Loomy 登录态已失效，请重新导入 session（会话 14 天且无续期）。" };
  }
  if (!SUCCESS_CODES.has(code)) {
    const detail = messageOf(payload);
    return { message: `Loomy 积分查询失败${detail ? `：${detail}` : `（code=${code}）`}。` };
  }

  // 摘要可能直接挂在 data，也可能在 data.data（V2 接口两种形态都出现过）。
  const outer = payload.data && typeof payload.data === "object" ? payload.data : null;
  const inner = outer?.data && typeof outer.data === "object" ? outer.data : null;
  const data = inner || outer;

  const permanent = pickNumber(data, "balance");
  const daily = pickNumber(data, "dailyBalance");
  if (permanent === null && daily === null) {
    return { message: "Loomy 积分响应里没有 balance / dailyBalance 字段。" };
  }

  return { quotas: buildLoomyQuotas(permanent, daily) };
}
