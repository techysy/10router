// QuWork 积分 → 配额跟踪器。/api/user/self → points_entitlement：total_points
// 为当前余额（不是发放总额），limited_points / permanent_points 为限时/永久两部分，
// active_subscription（若有）为订阅包。账号 token 由通用 tokenRefresh（quwork
// 刷新器）续期；网络走调用方传入的通用连接代理配置。
//
// 行形态与 Meoo 积分池同款（储值池）：
//   「Balance （积分）」汇总行：isCreditBalance 单值卡，total = 当前余额；
//     限时积分有到期时间时挂 expiringBatch（大数右侧「X · Nd后到期」）；
//     今日已签到时带 checkinToday（卡面「今日已签到」徽章；未知则不带）。
//   「永久积分」「限时积分」「<订阅名>」：detailOnly 明细行（逐包明细）。
// 成功时不返回顶层 message——跟踪器见到 message 会只显示文字、不渲染配额；
// 文字摘要（含 微信 已绑定/未绑定、我的邀请码）放在 quwork.summary。
import { quworkSelfInfo, quworkPointsFromSelf, quworkAccountFromSelf } from "../../shared/quwork/client.js";

const fmt = (v) => (Number.isFinite(v) ? v.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : "—");
const num = (v) => (v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** epoch seconds / epoch ms / date string → ISO, else null. */
export function quworkTimeToIso(v) {
  if (v === undefined || v === null || v === "" || v === 0) return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return new Date(n < 1e12 ? n * 1000 : n).toISOString();
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** QuWork 日界按北京时间（UTC+8）——与 quworkCheckin 一致。 */
function beijingDay(nowMs = Date.now()) {
  return new Date(nowMs + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Today's check-in fact from the last claim result: true | undefined (unknown/not done). */
export function quworkCheckinToday(lastClaim, nowMs = Date.now()) {
  if (!lastClaim || lastClaim.day !== beijingDay(nowMs)) return undefined;
  return lastClaim.outcome === "claimed" || lastClaim.outcome === "done" ? true : undefined;
}

/** Build tracker quotas from /api/user/self. */
export function quworkQuotasFromSelf(self, { lastClaim = null, nowMs = Date.now() } = {}) {
  const e = self?.points_entitlement ?? self?.pointsEntitlement ?? {};
  const p = quworkPointsFromSelf(self);
  const limitedExpiry = quworkTimeToIso(
    e.limited_expires_at ?? e.limitedExpiresAt ?? e.limited_points_expires_at ?? e.limited_points_expire_at
      ?? e.limited_expire_at ?? e.limited_expire_time ?? e.nearest_expire_at,
  );
  const details = {};
  if (p.permanent !== null && p.permanent > 0) {
    details["永久积分"] = { used: 0, total: p.permanent, resetAt: null, detailOnly: true, recurring: false };
  }
  if (p.limited !== null && p.limited > 0) {
    details["限时积分"] = { used: 0, total: p.limited, resetAt: limitedExpiry, detailOnly: true, recurring: false };
  }
  const sub = e.active_subscription ?? e.activeSubscription;
  if (sub && typeof sub === "object") {
    const total = num(sub.total_points ?? sub.totalPoints);
    const remaining = num(sub.remaining_points ?? sub.remainingPoints);
    const used = num(sub.used_points ?? sub.usedPoints) ?? (total !== null && remaining !== null ? Math.max(0, total - remaining) : null);
    if (total !== null && total > 0 && used !== null) {
      const name = String(sub.plan_name ?? sub.planName ?? "").trim() || "QuWork 订阅";
      details[name] = { used: Math.min(used, total), total, resetAt: quworkTimeToIso(sub.expires_at ?? sub.expiresAt), detailOnly: true, recurring: false };
    }
  }
  const remaining = Math.max(0, p.remaining ?? 0);
  const checkinToday = quworkCheckinToday(lastClaim, nowMs);
  const expiringBatch = limitedExpiry && p.limited > 0 ? { remaining: p.limited, resetAt: limitedExpiry } : null;
  return {
    "Balance （积分）": {
      used: 0,
      total: remaining,
      remainingPercentage: remaining > 0 ? 100 : 0,
      resetAt: null,
      unlimited: remaining > 0,
      isCreditBalance: true,
      ...(Object.keys(details).length ? { summarizesDetail: true } : {}),
      ...(expiringBatch ? { expiringBatch } : {}),
      ...(checkinToday ? { checkinToday: true } : {}),
    },
    ...details,
  };
}

export async function getQuworkUsage(accessToken, providerSpecificData = {}, proxyOptions = null, fetchImpl) {
  const psd = providerSpecificData || {};
  if (psd.quworkTokenOnly === true) {
    return { plan: "QuWork", quotas: {}, message: "仅 llm_token 连接：没有账号 access token，无法读取积分（推理正常）。" };
  }
  try {
    const self = await quworkSelfInfo(accessToken, { proxyOptions, ...(fetchImpl ? { fetchImpl } : {}) });
    const p = quworkPointsFromSelf(self);
    const acct = quworkAccountFromSelf(self);
    const parts = [`剩余积分 ${fmt(p.remaining)}`];
    if (p.limited !== null) parts.push(`限时 ${fmt(p.limited)}`);
    if (p.permanent !== null) parts.push(`永久 ${fmt(p.permanent)}`);
    parts.push(`微信：${acct.wechatBound ? "已绑定" : "未绑定"}`);
    if (acct.affCode) parts.push(`邀请码 ${acct.affCode}`);
    const claim = psd.quworkLastClaim;
    if (claim?.message) parts.push(`签到：${claim.message}（${claim.day}）`);
    const e = self?.points_entitlement ?? self?.pointsEntitlement ?? {};
    return {
      plan: "QuWork",
      quotas: quworkQuotasFromSelf(self, { lastClaim: claim }),
      quwork: {
        points: p.remaining,
        limited: p.limited,
        permanent: p.permanent,
        wechatBound: acct.wechatBound,
        affCode: acct.affCode,
        inviterId: acct.inviterId,
        checkinToday: quworkCheckinToday(claim) === true,
        entitlementFields: Object.keys(e).sort(),
        summary: `QuWork ${parts.join(" · ")}`,
      },
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
