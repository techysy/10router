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
    //
    // activeGrants carry what the aggregates lack — the per-batch expiry
    // (2026-11-14 probe: SUBSCRIPTION / DAILY_LOGIN / INVITE_REWARD, each
    // grantDetails[] with its own expiresDate). One detailOnly row per
    // source → 逐包明细; the headline Balance row additionally rides the
    // nearest live batch as `expiringBatch` so the card answers "until
    // when" beside the big number. Balance.resetAt stays null: it feeds
    // expiry scheduling downstream, and the BALANCE itself never expires —
    // only batches do.
    const grants = Array.isArray(account.activeGrants) ? account.activeGrants : [];
    const grantRows = {};
    let expiringBatch = null;
    for (const g of grants) {
      const totalInitial = Math.max(0, g.totalInitial ?? 0);
      if (!(totalInitial > 0)) continue;
      const remaining = Math.max(0, g.totalRemaining ?? 0);
      const live = (g.batches || [])
        .filter((b) => (b.remaining ?? 0) > 0 && b.expiresDate)
        .sort((a, b) => String(a.expiresDate).localeCompare(String(b.expiresDate)));
      for (const b of live) {
        if (!expiringBatch || String(b.expiresDate) < String(expiringBatch.resetAt)) {
          expiringBatch = { remaining: b.remaining, resetAt: b.expiresDate };
        }
      }
      grantRows[g.sourceName || g.sourceType || "积分"] = {
        used: Math.max(0, totalInitial - remaining),
        total: totalInitial,
        resetAt: live[0]?.expiresDate || null,
        detailOnly: true,
        recurring: false,
      };
    }
    return {
      plan: "Meoo",
      quotas: {
        "Balance （积分）": {
          used: 0,
          total,
          remainingPercentage: total > 0 ? 100 : 0,
          resetAt: null,
          unlimited: total > 0,
          // 聚合行：三笔 grant 批次合计就是它 —— 明细里再印一遍只会渲染出
          // ∞（unlimited 行形态）或重复的 12,000。与 dumate 积分余额行同款。
          summarizesDetail: true,
          ...(expiringBatch ? { expiringBatch } : {}),
        },
        ...grantRows,
      },
    };
  } catch (error) {
    // MeooApiError carries Meoo's own status/message (incl. the
    // success:false business envelope) — surface that summary verbatim.
    return { plan: "Meoo", message: `Meoo 积分查询失败：${error.message}` };
  }
}
