import croliDefinition from "../../providers/registry/croli.js";
import { extractConnectionBalance } from "./balanceExtractor.js";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";

const CROLI_CONFIG = croliDefinition.oauth;
const TIMEOUT_MS = 15_000;

function validBalance(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/**
 * Read Croli's stored wallet and current trial window. Wallet credits are
 * informational: they are not a quota denominator and must not affect routing.
 */
export async function getCroliUsage(accessToken, proxyOptions = null, fetchImpl = proxyAwareFetch) {
  if (typeof accessToken !== "string" || !accessToken.trim()) {
    return { plan: "Croli", quotas: {}, message: "Croli access token is unavailable." };
  }
  try {
    const response = await fetchImpl(`${CROLI_CONFIG.creditsBaseUrl}/v1/account/balance`, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }, proxyOptions);
    if (!response.ok) {
      const message = response.status === 401 || response.status === 403
        ? "Croli authentication expired. Reconnect the account to check credits."
        : `Croli balance API returned ${response.status}.`;
      return { plan: "Croli", quotas: {}, message };
    }
    const data = await response.json().catch(() => null);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { plan: "Croli", quotas: {}, message: "Croli returned an invalid balance response." };
    }
    const balance = validBalance(data.balance);
    if (balance === null) return { plan: "Croli", quotas: {}, message: "Croli returned an invalid wallet balance." };

    const quotas = {};
    const trial = data.trial;
    if (trial?.active === true) {
      const total = validBalance(trial.dailyLimitCredits);
      const remaining = validBalance(trial.remainingCredits);
      if (total !== null && total > 0 && remaining !== null) {
        const clampedRemaining = Math.min(total, remaining);
        quotas["Trial daily allowance"] = {
          total,
          used: total - clampedRemaining,
          remaining: clampedRemaining,
          remainingPercentage: (clampedRemaining / total) * 100,
          usedPercentage: ((total - clampedRemaining) / total) * 100,
          recurring: true,
          resetAt: typeof trial.nextResetAt === "string" && Number.isFinite(Date.parse(trial.nextResetAt))
            ? trial.nextResetAt
            : null,
          unit: "credits",
        };
      }
    }
    // This property is consumed by the usage endpoint for display only; never
    // insert wallet credits into quotas, where they could drive account routing.
    return {
      plan: "Croli",
      quotas,
      // Display-only. Do not return quotaBalance/total/remaining: Croli wallet
      // credits are ledger rewards, not an inference budget or routing signal.
      croli: { walletPoints: balance, trialActive: trial?.active === true,
        trialEndsAt: typeof trial?.endsAt === "string" ? trial.endsAt : null },
      message: `Croli wallet balance: ${balance.toLocaleString("en-US")} credits (separate from trial quota).`,
    };
  } catch (error) {
    return {
      plan: "Croli",
      quotas: {},
      message: error?.name === "TimeoutError" || error?.name === "AbortError"
        ? "Croli balance request timed out. Try again shortly."
        : "Croli balance request failed. Check the account proxy or network and retry.",
    };
  }
}
