/**
 * Loomy usage — GET https://loomyad.xunfei.cn/api/v1/points/records?pageNo=1&pageSize=1&recordType=all
 * Auth: `token: <session>`（与 /models 同款自定义头，issue #92/#93）
 *
 * 客户端没有 /points/balance 端点——余额字段就挂在 records 响应 data.data 上：
 *   balance      永久积分（客户端 UI 就叫「永久积分」，不过期）
 *   dailyBalance 每日赠送积分剩余（每日登录自动刷新为 5000，上限来自文案口径）
 *   dailyConsumedPoints 今日已消耗（服务端报了就直读，否则按上限-剩余倒推）
 * 另兼容少量旧字段名（permanentPoints/currentBalance、dailyPoints/dailyGiftPoints、
 * dailyLimit/daily_limit，与 CD normalizePointsBalance 同口径）。不提供积分 base 覆盖：
 * 积分域钉死 loomyad——base 可配正是当年打错 ossptest 测试环境的根因（CD 留了
 * meta.pointsBaseUrl 逃生门，这里有意不留）。
 * 成功码字符串 '000000'；100002 = 会话不被积分侧识别 → 按客户端协议补调
 * POST /api/v1/points/first-login（幂等初始化）后重试一次。
 *
 * ⚠️ 积分服务与 models/auth 同域 loomyad.xunfei.cn。客户端 points-config 的
 * ossptest.voicecloud.cn 是测试环境，积分会话表与生产独立——生产 session 打它
 * 必得 100002（认证层 baseInfo 却活着，极具迷惑性）。绝不要打 ossptest。
 * 100002 重试后仍失败时只报「积分暂不可查」，绝不误判成登录过期（认证层可能
 * 仍是好的——issue #93 坑 2）。
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";

const POINTS_RECORDS_URL =
  "https://loomyad.xunfei.cn/api/v1/points/records?pageNo=1&pageSize=1&recordType=all";
const POINTS_FIRST_LOGIN_URL = "https://loomyad.xunfei.cn/api/v1/points/first-login";
/** 客户端文案口径：每日赠送积分在每日登录后自动刷新为 5000（生产响应不回上限） */
const DAILY_LIMIT_DEFAULT = 5000;

const OK_CODES = new Set(["000000", 0, "0"]);
const SESSION_UNRECOGNIZED = new Set(["100002", "020002"]);

function toFiniteNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function recordsCall(apiKey, proxyOptions) {
  const response = await proxyAwareFetch(
    POINTS_RECORDS_URL,
    {
      method: "GET",
      headers: { token: String(apiKey).trim(), Accept: "application/json" },
    },
    proxyOptions,
  );
  if (response.status === 401 || response.status === 403) {
    return { status: response.status };
  }
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

async function firstLogin(apiKey, proxyOptions) {
  // 幂等初始化；失败不阻断——把暴露交给余额重试
  try {
    await proxyAwareFetch(
      POINTS_FIRST_LOGIN_URL,
      {
        method: "POST",
        headers: { token: String(apiKey).trim(), "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({}),
      },
      proxyOptions,
    );
  } catch { /* best effort */ }
}

/**
 * @param {string|null|undefined} apiKey - loomy session（SMS 直登 / 本机导入）
 * @param {object|null} proxyOptions
 */
export async function getLoomyUsage(apiKey = null, proxyOptions = null) {
  if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
    return { message: "Loomy session not available. Add a connection (SMS login or paste session) to view points." };
  }

  try {
    let result = await recordsCall(apiKey, proxyOptions);
    if (result.status === 401 || result.status === 403) {
      return {
        plan: "Loomy",
        message: "Loomy authentication failed. The session has expired — log in again (SMS or client).",
      };
    }

    let data = result.data;
    if (data && SESSION_UNRECOGNIZED.has(String(data.code))) {
      // 按客户端协议补 first-login 初始化后重试一次
      await firstLogin(apiKey, proxyOptions);
      result = await recordsCall(apiKey, proxyOptions);
      data = result.data;
    }

    if (!data || typeof data !== "object" || (data.code !== undefined && !OK_CODES.has(String(data.code)))) {
      const desc = data?.desc || data?.message || "";
      // 认证层可能仍是好的——只报积分面不可查，绝不建议把连接标记失效
      return {
        plan: "Loomy",
        message: desc
          ? `Loomy points unavailable: ${desc}`
          : `Loomy points API error (${result.status})`,
      };
    }

    const d = data?.data || {};
    // hasAny：records 成功但 data.data 为空（积分档案未初始化）时，不凭 5000 文案
    // 上限凭空造一条「每日赠送积分」行——如实报「无积分数据」
    const hasAny = Object.keys(d).length > 0;
    const permanent = toFiniteNumber(d.balance ?? d.permanentPoints ?? d.currentBalance ?? d.longTermPoints);
    const dailyRemaining = toFiniteNumber(d.dailyBalance ?? d.dailyPoints ?? d.dailyGiftPoints);
    const dailyLimit =
      toFiniteNumber(d.dailyLimitPoints ?? d.dailyLimit ?? d.daily_limit, 0) || (hasAny ? DAILY_LIMIT_DEFAULT : 0);
    const dailyUsed = toFiniteNumber(d.dailyConsumedPoints) || Math.max(0, dailyLimit - dailyRemaining);

    const quotas = {};
    if (permanent > 0) {
      // 储值行：单值余额，不过期。isCreditBalance 让 QuotaPackBar 把它识别为
      // stored-value（STORED_VALUE_RE 只认 balance/余额 等词，"永久积分"不在
      // 内——不加旗标它会掉进资源包池，卡上多出"N 个资源包 + 逐包明细"）
      quotas["永久积分"] = {
        isCreditBalance: true,
        used: 0,
        total: permanent,
        remainingPercentage: 100,
        resetAt: null,
        unlimited: true,
      };
    }
    if (dailyRemaining > 0 || (hasAny && dailyLimit > 0)) {
      // 每日行：recurring 滚动窗口（每日登录刷新），不是资源包。
      // 已消耗数优先直读服务端 dailyConsumedPoints，缺了才按上限-剩余倒推
      quotas["每日赠送积分"] = {
        recurring: true,
        used: Math.max(0, dailyUsed),
        total: dailyLimit,
        resetAt: null,
      };
    }

    if (Object.keys(quotas).length === 0) {
      return { plan: "Loomy", message: "Loomy connected. No points data returned." };
    }

    return { plan: "Loomy", quotas };
  } catch (error) {
    return { message: `Loomy error: ${error.message}` };
  }
}
