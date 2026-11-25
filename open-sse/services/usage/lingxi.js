/*
 * WPS 灵犀 (lingxi.kdocs.cn) usage — 智点余额 + 到期桶。
 *
 * 数据源与 CreditDaddy 签到/余额线同源（CD src/lingxiClient.js 逆出）：
 *   GET /api/public/v1/credits/balance
 *     -> {data:{bonus_credits:[{balance,value,consumed,expire_time,sku_key}],
 *              purchased_credits:[…], total_bonus, total_purchased, total_balance}}
 *   认证 = 连接上的 WPS 会话 Cookie 罐（capture/CD 同步写入的 apiKey），无签名。
 *
 * 到期桶（用户口径，2026-11-15 官方「智点详情」截图）：官方按包逐行展示
 * 「任务奖励 / 生效时间 / 到期时间 / 已用-总量」。每日签到会让包无限增长
 * （一天一包、30 天有效），逐包出卡会爆行——按到期日聚合为桶：
 *   同一天到期的包并成一格（used/total 求和，resetAt 取该日），
 *   先到期先显示（FIFO 消耗语义），超过上限的远期包并进「更远到期」一格。
 * 余额行 summarizesDetail：桶是余额的构成明细，汇总行只出一次，防双计。
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";

const BALANCE_URL = "https://lingxi.kdocs.cn/api/public/v1/credits/balance";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
export const REAUTH_MSG = "灵犀会话已失效 — 供应商页 → Capture Session 重新捕获 WPS Cookie";

/** 卡片明细行上限（余额行之外）。超出并进「更远到期」。 */
export const MAX_BUCKETS = 19;

function lingxiHeaders(cookie) {
  return {
    Cookie: String(cookie || "").trim(),
    Referer: "https://lingxi.kdocs.cn/",
    Origin: "https://lingxi.kdocs.cn",
    Accept: "application/json, text/plain, */*",
    "User-Agent": UA,
  };
}

/** 取 {YYYY-MM-DD} 到期日键；无到期日返回 ""（排最后，无 countdown）。 */
export function expiryKey(p) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(p?.expire_time || ""));
  return m ? m[1] : "";
}

/** 短名 MM-DD（桶名用，年份无信息量——包 30 天有效）。 */
function shortDate(key) {
  return key ? key.slice(5) : "";
}

/**
 * 把包聚合为到期桶。输入 pack = {balance, value, consumed, expire_time, sku_key}；
 * 输出按到期日升序（无到期日最后），> maxBuckets 的远期桶并进「更远到期」。
 */
