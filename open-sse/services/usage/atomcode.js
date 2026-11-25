/**
 * AtomCode (AtomGit CodingPlan) usage — the plan status endpoint carries the
 * plan and its rolling request window in one read:
 *   GET https://api.gitcode.com/api/v5/coding-plan/status-v2  (Bearer OAuth)
 *   → { codingplan_free: { plan_name, plan_type, expires_at, remaining_days },
 *       rate_limit_windows: [{ window_hours, call_limit, calls_used,
 *                              seconds_until_reset, reset_at, quota_exhausted }],
 *       current_usage: { window_token_limit, window_tokens_used, ... },
 *       window_quota_exhausted }
 * The CodingPlan management API is plain Bearer (only the llm-api inference
 * gateway needs the X-AtomCode-* signature), so this reuses the same
 * fetchAtomCodeStatus the sign-in flow uses. An expired token surfaces as an
 * "expired" message: the usage route then refreshes through the executor
 * (refreshAtomCodeToken), persists the new token and retries once.
 */
import { fetchAtomCodeStatus } from "../../shared/atomcode/auth.js";

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

function windowResetAt(w) {
  const secs = num(w?.seconds_until_reset);
  if (secs !== null && secs >= 0) return new Date(Date.now() + secs * 1000).toISOString();
  // reset_at is China wall time without an offset ("2026-11-25T15:55:44").
  if (typeof w?.reset_at === "string" && w.reset_at) {
    const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(w.reset_at);
    const ms = Date.parse(hasZone ? w.reset_at : `${w.reset_at}+08:00`);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return null;
}

export async function getAtomCodeUsage(accessToken, proxyOptions = null) {
  if (!accessToken) {
    return { message: "AtomCode usage unavailable: no access token" };
  }
  let status;
  try {
    status = await fetchAtomCodeStatus(accessToken, proxyOptions);
  } catch (error) {
    if (error?.code === "AUTH_EXPIRED" || error?.status === 401) {
      return { message: "AtomCode sign-in expired (401 unauthorized). Re-authorize the connection if refresh fails." };
    }
    return { message: `AtomCode connected. Unable to fetch usage: ${error.message}` };
  }
  if (!status || typeof status !== "object") {
    return { message: "AtomCode connected. Usage response was not JSON." };
  }

  const plan = status.codingplan_free && typeof status.codingplan_free === "object" ? status.codingplan_free : {};
  const quotas = {};

  const windows = Array.isArray(status.rate_limit_windows) ? status.rate_limit_windows : [];
  for (const w of windows) {
    if (!w || w.show_enable === 0) continue;
    const limit = num(w.call_limit);
    if (limit === null || limit <= 0) continue;
    const used = Math.max(0, num(w.calls_used) || 0);
    const remaining = Math.max(0, limit - used);
    const hours = num(w.window_hours) || (num(w.window_size_seconds) ? Math.round(w.window_size_seconds / 3600) : null);
    const key = hours ? `Session (${hours}h)` : `Window ${Object.keys(quotas).length + 1}`;
    quotas[key] = {
      total: limit,
      used,
      remaining,
      remainingPercentage: Math.round((remaining / limit) * 100),
      unit: "requests",
      resetAt: windowResetAt(w),
      unlimited: false,
    };
  }

  // Older/alternate shape: only current_usage present.
  if (Object.keys(quotas).length === 0 && status.current_usage && status.current_usage.placeholder !== true) {
    const cu = status.current_usage;
    const limit = num(cu.window_token_limit);
    if (limit !== null && limit > 0) {
      const used = Math.max(0, num(cu.window_tokens_used) || 0);
      const remaining = Math.max(0, limit - used);
      quotas[cu.window_hours ? `Session (${cu.window_hours}h)` : "Session"] = {
        total: limit,
        used,
        remaining,
        remainingPercentage: Math.round((remaining / limit) * 100),
        unit: "requests",
        resetAt: windowResetAt(cu),
        unlimited: false,
      };
    }
  }

  const planName = plan.plan_name || status.plan_type || plan.plan_type || undefined;
  const expiresAt = plan.expires_at || status.expires_at || null;
  const exhausted =
    status.window_quota_exhausted === true || windows.some((w) => w?.quota_exhausted === true);

  return {
    plan: planName ? (expiresAt ? `${planName} (until ${expiresAt})` : planName) : undefined,
    quotas,
    isQuotaExceeded: exhausted,
    ...(Object.keys(quotas).length === 0
      ? {
          message: planName
            ? `AtomCode connected (${planName}). The plan reports no request window.`
            : "AtomCode connected. No CodingPlan is active on this account.",
        }
      : {}),
  };
}
