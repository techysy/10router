/**
 * DeepAI Code usage — GET https://api.deepai.org/deepai_code/theos
 * Auth: `Api-Key: <desktop account API key>` + Theos lane header.
 *
 * The ledger is a daily grant pot: { enabled, balance, granted,
 * refresh_at, lane_version, check_in }. `granted` is what the account
 * received for the current day (free accounts are granted Theos daily,
 * anchored at the first-grant time — refresh_at is the next grant);
 * metered models spend it per request, the 11 free models cost 0.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { DEEPAI_THEOS_URL, buildDeepaiHeaders } from "../../shared/deepai/constants.js";
import { formatDeepaiQuotaError } from "../../shared/deepai/errors.js";
import { toFiniteNumber } from "./shared.js";

const FETCH_TIMEOUT_MS = 15_000;

/**
 * @param {string|null|undefined} apiKey - the connection's desktop account API key
 * @param {object|null} proxyOptions
 */
export async function getDeepaiUsage(apiKey = null, proxyOptions = null) {
  if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
    return {
      message: "当前连接没有可用的 DeepAI API Key，请通过浏览器登录或手动添加 Key。",
    };
  }

  try {
    const response = await proxyAwareFetch(
      DEEPAI_THEOS_URL,
      {
        method: "GET",
        headers: buildDeepaiHeaders(apiKey.trim()),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
      proxyOptions,
    );
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      return {
        plan: "DeepAI Code",
        message: formatDeepaiQuotaError(response.status, payload, apiKey.trim()),
      };
    }
    const data = await response.json().catch(() => null);
    if (!data || data.balance === undefined) {
      return { plan: "DeepAI Code", message: "DeepAI 未返回 Theos 余额数据。" };
    }

    const balance = Math.max(0, toFiniteNumber(data.balance, 0));
    const granted = Math.max(0, toFiniteNumber(data.granted, 0));
    const resetAt = typeof data.refresh_at === "string" ? data.refresh_at : null;

    return {
      plan: "DeepAI Code",
      quotas: {
        // Credit pot, same posture as Meoo: show the full remaining
        // balance; never set absolute `remaining` (QuotaTable treats it
        // as a 0–100 percentage). The row name starts with "Balance" so
        // balanceExtractor claims it as the connection's quotaBalance.
        "Balance （Theos)": {
          used: 0,
          total: balance,
          remainingPercentage: balance > 0 ? 100 : 0,
          resetAt,
          unlimited: balance > 0,
          summarizesDetail: true,
        },
        ...(granted > 0
          ? {
              "Daily grant （每日发放）": {
                used: Math.max(0, granted - balance),
                total: granted,
                resetAt,
                detailOnly: true,
                recurring: true,
              },
            }
          : {}),
      },
    };
  } catch (error) {
    return { plan: "DeepAI Code", message: `DeepAI Theos 查询失败：${error.message}` };
  }
}
