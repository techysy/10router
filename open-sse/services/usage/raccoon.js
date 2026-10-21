/**
 * Raccoon 小浣熊 usage — wallet balances + subscription entitlement.
 *
 * Two upstream reads (same origin, Bearer JWT):
 *   GET /api/web/points/v1/balance           -> available_points + four wallets
 *   GET /api/web/auth/v1/entitlement_info    -> office / code plan entitlements
 *
 * The subscription read is best-effort: a failure there must not turn the
 * balance card red (the wallet is the useful number). Envelope handling mirrors
 * our Rust provider (raccoon/balance.rs request_json): non-2xx, or `code`
 * present and non-zero, is a failure; `data ?? payload` is the body.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import {
  RACCOON_BALANCE_URL,
  RACCOON_ENTITLEMENT_URL,
  RACCOON_REQUEST_TIMEOUT_MS,
  RACCOON_TOPUP_FROZEN,
  RACCOON_UNIT,
  RACCOON_WALLETS,
} from "../../config/raccoon.js";

const stripBearer = (token) => String(token || "").trim().replace(/^Bearer\s+/i, "");

function toIntegerOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(number) ? Math.floor(number) : null;
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

async function requestJson(url, token, proxyOptions) {
  let response;
  try {
    response = await proxyAwareFetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${stripBearer(token)}`,
      },
      signal: AbortSignal.timeout(RACCOON_REQUEST_TIMEOUT_MS),
    }, proxyOptions);
  } catch (error) {
    return { ok: false, status: 0, error: error?.message || String(error) };
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (response.status === 401) {
    return { ok: false, status: 401, error: "登录态已过期" };
  }
  if (response.status === 429) {
    return { ok: false, status: 429, error: "接口限流" };
  }
  if (!response.ok) {
    return { ok: false, status: response.status, error: `HTTP ${response.status}` };
  }
  if (payload && typeof payload === "object" && payload.code !== undefined && Number(payload.code) !== 0) {
    const message = typeof payload.message === "string" && payload.message.trim()
      ? payload.message.trim()
      : `code=${payload.code}`;
    return { ok: false, status: response.status, error: message };
  }
  const data = payload && typeof payload === "object" && payload.data !== undefined && payload.data !== null
    ? payload.data
    : payload;
  return { ok: true, status: response.status, data };
}

function walletQuota(balance) {
  // A wallet balance is an absolute credit pot, not a 0–100 window: use
  // isCreditBalance so the card prints the number once instead of "N / N".
  return {
    used: 0,
    total: balance,
    remaining: balance,
    remainingPercentage: balance > 0 ? 100 : 0,
    resetAt: null,
    isCreditBalance: true,
    currency: "points",
  };
}

export function parseRaccoonBalance(data) {
  const wallet = asObject(data);
  if (!wallet) return null;

  const wallets = [];
  const quotas = {};
  for (const { key, label } of RACCOON_WALLETS) {
    const balance = toIntegerOrNull(wallet[key]);
    if (balance === null) continue;
    wallets.push({ type: key, displayName: label, balance });
    quotas[label] = walletQuota(balance);
  }

  // Frozen top-up points are held back from available_points, so showing only
  // the four wallets would under-report money the user has already paid in.
  const frozen = toIntegerOrNull(wallet[RACCOON_TOPUP_FROZEN.key]);
  if (frozen !== null) {
    wallets.push({
      type: RACCOON_TOPUP_FROZEN.key,
      displayName: RACCOON_TOPUP_FROZEN.label,
      balance: frozen,
    });
    quotas[RACCOON_TOPUP_FROZEN.label] = walletQuota(frozen);
  }

  return {
    available: toIntegerOrNull(wallet.available_points),
    wallets,
    quotas,
  };
}

export function parseRaccoonSubscription(data) {
  const root = asObject(data);
  if (!root) return null;
  const office = asObject(root.office);
  const code = asObject(root.code);
  if (!office && !code) return null;

  const pick = (key) => {
    const value = office?.[key] ?? code?.[key];
    return value === null || value === undefined ? null : value;
  };
  const plan = asObject(pick("active_plan"));
  const planName = typeof plan?.type === "string"
    ? plan.type
    : (typeof pick("plan_type") === "string" ? pick("plan_type") : "");
  const active = office?.pro_enable === true || code?.pro_enable === true;

  return {
    planName,
    status: active ? "active" : "none",
    expireAt: pick("pro_expired_time") ?? plan?.subscription_expired_at ?? null,
    remainQuota: null,
    totalQuota: null,
  };
}

export async function getRaccoonUsage(accessToken, proxyOptions = null) {
  const token = stripBearer(accessToken);
  if (!token) {
    return { message: "Raccoon access token not available. Add a login token to view usage." };
  }

  const balance = await requestJson(RACCOON_BALANCE_URL, token, proxyOptions);
  if (!balance.ok) {
    if (balance.status === 401) {
      return { message: "Raccoon login expired (401). Update the connection token." };
    }
    return { message: `Raccoon balance API error${balance.status ? ` (${balance.status})` : ""}: ${balance.error || "request failed"}` };
  }

  const parsed = parseRaccoonBalance(balance.data);
  if (!parsed) {
    return { message: "Raccoon balance response was not a JSON object." };
  }
  if (parsed.wallets.length === 0) {
    return { message: "Raccoon balance response carried no wallet fields." };
  }

  // Best-effort: see module header.
  let subscription = null;
  let subscriptionError = null;
  const entitlement = await requestJson(RACCOON_ENTITLEMENT_URL, token, proxyOptions);
  if (entitlement.ok) {
    subscription = parseRaccoonSubscription(entitlement.data);
  } else {
    subscriptionError = entitlement.error || "request failed";
  }

  return {
    plan: subscription?.status === "active" && subscription.planName
      ? subscription.planName
      : "小浣熊",
    unit: RACCOON_UNIT,
    available: parsed.available,
    wallets: parsed.wallets,
    quotas: parsed.quotas,
    subscription,
    ...(subscriptionError ? { subscriptionError } : {}),
  };
}
