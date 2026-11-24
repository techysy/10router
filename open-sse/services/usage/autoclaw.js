/**
 * AutoClaw（智谱澳龙）credits — GET {account host}/agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw
 * Auth: Bearer <account access token> + the signed managed-layer headers.
 *
 * Pure points model (no total / no reset window): the headline row is the
 * wallet total in the Meoo / DeepSeek credit-pot shape (full remaining
 * against the balance, `unlimited` while > 0, row name starting with
 * "Balance" so balanceExtractor claims it); each non-zero category wallet
 * (reward / daily / subscription / fuel_pack …) rides as a detailOnly row.
 * A daily sign-in status row is added when the task list is readable.
 * Region follows the token's JWT source_id (CN tokens are only accepted on
 * the CN account host, intl tokens on the global one).
 *
 * "Unreadable" is never reported as zero — a failed read returns a message.
 */

import {
  autoclawRegionFor,
  fetchAutoclawWallets,
  fetchAutoclawTasks,
} from "../../shared/autoclaw/client.js";
import { AUTOCLAW_DAILY_SIGNIN_TASK } from "../../shared/autoclaw/constants.js";

const WALLET_LABELS = {
  reward: "奖励积分",
  daily: "每日积分",
  subscription: "订阅积分",
  fuel_pack: "加油包积分",
  other: "其他积分",
};

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {string} provider - "autoclaw" | "autoclaw-cn"
 * @param {{accessToken?: string, refreshToken?: string}} credentials
 * @param {object|null} proxyOptions
 * @param {{fetchImpl?: Function}} [opts]
 */
export async function getAutoclawUsage(provider, credentials = {}, proxyOptions = null, opts = {}) {
  const plan = provider === "autoclaw-cn" ? "AutoClaw CN" : "AutoClaw";
  const accessToken = credentials?.accessToken;
  if (typeof accessToken !== "string" || !accessToken.trim()) {
    return { plan, quotas: {}, message: "AutoClaw 积分需要有效的登录凭据，请重新登录该账号。" };
  }
  const region = autoclawRegionFor(provider, credentials);
  const net = { region, proxyOptions, fetchImpl: opts.fetchImpl || null };

  let wallets;
  try {
    wallets = await fetchAutoclawWallets(accessToken, net);
  } catch (error) {
    const expired = error?.signIn === "expired";
    return {
      plan,
      quotas: {},
      message: expired
        ? "AutoClaw 登录已失效，请重新登录该账号后查看积分。"
        : `AutoClaw 积分查询失败：${error?.message || "unknown"}`,
    };
  }

  const total = Math.max(0, num(wallets?.total_balance) ?? 0);
  const quotas = {
    "Balance （积分）": {
      used: 0,
      total,
      remainingPercentage: total > 0 ? 100 : 0,
      resetAt: null,
      unlimited: total > 0,
      summarizesDetail: true,
    },
  };
  for (const w of Array.isArray(wallets?.wallets) ? wallets.wallets : []) {
    const balance = num(w?.balance);
    if (!(balance > 0)) continue;
    const label = String(w.display_name || WALLET_LABELS[w.public_wallet_type] || w.public_wallet_type || "积分");
    quotas[label] = {
      used: 0,
      total: balance,
      remainingPercentage: 100,
      resetAt: w.expire_at || w.expires_at || null,
      detailOnly: true,
      recurring: false,
    };
  }

  let signin = null;
  try {
    const tasks = await fetchAutoclawTasks(accessToken, net);
    const t = tasks.find((x) => x?.task_id === AUTOCLAW_DAILY_SIGNIN_TASK);
    if (t) {
      const done = String(t.status || "") === "completed";
      const reward = num(t.reward_points) || 0;
      signin = { done, reward };
      quotas["每日签到"] = {
        used: done ? 1 : 0,
        total: 1,
        remainingPercentage: done ? 0 : 100,
        resetAt: null,
        detailOnly: true,
        recurring: true,
      };
    }
  } catch { /* task list is optional decoration */ }

  return {
    plan,
    quotas,
    ...(signin ? { autoclaw: { dailySignin: signin } } : {}),
  };
}
