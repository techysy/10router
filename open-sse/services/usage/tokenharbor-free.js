/**
 * Token Harbor Free Quota & Session Keep-Alive
 *
 * Scrapes https://tokenharbor.ai/dashboard to extract free allowance usage and reset time.
 * Supports dual modes:
 *  1. Native 10Router connection: Cookie passed in apiKey (or providerSpecificData.cookie)
 *  2. CreditDaddy pushed session: providerSpecificData.creditDaddyWebSession.cookie
 *
 * Security & Reliability:
 *  - Uses proxyAwareFetch with connection proxy support
 *  - Default strict SSL (rejectUnauthorized: true)
 *  - Fail-soft: returns helpful message instead of throwing
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";

const DASHBOARD_URL = "https://tokenharbor.ai/dashboard";

/**
 * Extract free quota information from Token Harbor dashboard HTML
 */
export function parseTokenHarborHtml(html) {
  // Check if we are redirected or see a login prompt
  if (
    !html ||
    html.includes("/api/auth/signin") ||
    html.includes("Sign in with Google") ||
    html.includes("Sign in to your account")
  ) {
    return { error: "Token Harbor session expired or invalid. Please re-login." };
  }

  // 1. Try to find "Free allowance" percentage, e.g. "80% used" or "20% remaining"
  let freeAllowanceUsed = null;
  const allowanceMatch = html.match(/Free allowance[\s\S]*?(\d+)%\s*(?:used|of total)/i);
  if (allowanceMatch) {
    freeAllowanceUsed = parseInt(allowanceMatch[1], 10);
  } else {
    // Fallback pattern: looking for percentage inside free allowance card / section
    const generalPercentMatch = html.match(/Free allowance[\s\S]*?(\d+)%/i);
    if (generalPercentMatch) {
      freeAllowanceUsed = parseInt(generalPercentMatch[1], 10);
    }
  }

  // 2. Try to find reset time (e.g. "Resets in 5d 4h", "Resets in 23h", "Resets tomorrow")
  let resetAt = null;
  let resetTimeDisplay = null;
  const resetMatch = html.match(/Resets?\s+(?:in\s+)?(?:(\d+)\s*[dD])?\s*(?:(\d+)\s*[hH])?\s*(?:(\d+)\s*[mM])?/i);
  if (resetMatch && (resetMatch[1] || resetMatch[2] || resetMatch[3])) {
    const days = parseInt(resetMatch[1] || "0", 10);
    const hours = parseInt(resetMatch[2] || "0", 10);
    const minutes = parseInt(resetMatch[3] || "0", 10);
    const msOffset = (days * 24 * 60 + hours * 60 + minutes) * 60 * 1000;
    if (msOffset > 0) {
      resetAt = new Date(Date.now() + msOffset).toISOString();
      resetTimeDisplay = `${days ? `${days}d ` : ""}${hours ? `${hours}h ` : ""}${minutes ? `${minutes}m` : ""}`.trim();
    }
  }

  if (freeAllowanceUsed === null) {
    // Check if authenticated but no free allowance shown (e.g. account without free tier or redesign)
    const hasUserIndicator = html.includes("Sign out") || html.includes("/api/auth/signout") || html.includes("Dashboard");
    if (hasUserIndicator) {
      return {
        quotas: {},
        message: "Token Harbor connected. No free allowance found on dashboard.",
      };
    }
    return { error: "Unable to parse Token Harbor quota. Session may be expired." };
  }

  const remaining = Math.max(0, 100 - freeAllowanceUsed);

  return {
    quotas: {
      freeAllowance: {
        name: "Free Allowance",
        used: freeAllowanceUsed,
        total: 100,
        remaining,
        remainingPercentage: remaining,
        percentScale: 100,
        resetAt,
        recurring: true,
        displayRemaining: true,
      },
    },
    plan: "Free Tier",
  };
}

/**
 * Fetch Token Harbor free usage
 */
export async function getTokenHarborFreeUsage(apiKey, proxyOptions = null, providerSpecificData = null) {
  // Extract cookie: priority to creditDaddyWebSession.cookie, fallback to apiKey
  const cookie =
    providerSpecificData?.creditDaddyWebSession?.cookie ||
    apiKey ||
    providerSpecificData?.cookie;

  if (!cookie || typeof cookie !== "string" || !cookie.trim()) {
    return { message: "Token Harbor session cookie not configured." };
  }

  const cleanCookie = cookie.trim();

  try {
    const res = await proxyAwareFetch(
      DASHBOARD_URL,
      {
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Cookie": cleanCookie,
          "Upgrade-Insecure-Requests": "1",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
        },
      },
      proxyOptions,
    );

    if (res.status === 401 || res.status === 403) {
      return { message: "Token Harbor session cookie invalid or expired (HTTP 401/403)." };
    }

    if (!res.ok) {
      return { message: `Token Harbor dashboard returned HTTP ${res.status}.` };
    }

    const html = await res.text();
    const parsed = parseTokenHarborHtml(html);

    if (parsed.error) {
      return { message: parsed.error };
    }

    return parsed;
  } catch (err) {
    return { message: `Token Harbor fetch failed: ${err.message}` };
  }
}
