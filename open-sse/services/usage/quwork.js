// QuWork 积分（展示用）：/api/user/self → points_entitlement.total_points 为
// 当前余额。只做展示，不进 quotas（不参与路由判定）。账号 token 由通用
// tokenRefresh（quwork 刷新器）续期；网络走调用方传入的通用连接代理配置。
import { quworkSelfInfo, quworkPointsFromSelf, quworkAccountFromSelf } from "../../shared/quwork/client.js";

const fmt = (v) => (Number.isFinite(v) ? v.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : "—");

export async function getQuworkUsage(accessToken, providerSpecificData = {}, proxyOptions = null, fetchImpl) {
  const psd = providerSpecificData || {};
  if (psd.quworkTokenOnly === true) {
    return { plan: "QuWork", quotas: {}, message: "仅 llm_token 连接：没有账号 access token，无法读取积分（推理正常）。" };
  }
  try {
    const self = await quworkSelfInfo(accessToken, { proxyOptions, ...(fetchImpl ? { fetchImpl } : {}) });
    const p = quworkPointsFromSelf(self);
    const parts = [`剩余积分 ${fmt(p.remaining)}`];
    if (p.limited !== null) parts.push(`限时 ${fmt(p.limited)}`);
    if (p.permanent !== null) parts.push(`永久 ${fmt(p.permanent)}`);
    const acct = quworkAccountFromSelf(self);
    parts.push(`微信：${acct.wechatBound ? "已绑定" : "未绑定"}`);
    if (acct.affCode) parts.push(`邀请码 ${acct.affCode}`);
    const claim = psd.quworkLastClaim;
    if (claim?.message) parts.push(`签到：${claim.message}（${claim.day}）`);
    return {
      plan: "QuWork",
      quotas: {},
      quwork: { points: p.remaining, limited: p.limited, permanent: p.permanent, wechatBound: acct.wechatBound, affCode: acct.affCode, inviterId: acct.inviterId },
      message: `QuWork ${parts.join(" · ")}`,
    };
  } catch (e) {
    return {
      plan: "QuWork",
      quotas: {},
      message: e?.expired
        ? "QuWork 账号 token 已失效，请重新登录（推理不受影响）。"
        : `QuWork 积分读取失败：${e?.message || e}`,
    };
  }
}
