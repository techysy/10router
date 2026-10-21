// AtomCode usage — CodingPlan rolling CALL-COUNT windows.
//
// The plan's real quota is calls per window, not tokens: `status-v2` carries
// `rate_limit_windows[]`, and only windows with `show_enable === 1` are meant
// for display. `window_token_limit` is often null on the free tier, so it must
// not be the primary reading.
//
// The second pool (AI Hub) bills a monthly token quota and has no quota
// endpoint — nothing here invents a number for it.

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import {
  ATOMCODE_ADAPTER_USER_AGENT,
  ATOMCODE_CODINGPLAN_STATUS_PATH,
  atomcodeCodingPlanBase,
} from "../../shared/atomcode/constants.js";

const int = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

const str = (source, key) => {
  const value = source?.[key];
  return typeof value === "string" ? value.trim() : "";
};

/**
 * Map `status-v2` to the `{ quotas }` shape the dashboard consumes.
 *
 * Returns no quota rows when the payload carries none: "I did not understand
 * this response" must not become "the account has zero left" (that mistake
 * once marked healthy accounts as depleted).
 */
export function shapeAtomcodeUsage(payload) {
  const windows = Array.isArray(payload?.rate_limit_windows)
    ? payload.rate_limit_windows.filter(
        (item) => int(item?.show_enable) === 1 && int(item?.call_limit) > 0
      )
    : [];

  const plan = payload?.codingplan_free && typeof payload.codingplan_free === "object"
    ? payload.codingplan_free
    : null;
  const planName = str(plan, "plan_name");

  if (windows.length === 0) {
    return {
      ...(planName ? { plan: planName } : {}),
      message: planName
        ? "AtomCode plan is active but the upstream returned no visible quota window."
        : "AtomCode account has no active CodingPlan or visible quota window.",
    };
  }

  const quotas = {};
  const usedNames = new Set();
  for (const window of windows) {
    const limit = Math.max(0, int(window.call_limit));
    const used = Math.max(0, int(window.calls_used));
    const remaining = Math.max(0, limit - used);
    const hours = int(window.window_hours);
    let name = hours > 0 ? `近 ${hours} 小时调用次数` : "调用次数窗口";
    if (usedNames.has(name)) {
      let i = 2;
      while (usedNames.has(`${name} #${i}`)) i++;
      name = `${name} #${i}`;
    }
    usedNames.add(name);

    const seconds = int(window.seconds_until_reset);
    const quota = {
      name,
      used,
      total: limit,
      remaining,
      remainingPercentage: limit > 0 ? (remaining / limit) * 100 : 0,
      recurring: true,
      unit: "次",
      resetAtDisplay: str(window, "reset_at_display") || undefined,
      ...(seconds > 0 ? { resetAt: new Date(Date.now() + seconds * 1000).toISOString() } : {}),
      ...(window.quota_exhausted === true ? { exhausted: true } : {}),
    };
    quotas[name] = quota;
  }

  return {
    ...(planName ? { plan: planName } : {}),
    quotas,
  };
}

export async function getAtomcodeUsage(accessToken, apiKey, proxyOptions = null) {
  const token = accessToken || apiKey;
  if (!token) {
    return { message: "AtomCode access token or API key not available." };
  }

  let response;
  try {
    response = await proxyAwareFetch(
      `${atomcodeCodingPlanBase()}${ATOMCODE_CODINGPLAN_STATUS_PATH}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "User-Agent": ATOMCODE_ADAPTER_USER_AGENT,
        },
        signal: AbortSignal.timeout(20_000),
      },
      proxyOptions
    );
  } catch (error) {
    return { message: `AtomCode usage fetch failed: ${error?.message || error}` };
  }

  if (response.status === 401 || response.status === 403) {
    return { message: "AtomCode session is expired or not authorized. Please sign in again." };
  }
  if (!response.ok) {
    return { message: `AtomCode usage fetch returned HTTP ${response.status}.` };
  }

  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    return { message: "AtomCode usage response was not JSON." };
  }
  return shapeAtomcodeUsage(payload);
}
