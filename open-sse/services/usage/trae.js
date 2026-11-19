// Trae（国内站）额度查询 — trae / trae-cn 连接线的权益包与套餐读取。
//
// 协议移植自 CreditDaddy traeClient.fetchTraeQuota（issue #28/#31 同一实现）：
//   POST https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage  {require_usage:true,req_source:2}
//     → 裸对象（无 {code,message} 信封），user_entitlement_pack_list 逐包展开
//   POST https://api.trae.cn/trae/api/v2/pay/ide_user_pay_status {req_source:2}
//     → 套餐名（Free / Lite / Pro）与到期时间；查不到不影响额度
// 鉴权 `Authorization: Cloud-IDE-JWT <jwt>`；头组合与 traeCheckin 同一套（CD 实测）。
//
// 每天签到发 150 分/7 天有效的包，同名包可堆几十个 —— 按「名称 + 到期日」分桶
// （Lingxi/MiniMax 账本到期桶先例），总额优先信服务端自报的 usage_summary。
// 旧形态按名称归并、到期取最早，有实锤问题：归并行的倒计时只对最早那一小撮
// 包成立（用户报「1d 22h后过期」实际只有部分包明天死）、且「每月登录积分」
// 带 giftPack 被折叠出正文（meta 说 4 个包正文只列 3 行）、逐包明细展开后
// 与正文完全重复。到期桶形态下每行倒计时都是真话。
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

/** 卡片明细行上限（余额行之外），超出并进「更远到期」（Lingxi 同款）。 */
export const MAX_BUCKETS = 19;

/** 到期日键 {YYYY-MM-DD}；无到期日 ""（排最后，无 countdown）。 */
function dayKeyOf(expiresAt) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(expiresAt || ""));
  return m ? m[1] : "";
}

/**
 * 原始权益包 → {name, total, used, expiresAt, packs} 列表（逐包、未分桶）。
 * product_id 209 = Work 积分，其余是通用积分。credits_limit ≤ 0 的包不出行。
 */
export function normalizeTraePacks(packs = []) {
  const out = [];
  for (const pack of packs) {
    const base = pack?.entitlement_base_info || {};
    const limit = Number(base.quota?.credits_limit);
    if (!Number.isFinite(limit) || limit <= 0) continue;
    const spent = Number(pack?.usage?.credits_amount) || 0;
    const isWork = Number(base.product_id) === 209;
    const name = pack?.group_name || pack?.display_desc || (isWork ? "Work 积分" : "通用积分");
    out.push({ name, total: limit, used: spent, expiresAt: iso(pack?.expire_time ?? base.end_time), packs: 1 });
  }
  return out;
}

/**
 * 按「名称 + 到期日」聚桶（Lingxi/MiniMax 账本到期桶先例）：同名同日并格，
 * 先到期先显示（FIFO 消耗语义），无到期日排最后。超过 MAX_BUCKETS 的远期桶
 * 并入「更远到期 · N 包」一格（丢名称保到期日——到期日才是有效信息）。
 */
export function bucketTraePacks(packs = [], maxBuckets = MAX_BUCKETS) {
  const buckets = new Map();
  for (const p of packs) {
    const key = `${p.name}|${dayKeyOf(p.expiresAt)}`;
    if (!buckets.has(key)) {
      buckets.set(key, { name: p.name, day: dayKeyOf(p.expiresAt), expireAt: p.expiresAt, total: 0, used: 0, packs: 0 });
    }
    const b = buckets.get(key);
    b.total += p.total;
    b.used += p.used;
    b.packs += 1;
    if (p.expiresAt && (!b.expireAt || p.expiresAt < b.expireAt)) b.expireAt = p.expiresAt;
  }
  const sorted = [...buckets.values()].sort((a, b) => {
    if (!a.day) return 1;
    if (!b.day) return -1;
    if (a.day !== b.day) return a.day < b.day ? -1 : 1;
    return String(a.name).localeCompare(String(b.name));
  });

  const rows = sorted.slice(0, maxBuckets);
  const overflow = sorted.slice(maxBuckets);
  if (overflow.length) {
    const tail = { name: "__overflow__", day: "", expireAt: null, total: 0, used: 0, packs: 0 };
    for (const b of overflow) {
      tail.total += b.total;
      tail.used += b.used;
      tail.packs += b.packs;
      if (b.expireAt && (!tail.expireAt || b.expireAt > tail.expireAt)) tail.expireAt = b.expireAt;
    }
    rows.push(tail);
  }
  return rows;
}

/** 桶 → detailOnly 明细行。recurring:false = 一次性到期包（非滚动窗口）。 */
function bucketRow(b) {
  const short = b.day ? b.day.slice(5) : "";
  const name =
    b.name === "__overflow__"
      ? `更远到期 · ${b.packs} 包`
      : `${b.name}${short ? ` · ${short}` : ""}${b.packs > 1 ? ` · ${b.packs} 包` : ""}`;
  return {
    name,
    used: round2(b.used),
    total: round2(b.total),
    remaining: round2(Math.max(b.total - b.used, 0)),
    resetAt: b.expireAt || undefined,
    displayRemaining: true,
    detailOnly: true,
    recurring: false,
    unit: "积分",
  };
}

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

  // 到期桶（用户定版 2026-11-19，Lingxi/MiniMax 账本先例）：按「名称 + 到期日」
  // 聚桶，同日同名并格，先到期先显示（FIFO 消耗语义）。每桶都是 detailOnly
  // 明细行——倒计时只对桶内包成立，不再拿「最早到期」冒充整行的死线。
  const buckets = bucketTraePacks(normalizeTraePacks(packs));
  const sumTotal = buckets.reduce((s, b) => s + b.total, 0);
  const sumUsed = buckets.reduce((s, b) => s + b.used, 0);
  // 顶层总额优先信服务端自报的 usage_summary
  let total = sumTotal;
  let used = sumUsed;
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

  if (buckets.length === 0 && !usageSummary) {
    if (failed) return { message: `Trae usage fetch failed: ${failed.message}` };
    return {
      message: "No active Trae entitlement packs. 签到后这里会出现 150 积分/7 天的权益包。",
      plan,
      planExpiresAt,
    };
  }

  const rows = buckets.map(bucketRow);
  // 汇总行（大数字 + 分段条的分母）：summarizesDetail 把它排除出逐包明细
  // （桶是它的构成，再列一遍同数是双计——dumate/lingxi 同款教训）。行名刻意
  // 避开「余额」（STORED_VALUE_RE → 退化成无分母单值卡，丢掉 X/Y 总额）与
  // 「资源包」（hasCollectionRow 特殊逻辑）——Qoder addOn 聚合行同款语义。
  const quotas = {};
  quotas["积分"] = {
    name: "积分",
    used: round2(used),
    total: round2(total) || 0.000001,
    remaining: round2(Math.max(total - used, 0)),
    displayRemaining: true,
    summarizesDetail: true,
    recurring: false,
    unit: "积分",
  };
  for (const r of rows) quotas[r.name] = r;

  return {
    quotas,
    plan,
    planExpiresAt,
    total: round2(total),
    used: round2(used),
    remaining: round2(Math.max(total - used, 0)),
    exceeded: total > 0 && total - used <= 0,
    empty: buckets.length === 0 && !usageSummary,
  };
}

export const __test__ = { normalizeTraePacks, bucketTraePacks, bucketRow, dayKeyOf, MAX_BUCKETS };
