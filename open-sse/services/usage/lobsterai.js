/**
 * LobsterAI usage — points/credits from `GET /api/user/profile-summary`.
 *
 * ⚠️ Not `/api/user/quota`: that endpoint only reports the free credit total
 * (measured constant 300) and omits activity/check-in credits. Real balances are
 * an order of magnitude larger (reference implementation measured 5297.72 on an
 * account whose /quota read 300). Using the wrong endpoint shows a plausible but
 * permanently-too-small number and never errors.
 *
 * Shape read: `data.totalCreditsRemaining` (authoritative) →
 * `data.creditItems[].creditsRemaining` sum (still a real reading). When neither
 * exists we return a message instead of a fabricated 0 — a 0 balance makes the
 * account look depleted to the quota gate.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import {
  LOBSTERAI_PROFILE_SUMMARY_URL,
  LOBSTERAI_REQUEST_TIMEOUT_MS,
  LOBSTERAI_USER_AGENT,
} from "../../shared/lobsterai/constants.js";
import { parseCredits, unwrapEnvelope } from "../../shared/lobsterai/client.js";

export async function getLobsterAiUsage(accessToken, proxyOptions = null) {
  const token = typeof accessToken === "string" ? accessToken.trim() : "";
  if (!token) return { message: "LobsterAI access token not configured." };

  let response;
  try {
    response = await proxyAwareFetch(
      LOBSTERAI_PROFILE_SUMMARY_URL,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "User-Agent": LOBSTERAI_USER_AGENT,
        },
        signal: AbortSignal.timeout(LOBSTERAI_REQUEST_TIMEOUT_MS),
      },
      proxyOptions,
    );
  } catch (error) {
    return { message: `LobsterAI credits request failed: ${error?.message || error}` };
  }

  if (response.status === 401 || response.status === 403) {
    return { message: "LobsterAI session expired or unauthorized. Please re-authenticate." };
  }
  if (!response.ok) {
    return { message: `LobsterAI credits API error (${response.status}).` };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return { message: "LobsterAI credits response is not JSON." };
  }

  // Envelope: `{code:0,data:{…}}`; `data:null` with code 0 means the session is
  // dead. A bare object is accepted for tolerance (some gateways unwrap it).
  const unwrapped = unwrapEnvelope(payload, "积分查询");
  if (!unwrapped.ok) {
    return { message: unwrapped.message };
  }

  const { available, items } = parseCredits(unwrapped.data);
  if (available === null) {
    return { message: "LobsterAI profile-summary returned no credit balance." };
  }

  // One stored-value row: the value is a settled balance, not a window.
  // `isCreditBalance` keeps the card from printing "X / X" and the name carries
  // the unit in parentheses (the generic normalizer lifts it as small print).
  const quotas = {
    "积分余额 (积分)": {
      name: "积分余额 (积分)",
      used: 0,
      total: available,
      remaining: available,
      remainingPercentage: 100,
      isCreditBalance: true,
      recurring: false,
    },
  };

  // Per-package rows are informational only — collapsed under the balance row.
  for (const [index, item] of items.entries()) {
    if (!(item.remaining > 0)) continue;
    quotas[`积分包 ${index + 1} · ${item.type}`] = {
      name: `积分包 ${index + 1} · ${item.type}`,
      used: 0,
      total: item.remaining,
      remaining: item.remaining,
      remainingPercentage: 100,
      isCreditBalance: true,
      detailOnly: true,
      ...(item.expiresAt ? { resetAt: item.expiresAt } : {}),
    };
  }

  return { quotas };
}
