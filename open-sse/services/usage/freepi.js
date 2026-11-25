/**
 * FreePi usage — the account endpoint carries the daily allowance:
 *   GET https://api.freepi.ai/me
 *     Authorization: Bearer <JWT>, x-client-version (≥ server minimum), x-session-id
 *   → { allowance_credits, remaining_credits_today,
 *       refill_at: "Thu 2026-11-26 8:00 AM CST (UTC+08:00)",
 *       remaining_usd_today, cap_usd_today, tier, ... }
 * allowance_credits is the day's pool, remaining_credits_today what is left;
 * refill_at (wall time + explicit UTC offset) is the window's reset.
 */
import crypto from "crypto";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { FREEPI_CONFIG } from "../../config/freepi.js";

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/** "Thu 2026-11-26 8:00 AM CST (UTC+08:00)" → ISO string (null when unparseable). */
export function parseFreePiRefillAt(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const direct = Date.parse(raw);
  const m = raw.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
  if (!m) return Number.isFinite(direct) ? new Date(direct).toISOString() : null;
  let hour = Number(m[4]);
  const ampm = (m[7] || "").toUpperCase();
  if (ampm === "PM" && hour < 12) hour += 12;
  if (ampm === "AM" && hour === 12) hour = 0;
  // Offset: prefer the explicit "(UTC+08:00)"; known abbreviations as fallback.
  let offsetMin = null;
  const off = raw.match(/(?:UTC|GMT)\s*([+-])(\d{1,2})(?::?(\d{2}))?/i);
  if (off) {
    offsetMin = (Number(off[2]) * 60 + Number(off[3] || 0)) * (off[1] === "-" ? -1 : 1);
  } else if (/\bCST\b/.test(raw)) {
    offsetMin = 8 * 60; // FreePi prints China Standard Time
  } else if (/\b(UTC|GMT|Z)\b/.test(raw)) {
    offsetMin = 0;
  }
  if (offsetMin === null) return Number.isFinite(direct) ? new Date(direct).toISOString() : null;
  const utcMs =
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour, Number(m[5]), Number(m[6] || 0)) -
    offsetMin * 60_000;
  return Number.isFinite(utcMs) ? new Date(utcMs).toISOString() : null;
}

export async function getFreePiUsage(accessToken, providerSpecificData = {}, proxyOptions = null) {
  if (!accessToken) {
    return { message: "FreePi usage unavailable: no access token" };
  }
  try {
    const sessionId =
      providerSpecificData?.sessionId || crypto.randomUUID();
    const response = await proxyAwareFetch(
      FREEPI_CONFIG.meUrl,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          "x-client-version": providerSpecificData?.clientVersion || FREEPI_CONFIG.clientVersion,
          "x-session-id": sessionId,
        },
      },
      proxyOptions,
    );
    if (!response.ok) {
      // JWT lasts ~90 days with no refresh: 401/403 means sign in again.
      if (response.status === 401 || response.status === 403) {
        return { message: "FreePi sign-in expired or revoked (unauthorized, ~90-day JWT, no refresh). Sign in to the connection again with GitHub." };
      }
      if (response.status === 426) {
        return { message: "FreePi connected. Usage fetch returned 426 (client version below the server minimum)." };
      }
      return { message: `FreePi connected. Usage fetch returned ${response.status}.` };
    }
    const body = await response.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return { message: "FreePi connected. Usage response was not JSON." };
    }

    const resetAt = parseFreePiRefillAt(body.refill_at);
    const quotas = {};
    const allowance = num(body.allowance_credits);
    const remainingRaw = num(body.remaining_credits_today);

    if (allowance !== null && allowance > 0) {
      const remaining = remainingRaw !== null ? Math.max(0, remainingRaw) : allowance;
      quotas["Daily credits"] = {
        total: allowance,
        used: Math.max(0, allowance - remaining),
        remaining,
        remainingPercentage: Math.round((remaining / allowance) * 100),
        unit: "credits",
        resetAt,
        unlimited: false,
      };
    } else if (remainingRaw !== null) {
      quotas["Daily credits"] = {
        total: remainingRaw,
        used: 0,
        remaining: remainingRaw,
        unit: "credits",
        resetAt,
        unlimited: false,
        isCreditBalance: true,
        displayRemaining: true,
        summarizesDetail: true,
        ...(resetAt ? { expiringBatch: { remaining: remainingRaw, resetAt } } : {}),
      };
    }

    // Paid / bonus wallets (only when present) as single-value cards.
    const extra = (num(body.bonus_credits) || 0) + (num(body.bonus_wallet_credits) || 0) + (num(body.premium_credits) || 0);
    if (extra > 0) {
      quotas.Bonus = {
        total: extra,
        used: 0,
        remaining: extra,
        unit: "credits",
        resetAt: null,
        unlimited: false,
        isCreditBalance: true,
        displayRemaining: true,
      };
    }

    const exhausted = allowance !== null && allowance > 0 && remainingRaw !== null && remainingRaw <= 0 && extra <= 0;
    return {
      plan: body.tier ? `Free (${body.tier})` : "Free",
      quotas,
      isQuotaExceeded: exhausted,
      ...(Object.keys(quotas).length === 0
        ? { message: "FreePi connected. The account reports no daily allowance." }
        : {}),
    };
  } catch (error) {
    return { message: `FreePi connected. Unable to fetch usage: ${error.message}` };
  }
}
