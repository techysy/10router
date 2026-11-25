/**
 * Clixad usage — the gateway wallet carries the free daily allowance:
 *   GET https://clixad.onrender.com/v1/wallet   (Authorization: Bearer <token>)
 *   → { balance, free_tier: { daily_credits, credits_left, recommended, ... } }
 * free_tier.daily_credits is the day's allowance, credits_left what is left of
 * it. The wallet does not say when the day rolls over, so no resetAt is printed
 * rather than a guessed one. A positive `balance` (ad-earned / bought credits)
 * is shown as its own single-value card.
 */
import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { CLIXAD_CONFIG } from "../../config/clixad.js";

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

export async function getClixadUsage(accessToken, proxyOptions = null) {
  if (!accessToken) {
    return { message: "Clixad usage unavailable: no access token" };
  }
  try {
    const response = await proxyAwareFetch(
      CLIXAD_CONFIG.walletUrl,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          "X-Clixad-Client": CLIXAD_CONFIG.clientHeader,
        },
      },
      proxyOptions,
    );
    if (!response.ok) {
      // Clixad tokens never expire on their own; 401 means revoked → re-login.
      if (response.status === 401 || response.status === 403) {
        return { message: "Clixad token invalid or revoked (unauthorized). Sign in to the connection again with GitHub." };
      }
      return { message: `Clixad connected. Usage fetch returned ${response.status}.` };
    }
    const body = await response.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return { message: "Clixad connected. Usage response was not JSON." };
    }

    const tier = body.free_tier && typeof body.free_tier === "object" ? body.free_tier : null;
    const quotas = {};

    const daily = num(tier?.daily_credits);
    const left = num(tier?.credits_left);
    if (daily !== null && daily > 0) {
      const extra = num(tier?.extra_credits) || 0;
      const total = daily + Math.max(0, extra);
      const remaining = left !== null ? Math.max(0, left) : total;
      quotas["Daily free"] = {
        total,
        used: Math.max(0, total - remaining),
        remaining,
        remainingPercentage: total > 0 ? Math.round((remaining / total) * 100) : 0,
        unit: "credits",
        resetAt: null,
        unlimited: false,
      };
    } else if (left !== null) {
      quotas["Daily free"] = {
        total: left,
        used: 0,
        remaining: left,
        unit: "credits",
        resetAt: null,
        unlimited: false,
        isCreditBalance: true,
        displayRemaining: true,
        summarizesDetail: true,
      };
    }

    const balance = num(body.balance);
    if (balance !== null && balance > 0) {
      quotas.Balance = {
        total: balance,
        used: 0,
        remaining: balance,
        unit: "credits",
        resetAt: null,
        unlimited: false,
        isCreditBalance: true,
        displayRemaining: true,
      };
    }

    const exhausted = daily !== null && daily > 0 && left !== null && left <= 0 && !(balance > 0);
    return {
      plan: "Free (daily)",
      quotas,
      isQuotaExceeded: exhausted,
      ...(Object.keys(quotas).length === 0
        ? { message: "Clixad connected. The wallet reports no free-tier allowance." }
        : {}),
    };
  } catch (error) {
    return { message: `Clixad connected. Unable to fetch usage: ${error.message}` };
  }
}
