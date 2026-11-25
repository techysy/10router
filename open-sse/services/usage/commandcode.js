/**
 * Command Code usage handler
 *
 * Command Code provides:
 * 1. Rolling window rate limits via /alpha/billing/credits:
 *    - 5-hour rolling limit (e.g. $3 on Go, $14 on GOAT, $16 on Pro)
 *    - Weekly rolling limit (e.g. $6 on Go, $35 on GOAT, $40 on Pro)
 * 2. Monthly credit allowance via /alpha/billing/credits:
 *    - monthlyCredits: remaining balance (e.g. $9.9855 out of $10)
 *    - purchasedCredits: top-up / pay-as-you-go credits
 * 3. Subscription status and renewal via /alpha/billing/subscriptions:
 *    - planId: "individual-go" -> "Go", etc.
 *    - currentPeriodEnd: ISO string for monthly cycle reset
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { buildCommandCodeHeaders } from "../../shared/commandCodeHeaders.js";
import { U, parseResetTime, toFiniteNumber } from "./shared.js";

const PLAN_LABELS = {
  "individual-go": "Go",
  "individual-goat": "GOAT",
  "individual-pro": "Pro",
  "individual-pro-v1": "Pro (Legacy)",
  "individual-provider": "BYOK",
  "individual-max": "Max 10x",
  "individual-ultra": "Max 20x",
  "teams-pro": "Team Pro",
};

const PLAN_MONTHLY_CAPS = {
  "individual-go": 10,
  "individual-goat": 70,
  "individual-pro": 30,
  "individual-pro-v1": 80,
  "individual-max": 150,
  "individual-ultra": 300,
  "teams-pro": 40,
};

function roundMoney(num) {
  return Math.round(toFiniteNumber(num, 0) * 10000) / 10000;
}

export async function getCommandCodeUsage(apiKey, proxyOptions = null) {
  if (!apiKey || typeof apiKey !== "string") {
    return { message: "Command Code API key not configured." };
  }

  const urls = U("commandcode");
  const creditsUrl = urls?.creditsUrl || "https://api.commandcode.ai/alpha/billing/credits";
  const subscriptionsUrl = urls?.subscriptionsUrl || "https://api.commandcode.ai/alpha/billing/subscriptions";

  const headers = buildCommandCodeHeaders({ apiKey: apiKey.trim(), accept: "application/json" });

  try {
    const creditsPromise = proxyAwareFetch(creditsUrl, { method: "GET", headers }, proxyOptions);
    const subPromise = Promise.resolve()
      .then(() => proxyAwareFetch(subscriptionsUrl, { method: "GET", headers }, proxyOptions))
      .catch(() => null);

    const [creditsRes, subRes] = await Promise.all([creditsPromise, subPromise]);

    if (creditsRes.status === 401 || creditsRes.status === 403) {
      return { message: "Command Code API key invalid or expired." };
    }

    if (!creditsRes.ok) {
      return { message: `Command Code credits API error (${creditsRes.status}).` };
    }

    const creditsData = await creditsRes.json();
    let subData = null;
    if (subRes && subRes.ok) {
      try {
        subData = await subRes.json();
      } catch {
        subData = null;
      }
    }

    const planId = subData?.data?.planId || null;
    const planName = PLAN_LABELS[planId] || (planId ? planId.replace(/^individual-/, "") : "Command Code");
    const currentPeriodEnd = subData?.data?.currentPeriodEnd || null;

    const windowLimits = creditsData?.windowLimits || {};
    const credits = creditsData?.credits || {};
    const quotas = {};

    // 1. 5-hour rolling limit
    if (windowLimits.fiveHour) {
      const cap = toFiniteNumber(windowLimits.fiveHour.cap, 0);
      const used = roundMoney(windowLimits.fiveHour.used);
      const remaining = Math.max(0, roundMoney(cap - used));
      const remainingPercentage = cap > 0 ? Math.max(0, Math.min(100, Math.round((remaining / cap) * 100))) : 100;
      quotas["session (5h)"] = {
        used,
        total: cap,
        remaining,
        remainingPercentage,
        resetAt: parseResetTime(windowLimits.fiveHour.resetAt),
        unlimited: false,
        recurring: true,
      };
    }

    // 2. Weekly rolling limit
    if (windowLimits.weekly) {
      const cap = toFiniteNumber(windowLimits.weekly.cap, 0);
      const used = roundMoney(windowLimits.weekly.used);
      const remaining = Math.max(0, roundMoney(cap - used));
      const remainingPercentage = cap > 0 ? Math.max(0, Math.min(100, Math.round((remaining / cap) * 100))) : 100;
      quotas["weekly (7d)"] = {
        used,
        total: cap,
        remaining,
        remainingPercentage,
        resetAt: parseResetTime(windowLimits.weekly.resetAt),
        unlimited: false,
        recurring: true,
      };
    }

    // 3. Monthly credits
    if (credits.monthlyCredits !== undefined && credits.monthlyCredits !== null) {
      const remaining = roundMoney(credits.monthlyCredits);
      const total = toFiniteNumber(credits.monthlyCreditsGranted) || PLAN_MONTHLY_CAPS[planId] || Math.ceil(remaining) || 10;
      const used = Math.max(0, roundMoney(total - remaining));
      const remainingPercentage = total > 0 ? Math.max(0, Math.min(100, Math.round((remaining / total) * 100))) : 100;
      quotas["Monthly Credits"] = {
        used,
        total,
        remaining,
        remainingPercentage,
        resetAt: parseResetTime(currentPeriodEnd),
        unlimited: false,
        recurring: true,
      };
    }

    // 4. Purchased credits (if any)
    if (credits.purchasedCredits && credits.purchasedCredits > 0) {
      const purchased = roundMoney(credits.purchasedCredits);
      quotas["Purchased Credits"] = {
        used: 0,
        total: purchased,
        remaining: purchased,
        remainingPercentage: 100,
        resetAt: null,
        unlimited: false,
        recurring: false,
      };
    }

    return {
      plan: planName,
      quotas,
    };
  } catch (error) {
    return { message: `Command Code usage fetch failed: ${error.message}` };
  }
}
