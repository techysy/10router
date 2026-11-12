// Trae（国内站）额度查询 — trae / trae-cn 连接线的权益包与套餐读取。
//
// 协议移植自 CreditDaddy traeClient.fetchTraeQuota（issue #28/#31 同一实现）：
//   POST https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage  {require_usage:true,req_source:2}
//     → 裸对象（无 {code,message} 信封），user_entitlement_pack_list 逐包展开
//   POST https://api.trae.cn/trae/api/v2/pay/ide_user_pay_status {req_source:2}
//     → 套餐名（Free / Lite / Pro）与到期时间；查不到不影响额度
// 鉴权 `Authorization: Cloud-IDE-JWT <jwt>`；头组合与 traeCheckin 同一套（CD 实测）。
//
// 每天签到发 150 分/7 天有效的包，同名包可堆几十个 —— 按 group_name/display_desc
// 归并（到期取最早），总额优先信服务端自报的 usage_summary。
//
// 站点：与签到一样只在国内站有产品面（intl 连接不进这个 handler —— usage 路由
// 的 provider 分发按 trae-cn 命中；trae 条目 site=cn 的存量连接也在此命中）。

import crypto from "node:crypto";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";

const TRAE_API = "https://api.trae.cn";
const USAGE_PATH = "/trae/api/v2/pay/ide_user_ent_usage";
const PAY_STATUS_PATH = "/trae/api/v2/pay/ide_user_pay_status";

const hex = (n) => crypto.randomBytes(n).toString("hex");

function usageHeaders(accessToken) {
  const jwt = String(accessToken || "").trim();
  const token = jwt.startsWith("Cloud-IDE-JWT ") ? jwt : `Cloud-IDE-JWT ${jwt}`;
  return {
    accept: "*/*",
    "accept-language": "zh-CN",
    authorization: token,
    "content-type": "application/json",
    "user-agent": "VSCode 1.107.1 (TRAE SOLO CN)",
    "x-market-client-id": "VSCode 1.107.1",
    "x-user-region": "CN",
    "x-lgw-req-sdk-type": "3",
    "package-type": "stable_cn",
    "x-request-id": hex(16),
    "x-lscbd-aid": "787976",
    "x-lscbd-platform": process.platform === "win32" ? "windows" : process.platform,
    "app-version": "0.1.45",
    "x-tt-trace-id": `00-${hex(8)}-01`,
  };
}

// 逐层下钻 data / result / Result 信封找字段（CD findField 同款容错）。
function findField(obj, key, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 2) return undefined;
  if (key in obj) return obj[key];
  for (const child of [obj.data, obj.result, obj.Result]) {
    const v = findField(child, key, depth + 1);
    if (v !== undefined) return v;
  }
  return undefined;
}

// Trae 部分时间戳是秒、部分是毫秒
const iso = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n < 1e11 ? n * 1000 : n;
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) && d.getUTCFullYear() < 9000 ? d.toISOString() : null;
};

const round2 = (n) => Math.round(n * 100) / 100;

async function traePost(url, accessToken, body, proxyOptions) {
  const res = await proxyAwareFetch(url, {
    method: "POST",
    headers: usageHeaders(accessToken),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  }, proxyOptions);
  if (res.status === 401 || res.status === 403) {
    return { authDead: true, body: null };
  }
  const parsed = await res.json().catch(() => null);
  return { ok: res.ok, authDead: false, body: parsed };
}