export function bucketByExpiry(packs, maxBuckets = MAX_BUCKETS) {
  const buckets = new Map();
  for (const p of packs) {
    const key = expiryKey(p);
    if (!buckets.has(key)) {
      buckets.set(key, { key, expireAt: p.expire_time || null, balance: 0, total: 0, consumed: 0, packs: 0, grant: true });
    }
    const b = buckets.get(key);
    b.balance += Math.max(0, Number(p?.balance) || 0);
    b.total += Math.max(0, Number(p?.value) || 0);
    b.consumed += Math.max(0, Number(p?.consumed) || 0);
    b.packs += 1;
    // 混入非赠送来源（购买包）时桶不再是纯赠送
    if (p?.sku_key !== "ai_credits_grant") b.grant = false;
  }
  const sorted = [...buckets.values()].sort((a, b) => {
    if (!a.key) return 1;
    if (!b.key) return -1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  const rows = sorted.slice(0, maxBuckets);
  const overflow = sorted.slice(maxBuckets);
  if (overflow.length) {
    const tail = {
      key: "__overflow__",
      expireAt: overflow[overflow.length - 1].expireAt || null,
      balance: 0,
      total: 0,
      consumed: 0,
      packs: 0,
      grant: true,
    };
    for (const b of overflow) {
      tail.balance += b.balance;
      tail.total += b.total;
      tail.consumed += b.consumed;
      tail.packs += b.packs;
      if (!b.grant) tail.grant = false;
      tail.expireAt = b.expireAt || tail.expireAt; // 最远到期日
    }
    rows.push(tail);
  }
  return rows;
}

/** 桶 → 配额行（detailOnly 明细行；QuotaPackBar 渲染 X/Y + 到期 countdown）。 */
function bucketRow(b) {
  const name =
    b.key === "__overflow__"
      ? `更远到期 · ${b.packs} 包`
      : `${shortDate(b.key)} 到期${b.packs > 1 ? ` · ${b.packs} 包` : ""}`;
  return {
    name,
    used: b.consumed,
    total: b.total || b.balance,
    remaining: b.balance,
    resetAt: b.expireAt || undefined,
    // 不标 isCreditBalance：那是「无到期日的永久余额」语义（expiryExtractor
    // isPerpetual 直接跳过），而桶是硬到期的一次性包——标了它连接行的
    // 「最早到期」徽标（extractEarliestPackageExpiry）就永远写不进去。
    // 储值语义只在智点余额汇总行上。明细渲染走 displayRemaining，不受影响。
    displayRemaining: true,
    detailOnly: true,
    ...(b.grant ? { giftPack: true } : {}),
  };
}

/** 会话失效表达：401/403 或网关 JSON {"result":"UserUnauthorized"}。 */
export function isAuthFailure({ status, text }) {
  if (status === 401 || status === 403) return true;
  try {
    const j = JSON.parse(text);
    return j?.result === "UserUnauthorized" || j?.result === "Unauthorized" || j?.v7code === 401020001;
  } catch {
    return false;
  }
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * 灵犀智点用量。connection.apiKey = WPS Cookie 罐。
 * @returns {Promise<{plan?:string, quotas?:object, message?:string, exceeded?:boolean}>}
 */
export async function getLingxiUsage({ apiKey, proxyOptions = null } = {}) {
  const cookie = String(apiKey || "").trim();
  if (!cookie) return { message: "灵犀：连接上没有 WPS Cookie，请重新捕获" };

  let res;
  try {
    res = await proxyAwareFetch(BALANCE_URL, { method: "GET", headers: lingxiHeaders(cookie) }, proxyOptions);
  } catch (e) {
    return { message: `灵犀配额查询失败: ${e.message}` };
  }
  const text = await res.text().catch(() => "");
  if (isAuthFailure({ status: res.status, text })) return { message: REAUTH_MSG };
  if (!res.ok) return { message: `灵犀配额查询失败: HTTP ${res.status}` };

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return { message: "灵犀配额接口返回异常" };
  }
  const data = payload?.data;
  if (!data) return { message: "灵犀配额接口返回异常" };

  // 每日签到状态（dumate 同款）：checkinToday 推给卡片头徽章「今日已签到 ·
  // 连续 N 天」。任务面板旁路查询——失败不推翻余额，拿不到就不出行。
  let checkin = null;
  try {
    const { fetchLingxiTasks } = await import("../lingxiCheckin.js");
    const tasks = await fetchLingxiTasks(cookie, { proxyOptions });
    if (tasks.auth && typeof tasks.checkedIn === "boolean") {
      checkin = {
        checkinToday: tasks.checkedIn,
        streakDays: Number.isInteger(tasks.streakDays) ? tasks.streakDays : 0,
      };
    }
  } catch {
    // 任务面板拿不到不阻断余额卡
  }
  const checkinRow = checkin
    ? {
        used: 0,
        total: 0,
        checkinToday: checkin.checkinToday,
        streakDays: checkin.streakDays,
        isCreditBalance: false,
        detailOnly: true,
        summarizesDetail: true,
      }
    : null;

  const packs = [
    ...(Array.isArray(data.bonus_credits) ? data.bonus_credits : []),
    ...(Array.isArray(data.purchased_credits) ? data.purchased_credits : []),
  ];
  // 已过期/零值包不出行（服务端 active 标签口径同源：过期包不会出现在余额里）
  const now = Date.now();
  const active = packs
    .map((p) => ({
      balance: num(p?.balance),
      value: num(p?.value),
      consumed: num(p?.consumed),
      expire_time: p?.expire_time || null,
      sku_key: String(p?.sku_key || ""),
    }))
    .filter((p) => p.balance > 0 || p.value > 0)
    .filter((p) => !p.expire_time || new Date(p.expire_time).getTime() > now);

  if (!active.length) {
    // 拿不到逐包（接口半程/全部耗尽）：单值余额卡兜底
    const total = num(data.total_balance);
    return {
      plan: "智点余额",
      exceeded: total <= 0,
      quotas: {
        智点余额: {
          used: 0,
          total: total > 0 ? total : 0.000001,
          remaining: total,
          isCreditBalance: true,
          displayRemaining: true,
          recurring: true,
        },
        ...(checkinRow ? { 每日签到: checkinRow } : {}),
      },
    };
  }

  const sumBalance = active.reduce((s, p) => s + p.balance, 0);
  // 卡片大字区的倒计时 = 最新（最早）过期包的到期日——FIFO 下这是整笔余额的
  // 实际死线（CD 面板旧卡「至 YYYY-MM-DD 到期」同口径）。
  const earliestExpire = active
    .map((p) => p.expire_time)
    .filter(Boolean)
    .sort()[0] || null;
  const sumTotal = active.reduce((s, p) => s + p.value, 0);
  const sumUsed = active.reduce((s, p) => s + p.consumed, 0);

  const buckets = bucketByExpiry(active);
  const quotas = {
    // 余额行（大数字）：summarizesDetail 把它排除出逐包明细——桶是它的构成，
    // 明细再列一遍同数是纯重复（dumate 2026-11-14 同款双计教训）。
    智点余额: {
      used: sumUsed,
      total: sumTotal || sumBalance || 0.000001,
      remaining: sumBalance,
      isCreditBalance: true,
      displayRemaining: true,
      summarizesDetail: true,
      // 倒计时措辞用 Expires（硬到期），不是滚动窗口的 Reset
      resetAt: earliestExpire || undefined,
      recurring: false,
      // QuotaPackBar 头部右侧小字（meoo expiringBatch 同款通道）：储值池卡片
      // 大数右侧默认留空，但「一罐积分该回答『到什么时候』」——给出最早到期
      // 桶的余额与日期，头部即渲染 "900 · 至12-10到期"。
      ...(earliestExpire
        ? { expiringBatch: { remaining: buckets[0]?.balance ?? sumBalance, resetAt: earliestExpire } }
        : {}),
    },
  };
  for (const b of buckets) {
    const row = bucketRow(b);
    quotas[row.name] = row;
  }
  if (checkinRow) quotas["每日签到"] = checkinRow;

  return { plan: "智点余额", exceeded: sumBalance <= 0, quotas };
}

export const __test__ = {
  bucketByExpiry,
  bucketRow,
  expiryKey,
  isAuthFailure,
  MAX_BUCKETS,
  BALANCE_URL,
};

export default { getLingxiUsage };
