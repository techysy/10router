/*
 * WPS 灵犀每日签到（每日灵点领取）。协议自 CreditDaddy src/lingxiClient.js 移植
 * （issue #53 实测口径），10R 原生落地 —— 连接自带 WPS Cookie 罐，无需依赖 CD。
 *
 * 两步走，绝不盲打 claim（幂等性未验证，提案者停在了风控边界）：
 *   1. GET /api/public/v1/tasks —— 任务面板里 daily_check_in 的状态：
 *      status === "claimed" = 今日已签（直接返回 already，不 POST）；
 *      extra.check_in_days[] 逐日 claimed 状态给连签天数，本轮第 streak 天的
 *      reward 是「当日奖励」（每日 100 / 第七天 200）。
 *   2. 仅未签时 POST /api/public/v1/tasks/daily_check_in/claim?date=YYYY-MM-DD
 *      （本地日；claim 响应的 total_claimed_credits 是本轮周期累计——
 *      2026-11-09 实测连签第 3 天回 300 而余额实动 +100，绝不当当日额展示）。
 *
 * 认证 = 连接上的 WPS 会话 Cookie 罐（apiKey || accessToken），无签名。
 */

import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { isAuthFailure, REAUTH_MSG } from "./usage/lingxi.js";

const LINGXI_BASE = "https://lingxi.kdocs.cn";
export const LINGXI_TASKS_URL = `${LINGXI_BASE}/api/public/v1/tasks`;
export const DAILY_CHECK_IN_KEY = "daily_check_in";
const CLAIM_URL = `${LINGXI_BASE}/api/public/v1/tasks/${DAILY_CHECK_IN_KEY}/claim`;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

function lingxiHeaders(cookie) {
  return {
    Cookie: String(cookie || "").trim(),
    Referer: "https://lingxi.kdocs.cn/",
    Origin: "https://lingxi.kdocs.cn",
    Accept: "application/json, text/plain, */*",
    "User-Agent": UA,
  };
}

/** 本地日 YYYY-MM-DD（claim 的 date 参数按提案者实测口径）。 */
export function localDayKey(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

async function lingxiFetch(url, { method = "GET", cookie, fetchImpl, proxyOptions }) {
  const doFetch = fetchImpl || ((u, o) => proxyAwareFetch(u, o, proxyOptions));
  return doFetch(url, { method, headers: lingxiHeaders(cookie) });
}

/**
 * 任务面板：每日签到状态（+当日奖励/连签天数）。认证探测与状态一并拿。
 * @param {string} cookie
 * @param {{ fetchImpl?: Function, proxyOptions?: object }} [opts]
 * @returns {Promise<{ auth: boolean, checkedIn?: boolean, reward?: number,
 *            dayReward?: number, streakDays?: number, code?: string }>}
 */
export async function fetchLingxiTasks(cookie, opts = {}) {
  let res;
  try {
    res = await lingxiFetch(LINGXI_TASKS_URL, { cookie, fetchImpl: opts.fetchImpl, proxyOptions: opts.proxyOptions });
  } catch (e) {
    return { auth: false, code: e?.message || "network" };
  }
  const text = await res.text().catch(() => "");
  if (isAuthFailure({ status: res.status, text })) return { auth: false, code: `HTTP ${res.status}` };

  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    return { auth: false, code: "non-json" };
  }
  const tasks = data?.data?.tasks;
  if (!Array.isArray(tasks)) return { auth: false, code: "no-tasks" };

  const out = { auth: true };
  const daily = tasks.find((x) => x?.task_key === DAILY_CHECK_IN_KEY || x?.taskKey === DAILY_CHECK_IN_KEY);
  if (daily) {
    out.checkedIn = String(daily.status || "") === "claimed";
    const reward = Number(daily.reward_amount ?? daily.rewardAmount);
    if (Number.isFinite(reward) && reward > 0) out.reward = reward;
    const days = daily.extra?.check_in_days || daily.extra?.checkInDays;
    if (Array.isArray(days)) {
      out.streakDays = days.filter((d) => d?.claimed || d?.status === "claimed").length;
      // 当天奖励 = 本轮第 streakDays 天的 reward（每日 100 / 第七天 200）
      const dayReward = Number(days[out.streakDays]?.reward ?? days[out.streakDays]?.rewardAmount);
      if (Number.isFinite(dayReward) && dayReward > 0) out.dayReward = dayReward;
    }
  }
  return out;
}

/**
 * 每日签到。先查任务状态（claimed 直接返回已签），available 才 POST claim。
 * @param {{ cookie: string, fetchImpl?: Function, proxyOptions?: object }} args
 * @returns {Promise<{ status: 'checked-in'|'already'|'failed', message: string,
 *            claimedAmount?: number, streakDays?: number, dayReward?: number }>}
 */
export async function lingxiDailyCheckin({ cookie, fetchImpl, proxyOptions = null } = {}) {
  if (!String(cookie || "").trim()) {
    return { status: "failed", message: REAUTH_MSG };
  }

  let status;
  try {
    status = await fetchLingxiTasks(cookie, { fetchImpl, proxyOptions });
  } catch (e) {
    return { status: "failed", message: `灵犀签到查询失败：${e.message}` };
  }
  if (!status.auth) {
    return { status: "failed", message: REAUTH_MSG };
  }

  // 展示口径的当天额：当日奖励 → reward_amount → 100（绝不读 claim 的周期累计）
  const reward = status.dayReward ?? status.reward ?? 100;
  if (status.checkedIn) {
    return {
      status: "already",
      message: `今日已签到（+${reward} 灵点）`,
      claimedAmount: 0,
      streakDays: status.streakDays,
      dayReward: reward,
    };
  }

  let claimData = null;
  try {
    const res = await lingxiFetch(`${CLAIM_URL}?date=${localDayKey()}`, {
      method: "POST",
      cookie,
      fetchImpl,
      proxyOptions,
    });
    const text = await res.text().catch(() => "");
    if (isAuthFailure({ status: res.status, text })) {
      return { status: "failed", message: REAUTH_MSG };
    }
    try {
      claimData = text ? JSON.parse(text) : null;
    } catch {
      claimData = null;
    }
    if (!res.ok) {
      return {
        status: "failed",
        message: `灵犀签到失败：HTTP ${res.status} ${String(claimData?.message || claimData?.error || "").slice(0, 120)}`,
      };
    }
    if (claimData && claimData.result !== "ok" && claimData?.code && String(claimData.code) !== "0") {
      // 服务端明确拒绝（风控 / 重复）：如实上抛，不猜
      return {
        status: "failed",
        message: `灵犀签到被拒：${String(claimData.message || claimData.error || claimData.code).slice(0, 120)}`,
      };
    }
  } catch (e) {
    return { status: "failed", message: `灵犀签到失败：${e.message}` };
  }

  return {
    status: "checked-in",
    message: `签到成功（+${reward} 灵点）`,
    claimedAmount: reward,
    streakDays: status.streakDays,
    dayReward: reward,
  };
}
