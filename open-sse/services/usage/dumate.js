/**
 * DuMate (百度搭子) usage — DuMate 控制台的积分/配额视图。
 *
 * 数据源与 DuMate 网页客户端同源（从 dumate.baidu.com 的 app bundle 逆出）：
 *   GET console.bce.baidu.com/api/dumate/points/quota_overview
 *         ?timezone=Asia%2FShanghai&clientType=desktop&ignoreLoginBonus=true
 *       -> {isSubscribed, usedPoints, totalPoints, subscription:[pack], incremental:[pack],
 *           modelThrottleInfo}
 *   GET console.bce.baidu.com/api/dumate/points/loginBonusInfo
 *       -> {totalTimes, totalPoints, hasIssued, signInDays[]}
 *   pack = {packageType: plan_experience|plan_pro|plan_max|plan_team|plan_point|grant_point|event_bonus,
 *           source: event_bonus|invite_bonus|login_bonus|..., usedPoints, totalPoints,
 *           expireDate, pointsExpireDate, status:"active", autoRenewStatus}
 *
 * 凭据 = 连接上存的 Cookie（connection.apiKey）：二维码登录写入的 JSON
 * （{src:"dumate-qr",cookies:[...]}）或粘贴的 Cookie 串/导出 JSON，都由
 * shared/dumate/cookies.js 解析。
 *
 * 会话过期时：若凭据里带百度通行证（BDUSS），走 shared/dumate/token.js 的
 * tokenFor() 做一次纯 HTTP 静默续期（与聊天链路同一份实现），把新 Cookie
 * 通过回调交回调用方持久化；没有通行证则报 needs-reauth 文案。
 *
 * ⚠️ 配额接口读的是**控制台会话**（bce-sessionid），不是网关 token——但两者的
 * 失效是同一个根因（通行证死了），所以复用同一条续期路径。
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { parseCookies, cookieHeader, hasPassport, slimCookie } from "../../shared/dumate/cookies.js";
import { tokenFor, UA, REAUTH_MSG } from "../../shared/dumate/token.js";

const CONSOLE = "console.bce.baidu.com";
const QUOTA_PATH =
  "/api/dumate/points/quota_overview?timezone=Asia%2FShanghai&clientType=desktop&ignoreLoginBonus=true";
const BONUS_PATH = "/api/dumate/points/loginBonusInfo";

/** 只把域名作用域覆盖 console 的 cookie 发出去（passport 域的不发） */
function sendable(arr) {
  return arr.filter((c) => {
    if (!c.domain) return true;
    const d = String(c.domain).replace(/^\./, "").toLowerCase();
    return CONSOLE === d || CONSOLE.endsWith("." + d);
  });
}

async function consoleGet(path, cookies, proxyOptions) {
  const response = await proxyAwareFetch(
    `https://${CONSOLE}${path}`,
    {
      method: "GET",
      headers: {
        Cookie: cookieHeader(cookies),
        "User-Agent": UA,
        Accept: "application/json",
        Referer: `https://${CONSOLE}/dumate/`,
        "X-Requested-With": "XMLHttpRequest",
      },
    },
    proxyOptions,
  );
  const text = await response.text().catch(() => "");
  return { status: response.status, text };
}

/** 百度以「重定向到登录页 / 非 JSON / code!==0 + 登录文案」表达会话失效 */
function isLoginFailure({ status, text }) {
  if (status === 401 || status === 403 || (status >= 300 && status < 400)) return true;
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return true;
  }
  if (payload?.code === 0 && payload?.result) return false;
  const message =
    typeof payload?.message === "object" ? JSON.stringify(payload.message) : String(payload?.message ?? "");
  return /login|登录|凭证|unauthori|过期/i.test(message) || !payload?.result;
}

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n) => Math.round(n * 100) / 100;
const expIso = (sec) => {
  const ms = Number(sec) * 1000;
  return Number.isFinite(ms) && ms > 0 && new Date(ms).getFullYear() <= 2099 ? new Date(ms).toISOString() : null;
};

const SUB_LABEL = { plan_experience: "体验套餐", plan_pro: "Pro 套餐", plan_max: "Max 套餐", plan_team: "团队套餐" };
const SRC_LABEL = { login_bonus: "每日赠送积分", invite_bonus: "邀请赠送积分", event_bonus: "活动赠送积分", first_bonus: "新人赠送积分" };
const PLAN_LABEL = { plan_experience: "体验版", plan_pro: "Pro", plan_max: "Max", plan_team: "团队版" };

function packLabel(pack, idx, isSub) {
  const base = isSub
    ? SUB_LABEL[pack.packageType] || `订阅包 ${pack.packageType || idx + 1}`
    : pack.packageType === "plan_point"
      ? "积分加油包"
      : SRC_LABEL[pack.source] || "赠送积分";
  const permanent = !expIso(pack.pointsExpireDate ?? pack.expireDate);
  return permanent && !isSub ? `${base}·永久` : base;
}