export async function getTraeUsage(accessToken, proxyOptions = null) {
  if (!accessToken || !String(accessToken).trim()) {
    return { message: "Trae usage requires an accessToken" };
  }

  // 1. 权益包（主数据源）
  let packs = [];
  let usageSummary = null;
  let failed = null;
  try {
    const r = await traePost(`${TRAE_API}${USAGE_PATH}`, accessToken, { require_usage: true, req_source: 2 }, proxyOptions);
    if (r.authDead) return { message: "Trae session expired or unauthorized. Please re-authenticate." };
    if (r.body && typeof r.body === "object") {
      const code = Number(r.body.code);
      if (Number.isFinite(code) && code !== 0) {
        failed = new Error(`Trae 额度接口返回错误：${r.body.message || `code ${code}`}`);
      } else {
        packs = (findField(r.body, "user_entitlement_pack_list") || []).filter((p) => p && typeof p === "object");
        usageSummary = r.body.usage_summary && typeof r.body.usage_summary === "object" ? r.body.usage_summary : null;
      }
    } else {
      failed = new Error(`Trae usage returned HTTP-non-JSON payload`);
    }
  } catch (err) {
    failed = err;
  }

  // 每天签到发 150 分/7 天有效期的包，同名包能堆到几十个；按名称归并（到期取最早）。
  const quotas = {};
  let total = 0;
  let used = 0;
  for (const pack of packs) {
    const base = pack.entitlement_base_info || {};
    const limit = Number(base.quota?.credits_limit);
    if (!Number.isFinite(limit) || limit <= 0) continue;
    const spent = Number(pack.usage?.credits_amount) || 0;
    // product_id 209 = Work 积分，其余是通用积分
    const isWork = Number(base.product_id) === 209;
    const name = pack.group_name || pack.display_desc || (isWork ? "Work 积分" : "通用积分");
    const expiresAt = iso(pack.expire_time ?? base.end_time);
    const prev = quotas[name];
    if (prev) {
      prev.total += limit;
      prev.used += spent;
      if (expiresAt && (!prev.expiresAt || expiresAt < prev.expiresAt)) prev.expiresAt = expiresAt;
    } else {
      // 全部行都是「积分资源包」而非滚动窗口：签到包 7 天过期、邀请奖励领完即止、
      // 每月登录积分按月发放。recurring:false 让 QuotaPackBar 把它们聚成一个
      // 积分池（大数总余额 + 分段条），而不是渲染成四条独立满条。
      // 「每月登录积分」名字含「月」会被 RECURRING_NAME_RE 误判为订阅窗口 →
      // 标 giftPack:true（CodeBuddy Monthly 同语义：月度发放的资源包，进池、
      // 不单独成行）。
      quotas[name] = {
        name, total: limit, used: spent, expiresAt,
        recurring: false,
        unit: "积分",
        ...(name === "每月登录积分" ? { giftPack: true } : {}),
      };
    }
    total += limit;
    used += spent;
  }
  const parts = Object.values(quotas)
    .map((p) => ({ ...p, total: round2(p.total), used: round2(p.used), remaining: round2(Math.max(p.total - p.used, 0)) }))
    .sort((a, b) => b.remaining - a.remaining);
  // 顶层总额优先信服务端自报的 usage_summary
  if (usageSummary && Number(usageSummary.total_amount) > 0) {
    total = Number(usageSummary.total_amount);
    used = Number(usageSummary.consumed_amount) || 0;
  }

  // 2. 套餐名（fail-soft：查不到不影响额度）
  let plan = null;
  let planExpiresAt = null;
  try {
    const r = await traePost(`${TRAE_API}${PAY_STATUS_PATH}`, accessToken, { req_source: 2 }, proxyOptions);
    if (r.ok && r.body && typeof r.body === "object") {
      const code = Number(r.body.code);
      if (!Number.isFinite(code) || code === 0) {
        const name = findField(r.body, "user_pay_identity_str");
        const expire = findField(r.body, "end_time") ?? findField(r.body, "next_billing_time");
        plan = typeof name === "string" && name ? name : null;
        planExpiresAt = iso(expire);
      }
    }
  } catch { /* fail-soft */ }

  if (parts.length === 0 && !usageSummary) {
    if (failed) return { message: `Trae usage fetch failed: ${failed.message}` };
    return {
      message: "No active Trae entitlement packs. 签到后这里会出现 150 积分/7 天的权益包。",
      plan,
      planExpiresAt,
    };
  }

  return {
    quotas: Object.fromEntries(parts.map((p) => [p.name, p])),
    plan,
    planExpiresAt,
    total: round2(total),
    used: round2(used),
    remaining: round2(Math.max(total - used, 0)),
    exceeded: total > 0 && total - used <= 0,
    empty: parts.length === 0 && !usageSummary,
  };
}
