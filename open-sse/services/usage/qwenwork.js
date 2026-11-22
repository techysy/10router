/**
 * QwenWork usage — the account-context endpoint carries the plan and the
 * credit quota in one read:
 *   GET /api/v1/adapter/user/account-context?include=user,plan,quota,...
 *   → { data: { plan: { name, next_refresh_date, next_due_date },
 *               quota: { total, used, remaining, exceeded } } }
 * One window is one pool of credits; the plan's next refresh/due date is
 * the window's reset. Mirrors the magpie plugin's verified usage reader.
 */
import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { qwenworkSite } from "../../shared/qwenwork/constants.js";

export async function getQwenWorkUsage(accessToken, providerId = "qwenwork", proxyOptions = null) {
  if (!accessToken) {
    return { message: "QwenWork usage unavailable: no access token" };
  }
  try {
    const site = qwenworkSite(providerId);
    const response = await proxyAwareFetch(
      site.userInfoUrl,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      },
      proxyOptions,
    );
    if (!response.ok) {
      // CD access-only 同步的 access 约 7 天有效（官方客户端在线时 CD 重推
      // 最新 access）。过期后卡面降级说话，不渲染死数字——口径对齐 crowllm
      // 会话失效卡（issue #164 需求 2）。
      if (response.status === 401 || response.status === 403) {
        return {
          message:
            "QwenWork access token expired or revoked (access-only syncs last ~7 days). Re-sync the latest access from CreditDaddy, or sign in to the connection again.",
        };
      }
      return { message: `QwenWork connected. Usage fetch returned ${response.status}.` };
    }
    const body = await response.json().catch(() => null);
    const data = body?.data ?? body;
    if (!data || typeof data !== "object") {
      return { message: "QwenWork connected. Usage response was not JSON." };
    }

    const plan = data.plan && typeof data.plan === "object" ? data.plan : {};
    const quota = data.quota && typeof data.quota === "object" ? data.quota : null;

    const resetRaw = plan.next_refresh_date || plan.next_due_date || null;
    const resetMs = resetRaw ? Date.parse(resetRaw) : NaN;
    const resetAt = Number.isFinite(resetMs) ? new Date(resetMs).toISOString() : null;

    const quotas = {};
    if (quota) {
      // 个人版是余额制：account-context 的 quota.total/used 常为 null（issue
      // #164 CD 侧实测同形）→ 储值单值卡口径（isCreditBalance），不印 0 分母。
      const totalRaw = quota.total;
      const hasDenominator = Number.isFinite(Number(totalRaw)) && Number(totalRaw) > 0;
      const total = hasDenominator ? Number(totalRaw) : 0;
      const remaining = Number.isFinite(Number(quota.remaining)) ? Number(quota.remaining) : null;
      const used = hasDenominator
        ? Number.isFinite(Number(quota.used))
          ? Number(quota.used)
          : remaining !== null
            ? Math.max(0, total - remaining)
            : 0
        : 0;
      const remainingNum = remaining !== null ? remaining : Math.max(0, total - used);
      quotas.credits = {
        total: hasDenominator ? total : remainingNum,
        used,
        remaining: remainingNum,
        unit: "credits",
        resetAt,
        unlimited: false,
        ...(hasDenominator
          ? {}
          : {
              // 储值单值卡（isCreditBalance）：大数 = 余额本体，无分母。
              isCreditBalance: true,
              displayRemaining: true,
              summarizesDetail: true,
            }),
        // Meoo/lingxi 同款头部通道：大数右侧「X · N后过期」——积分窗口该回答
        // 「到什么时候」。批次即整个窗口（resetAt = plan 刷新日）。
        ...(resetAt ? { expiringBatch: { remaining: remainingNum, resetAt } } : {}),
      };
    }

    return {
      plan: plan.name || undefined,
      quotas,
      isQuotaExceeded: !!(quota && (quota.exceeded || (Number(quota.total) > 0 && Number(quota.remaining) <= 0))),
      ...(Object.keys(quotas).length === 0
        ? { message: "QwenWork connected. The account reports no credit quota." }
        : {}),
    };
  } catch (error) {
    return { message: `QwenWork connected. Unable to fetch usage: ${error.message}` };
  }
}
