/**
 * Meoo （秒悟） usage — GET {control plane}/open/v1/cli-compat/account/points
 * Auth: Bearer <OAuth access token | pasted control key (meoo_ak_…)>
 *
 * The points ledger lives on the control plane (meoo.com), not on the
 * model gateway — the project service AK that chat calls carry cannot
 * read it. The credential is therefore the connection's OAuth access
 * token when present, else the stored control key
 * (providerSpecificData.meooControlKey); fetchMeooPoints (meooAk.js)
 * handles the envelope + dual-namespace fallback.
 */

import { fetchMeooPoints, getMeooControlKey } from "../meooAk.js";

/**
 * @param {string|null|undefined} accessToken - OAuth access token, if any
 * @param {object|null|undefined} providerSpecificData - carries meooControlKey
 * @param {object|null} proxyOptions
 */
export async function getMeooUsage(accessToken = null, providerSpecificData = null, proxyOptions = null) {
  const credential =
    (typeof accessToken === "string" && accessToken.trim()) ||
    getMeooControlKey({ providerSpecificData: providerSpecificData || {} });

  if (!credential) {
    return {
      message:
        "Meoo 积分余额在控制面（meoo.com）上，需要 OAuth 登录或粘贴的控制面 Key（meoo_ak_…）才能读取；当前连接没有可用的控制面凭证，请重新登录 Meoo 或改用粘贴 Key 方式连接。",
    };
  }

  try {
    const account = await fetchMeooPoints(credential, { proxyOptions });
    if (!account || typeof account.availableBalance !== "number") {
      return { plan: "Meoo", message: "Meoo 未返回积分账户数据。" };
    }

    const total = Math.max(0, account.availableBalance);
    // Credit pot, same posture as DeepSeek: show full remaining against
    // the current balance; never set absolute `remaining` — QuotaTable
    // treats it as a 0–100 percentage. The row name starts with "Balance"
    // so balanceExtractor claims it as the connection's quotaBalance.
    return {
      plan: "Meoo",
      quotas: {
        "Balance （积分）": {
          used: 0,
          total,
          remainingPercentage: total > 0 ? 100 : 0,
          resetAt: null,
          unlimited: total > 0,
        },
      },
    };
  } catch (error) {
    // MeooApiError carries Meoo's own status/message (incl. the
    // success:false business envelope) — surface that summary verbatim.
    return { plan: "Meoo", message: `Meoo 积分查询失败：${error.message}` };
  }
}
