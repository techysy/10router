/**
 * CodeArts usage — subscription meters + daily benefit pool.
 *
 * Two signed reads, deliberately independent (Rust balance.rs `fetch_both`):
 *   GET  {base}/snap-manager/v1/statistics/plugin     paid-plan token/credit meters
 *   GET  {benefitGateway}/api/v1/user/tokens/balance  daily benefit token pool
 *
 * One failing side must NOT blank the other: a paid account with no benefit
 * profile (`4004 benefit not found`) is normal, not an error. Only when both
 * fail is the card an error.
 */
import { nextDailyResetIso } from "../../utils/dailyReset.js";
import {
  CODEARTS_BASE_URL,
  CODEARTS_BENEFIT_BALANCE_PATH,
  CODEARTS_BENEFIT_GATEWAY_URL,
  CODEARTS_STATISTICS_PATH,
} from "../../config/codearts.js";
import {
  codeArtsFetch,
  isBenefitAbsent,
  resolveCodeArtsCredential,
} from "../../shared/codearts/client.js";

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function meterQuota(meter) {
  const used = num(meter.usedTokens);
  const allowance = num(meter.allowanceTokens);
  const creditRemaining = num(meter.creditRemaining);
  if (creditRemaining !== null) {
    // Credit pots are absolute balances, not 0–100 windows.
    return { used: 0, total: creditRemaining, remaining: creditRemaining, remainingPercentage: 100, resetAt: null, isCreditBalance: true, currency: "credits" };
  }
  if (used !== null && allowance && allowance > 0) {
    const remaining = Math.max(0, allowance - used);
    return {
      used,
      total: allowance,
      remaining,
      remainingPercentage: Math.round((remaining / allowance) * 100),
      resetAt: null,
    };
  }
  return null;
}

/** Parse the statistics document (field names are upstream spellings). */
export function parseCodeArtsStatistics(payload) {
  const root = asObject(payload?.data) || asObject(payload);
  const metrics = Array.isArray(root?.metrics) ? root.metrics : [];
  const wallets = [];
  const quotas = {};
  for (const metric of metrics) {
    if (!asObject(metric)) continue;
    if (metric.show === false) continue; // upstream's "do not display" (retired meters)
    const name = String(metric.name || "").trim();
    if (!name) continue;
    const wallet = {
      type: `meter:${name}`,
      displayName: name,
      usedTokens: num(metric.usage_token_num),
      allowanceTokens: num(metric.package_token_amount),
      creditTotal: num(metric.package_credit_amount),
      creditUsed: num(metric.package_credit_used),
      creditRemaining: num(metric.package_credit_remain),
    };
    wallets.push(wallet);
    const quota = meterQuota(wallet);
    if (quota) quotas[name] = quota;
  }
  return { wallets, quotas };
}

/**
 * Parse the benefit balance. `4004 + benefit not found` is `{absent:true}`
 * (normal for accounts that never registered a benefit profile); anything else
 * non-`0000` is an error.
 */
export function parseCodeArtsBenefit(payload, nowMs = Date.now()) {
  const root = asObject(payload);
  if (!root) return { error: "福利余额响应不是 JSON 对象" };
  const code = String(root.error_code || "");
  if (code !== "0000") {
    const message = String(root.error_msg || "");
    if (code === "4004" && isBenefitAbsent(message)) return { absent: true };
    return { error: `福利余额返回 ${code || "?"}：${message || "unknown"}` };
  }
  const result = asObject(root.result);
  if (!result) return { error: "福利余额响应缺少 result" };
  const limit = num(result.daily_token_limit);
  const used = num(result.daily_tokens_used) ?? 0;
  const unlimited = limit === null || limit < 0;
  const remaining = unlimited ? null : Math.max(0, limit - used);
  return {
    benefit: {
      channel: result.channel || "",
      dailyTokenLimit: limit,
      dailyTokensUsed: used,
      monthlyTokenLimit: num(result.monthly_token_limit),
      monthlyTokensUsed: num(result.monthly_tokens_used),
      totalBalance: num(result.total_balance),
      unlimited,
    },
    quota: {
      used,
      total: unlimited ? null : limit,
      remaining,
      remainingPercentage: unlimited ? 100 : (limit > 0 ? Math.round((remaining / limit) * 100) : 0),
      // The benefit pool is refilled every Beijing day. A positive balance is
      // an expiring asset and must rank ahead of packs that expire later; an
      // empty pool has nothing to spend and must not rank the account.
      ...(!unlimited && remaining > 0
        ? { resetAt: nextDailyResetIso(nowMs), recurring: true }
        : { resetAt: null, recurring: false }),
      isCreditBalance: false,
    },
  };
}