function buildQuotas(result, bonus) {
  const quotas = {};
  const used = (o) => round2(num(o.usedPoints));
  const total = (o) => round2(num(o.totalPoints));

  let i = 0;
  for (const pack of Array.isArray(result.subscription) ? result.subscription : []) {
    if (pack.status !== "active") continue;
    let name = `订阅·${packLabel(pack, i++, true)}`;
    while (quotas[name]) name += "·2";
    quotas[name] = {
      used: used(pack),
      total: total(pack),
      resetAt: expIso(pack.pointsExpireDate ?? pack.expireDate),
      recurring: true,
    };
  }

  i = 0;
  for (const pack of Array.isArray(result.incremental) ? result.incremental : []) {
    if (pack.status !== "active") continue;
    let name = packLabel(pack, i++, false);
    while (quotas[name]) name += "·2";
    quotas[name] = {
      used: used(pack),
      total: total(pack),
      resetAt: expIso(pack.pointsExpireDate ?? pack.expireDate),
      recurring: false,
      giftPack: pack.packageType !== "plan_point",
    };
  }

  // 余额行：isCreditBalance 让窗口汇总器跳过它，只喂 connection.quotaBalance
  const totalPoints = num(result.totalPoints);
  const usedPoints = num(result.usedPoints);
  quotas["积分余额"] = {
    used: round2(usedPoints),
    total: round2(totalPoints),
    remaining: round2(Math.max(0, totalPoints - usedPoints)),
    isCreditBalance: true,
    displayRemaining: true,
  };

  // 每日签到：前端在 checkinToday===true 且非 isCreditBalance 时渲染「今日已签到 · 连续 N 天」
  if (bonus) {
    const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    const checked = bonus.hasIssued === true || (Array.isArray(bonus.signInDays) && bonus.signInDays.includes(today));
    quotas["每日签到"] = {
      used: 0,
      total: 0,
      checkinToday: checked,
      streakDays: Number.isInteger(bonus.totalTimes)
        ? bonus.totalTimes
        : Array.isArray(bonus.signInDays)
          ? bonus.signInDays.length
          : 0,
      isCreditBalance: false,
      detailOnly: true,
    };
  }

  return quotas;
}

function planOf(result) {
  const active = (Array.isArray(result.subscription) ? result.subscription : []).find(
    (p) => p.status === "active",
  );
  const base = active ? PLAN_LABEL[active.packageType] || active.packageType : "Free";
  const throttle = result.modelThrottleInfo;
  return throttle && throttle.throttled === true ? `${base} · 限流中` : base;
}

/**
 * @param {object} args
 * @param {string} args.apiKey              - 连接上存的 Cookie（串或 JSON）
 * @param {boolean} [args.force]            - 强制重取，忽略缓存
 * @param {object|null} [args.proxyOptions]
 * @param {(raw:string)=>Promise<void>} [args.onRenewed] - 静默续期后回写新 Cookie
 * @returns {Promise<{plan?:string, quotas?:object, message?:string}>}
 */
export async function getDumateUsage({ apiKey, proxyOptions = null, onRenewed = null } = {}) {
  let raw = String(apiKey ?? "");
  let cookies = sendable(parseCookies(raw));
  if (!cookies.length) return { message: "DuMate：没有可用的登录 Cookie，请重新登录" };

  let res;
  try {
    res = await consoleGet(QUOTA_PATH, cookies, proxyOptions);
  } catch (e) {
    return { message: `DuMate 配额查询失败: ${e.message}` };
  }

  if (isLoginFailure(res)) {
    if (!hasPassport(raw)) return { message: REAUTH_MSG };
    try {
      // 与聊天链路共用 tokenFor：内部只在「登录失效 + 有通行证」时才静默续期
      const renewed = await tokenFor(raw, { force: true });
      if (renewed.raw && renewed.raw !== raw) {
        raw = renewed.raw;
        if (typeof onRenewed === "function") {
          try {
            await onRenewed(raw);
          } catch {
            /* 持久化失败不影响本次读数 */
          }
        }
      }
      cookies = sendable(parseCookies(raw));
      res = await consoleGet(QUOTA_PATH, cookies, proxyOptions);
    } catch (e) {
      return { message: `${REAUTH_MSG}（自动续期失败：${String(e.message).slice(0, 120)}）` };
    }
    if (isLoginFailure(res)) return { message: REAUTH_MSG };
  }

  let payload;
  try {
    payload = JSON.parse(res.text);
  } catch {
    return { message: "DuMate 配额接口返回异常" };
  }
  if (payload?.code !== 0 || !payload?.result) {
    const detail = String(payload?.message?.global || payload?.message || payload?.code || "unknown");
    return { message: `DuMate 配额查询失败: ${detail.slice(0, 160)}` };
  }
  const result = payload.result;

  // 签到状态是独立端点，失败不能拖垮额度卡片
  let bonus = null;
  try {
    const b = await consoleGet(BONUS_PATH, cookies, proxyOptions);
    const j = JSON.parse(b.text);
    if (j?.code === 0 && j?.result) bonus = j.result;
  } catch {
    /* bonus 是装饰信息，失败忽略 */
  }

  const usage = { plan: planOf(result), quotas: buildQuotas(result, bonus) };
  const throttle = result.modelThrottleInfo;
  if (throttle && throttle.throttled === true && throttle.reason) {
    usage.message = `模型限流：${String(throttle.reason).slice(0, 160)}`;
  }
  return usage;
}

/** 供测试与续期回写使用：把续期后的凭据裁成存储形态 */
export function normalizeStoredCookies(raw) {
  return parseCookies(raw).map(slimCookie);
}

export { QUOTA_PATH, BONUS_PATH };
/** 单测用：配额聚合、套餐名、会话失效判定（非导出 API，勿在业务代码里调用） */
export { buildQuotas, planOf, isLoginFailure };