async function readJson(response) {
  const text = await response.text().catch(() => "");
  try {
    return { payload: text ? JSON.parse(text) : null, text };
  } catch {
    return { payload: null, text };
  }
}

export async function getCodeArtsUsage(connection, proxyOptions = null) {
  const credential = resolveCodeArtsCredential(connection);
  if (!credential) {
    return { message: "CodeArts 凭据不完整：请导入临时 AK/SK（需要 accessKeyId / secretAccessKey）" };
  }

  const [statisticsResponse, benefitResponse] = await Promise.allSettled([
    codeArtsFetch(`${CODEARTS_BASE_URL}${CODEARTS_STATISTICS_PATH}`, {
      method: "GET",
      credential,
      proxyOptions,
      timeoutMs: 20_000,
    }),
    codeArtsFetch(`${CODEARTS_BENEFIT_GATEWAY_URL}${CODEARTS_BENEFIT_BALANCE_PATH}`, {
      method: "GET",
      credential,
      proxyOptions,
      timeoutMs: 20_000,
    }),
  ]);

  let statistics = null;
  let statisticsError = null;
  if (statisticsResponse.status === "fulfilled") {
    const { payload, text } = await readJson(statisticsResponse.value);
    if (statisticsResponse.value.ok && payload) statistics = parseCodeArtsStatistics(payload);
    else statisticsError = `统计接口 ${statisticsResponse.value.status}${text ? `: ${text.slice(0, 200)}` : ""}`;
  } else {
    statisticsError = statisticsResponse.reason?.message || "统计接口请求失败";
  }

  let benefit = null;
  let benefitError = null;
  if (benefitResponse.status === "fulfilled") {
    const { payload, text } = await readJson(benefitResponse.value);
    if (payload) {
      const parsed = parseCodeArtsBenefit(payload);
      if (parsed.absent) benefit = null;
      else if (parsed.error) benefitError = parsed.error;
      else benefit = parsed;
    } else {
      benefitError = `福利接口 ${benefitResponse.value.status}${text ? `: ${text.slice(0, 200)}` : ""}`;
    }
  } else {
    benefitError = benefitResponse.reason?.message || "福利接口请求失败";
  }

  if (statisticsError && benefitError) {
    return { message: `CodeArts 额度读取失败：${statisticsError}（福利网关：${benefitError}）` };
  }

  const wallets = [...(statistics?.wallets || [])];
  const quotas = { ...(statistics?.quotas || {}) };
  if (benefit) {
    wallets.push({
      type: "benefit_daily_tokens",
      displayName: "福利模型日额度",
      balance: benefit.benefit.unlimited ? null : benefit.quota.remaining,
      balanceView: benefit.benefit.unlimited
        ? `无上限（已用 ${benefit.benefit.dailyTokensUsed} token）`
        : `剩 ${benefit.quota.remaining} / ${benefit.benefit.dailyTokenLimit} token`,
      unlimited: benefit.benefit.unlimited,
      usedTokens: benefit.benefit.dailyTokensUsed,
    });
    quotas["福利模型日额度"] = benefit.quota;
  }

  return {
    plan: "CodeArts",
    unit: "credits",
    available: benefit?.benefit?.totalBalance ?? null,
    wallets,
    quotas,
    benefit: benefit?.benefit || null,
    ...(statisticsError ? { statisticsError } : {}),
    ...(benefitError ? { benefitError } : {}),
    ...(!benefit ? { benefitAbsent: true } : {}),
  };
}
