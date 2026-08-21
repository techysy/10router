/**
 * Google usage handlers (Gemini CLI + Antigravity)
 */

import { CLIENT_METADATA } from "../../config/appConstants.js";
import { ANTIGRAVITY_IDE_USER_AGENT, ANTIGRAVITY_IDE_VERSION, ANTIGRAVITY_OAUTH_CLIENT } from "../../providers/shared.js";
import { U, parseResetTime, normalizeCloudCodeProjectId, fetchWithTimeout } from "./shared.js";

// Antigravity API config (from Quotio) — urls from registry, oauth client + dynamic UA kept here
const ANTIGRAVITY_CONFIG = {
  ...U("antigravity"),
  ...ANTIGRAVITY_OAUTH_CLIENT,
  userAgent: ANTIGRAVITY_IDE_USER_AGENT,
};

/**
 * Gemini CLI Usage — fetch per-model quota via Cloud Code Assist API.
 * Uses retrieveUserQuota (same endpoint as `gemini /stats`) returning
 * per-model buckets with remainingFraction + resetTime.
 */
export async function getGeminiUsage(accessToken, providerSpecificData, proxyOptions = null) {
  if (!accessToken) {
    return { plan: "Free", message: "Gemini CLI access token not available." };
  }

  try {
    // Resolve project id: prefer connection-stored id, else loadCodeAssist lookup.
    // #1271: OAuth save stores projectId on the connection, not providerSpecificData.
    let projectId = normalizeCloudCodeProjectId(providerSpecificData?.projectId);
    let plan = "Free";

    if (!projectId) {
      const subInfo = await getGeminiSubscriptionInfo(accessToken, proxyOptions);
      projectId = normalizeCloudCodeProjectId(subInfo?.cloudaicompanionProject);
      plan = subInfo?.currentTier?.name || plan;
    }

    if (!projectId) {
      return {
        plan,
        message: "Gemini CLI project ID not available. Reconnect Gemini CLI, or configure a Google Cloud project with Gemini Code Assist access before checking quota.",
      };
    }

    const response = await fetchWithTimeout(
      U("gemini-cli").quotaUrl,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ project: projectId }),
      },
      10000,
      proxyOptions
    );

    if (!response.ok) {
      return { plan, message: `Gemini CLI quota error (${response.status}).` };
    }

    const data = await response.json();
    const quotas = {};

    if (Array.isArray(data.buckets)) {
      for (const bucket of data.buckets) {
        if (!bucket.modelId || bucket.remainingFraction == null) continue;

        const remainingFraction = Number(bucket.remainingFraction) || 0;
        const total = 1000; // Normalized base, matches antigravity convention
        const remaining = Math.round(total * remainingFraction);
        const used = Math.max(0, total - remaining);

        quotas[bucket.modelId] = {
          used,
          total,
          resetAt: parseResetTime(bucket.resetTime),
          remainingPercentage: remainingFraction * 100,
          unlimited: false,
        };
      }
    }

    return { plan, quotas };
  } catch (error) {
    return { message: `Gemini CLI error: ${error.message}` };
  }
}

/**
 * Get Gemini CLI subscription info via loadCodeAssist
 */
async function getGeminiSubscriptionInfo(accessToken, proxyOptions = null) {
  try {
    const response = await fetchWithTimeout(
      U("gemini-cli").loadCodeAssistUrl,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ metadata: CLIENT_METADATA }),
      },
      10000,
      proxyOptions
    );
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Antigravity Usage - Fetch quota from Google Cloud Code API
 */
export async function getAntigravityUsage(accessToken, providerSpecificData, proxyOptions = null) {
  try {
    const subscriptionInfo = await getAntigravitySubscriptionInfo(accessToken, proxyOptions);
    const projectId = subscriptionInfo?.cloudaicompanionProject
      || providerSpecificData?.projectId
      || providerSpecificData?.project_id
      || null;
    const summaryUrls = [
      "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary",
      "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
    ];

    for (const summaryUrl of summaryUrls) {
      try {
        const response = await fetchWithTimeout(summaryUrl, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "User-Agent": "antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(projectId ? { project: projectId } : {}),
        }, 10000, proxyOptions);

        if (!response.ok) continue;
        const summary = await response.json();
        if (!Array.isArray(summary?.groups)) continue;

        const quotas = {};
        for (const [groupIndex, group] of summary.groups.entries()) {
          const rawGroupName = group?.displayName || `Quota Group ${groupIndex + 1}`;
          const normalizedName = String(rawGroupName).trim().toLowerCase();
          const groupName = normalizedName === "gemini models"
            ? "Gemini 模型"
            : normalizedName === "claude and gpt models"
              ? "Claude 和 GPT 模型"
              : rawGroupName;
          const rank = (bucket) => {
            const window = String(bucket?.window || "").toLowerCase();
            if (["5h", "five-hour", "five_hour"].includes(window)) return 0;
            if (["weekly", "week"].includes(window)) return 1;
            return 2;
          };
          const buckets = [...(Array.isArray(group?.buckets) ? group.buckets : [])]
            .sort((left, right) => rank(left) - rank(right));

          for (const [bucketIndex, bucket] of buckets.entries()) {
            const fraction = Number(bucket?.remainingFraction);
            if (!Number.isFinite(fraction)) continue;
            const remainingFraction = Math.max(0, Math.min(1, fraction));
            const window = String(bucket?.window || "").toLowerCase();
            const windowLabel = ["5h", "five-hour", "five_hour"].includes(window)
              ? "5 小时限额"
              : ["weekly", "week"].includes(window)
                ? "周限额"
                : (bucket?.displayName || bucket?.window || `限额 ${bucketIndex + 1}`);
            const total = 1000;
            const remaining = Math.round(total * remainingFraction);
            const id = bucket?.bucketId || `${groupIndex}-${window || bucketIndex}`;
            quotas[id] = {
              used: Math.max(0, total - remaining),
              total,
              resetAt: parseResetTime(bucket?.resetTime),
              remainingPercentage: remainingFraction * 100,
              unlimited: false,
              displayName: `${groupName} · ${windowLabel}`,
            };
          }
        }

        if (Object.keys(quotas).length > 0) {
          return {
            plan: subscriptionInfo?.currentTier?.name || "Antigravity",
            quotas,
            subscriptionInfo,
          };
        }
      } catch (summaryError) {
        console.warn("[Antigravity Usage] Quota summary failed:", summaryUrl, summaryError.message);
      }
    }

    // Fallback if summary endpoints fail
    const response = await fetchWithTimeout(ANTIGRAVITY_CONFIG.quotaApiUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "User-Agent": ANTIGRAVITY_CONFIG.userAgent,
        "Content-Type": "application/json",
        "X-Client-Name": "antigravity",
        "X-Client-Version": ANTIGRAVITY_IDE_VERSION,
      },
      body: JSON.stringify(projectId ? { project: projectId } : {}),
    }, 10000, proxyOptions);

    if (response.status === 403) {
      return {
        message: "Antigravity quota API access forbidden. Chat may still work.",
        quotas: {}
      };
    }

    if (response.status === 401) {
      return {
        message: "Antigravity quota API authentication expired. Chat may still work.",
        quotas: {}
      };
    }

    if (!response.ok) {
      throw new Error(`Antigravity API error: ${response.status}`);
    }

    const data = await response.json();
    const quotas = {};
    if (data.models) {
      for (const [modelKey, info] of Object.entries(data.models)) {
        if (!info.quotaInfo) continue;
        const remainingFraction = info.quotaInfo.remainingFraction || 0;
        const remainingPercentage = remainingFraction * 100;
        const total = 1000;
        const remaining = Math.round(total * remainingFraction);
        const used = total - remaining;
        quotas[modelKey] = {
          used,
          total,
          resetAt: parseResetTime(info.quotaInfo.resetTime),
          remainingPercentage,
          unlimited: false,
          displayName: info.displayName || modelKey,
        };
      }
    }

    return {
      plan: subscriptionInfo?.currentTier?.name || "Antigravity",
      quotas,
      subscriptionInfo,
    };
  } catch (error) {
    console.error("Failed to fetch Antigravity usage:", error);
    return {
      plan: "Unknown",
      quotas: {},
      error: error.message
    };
  }
}

/**
 * Get Antigravity subscription info
 */
async function getAntigravitySubscriptionInfo(accessToken, proxyOptions = null) {
  try {
    const response = await fetchWithTimeout(ANTIGRAVITY_CONFIG.loadProjectApiUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "User-Agent": ANTIGRAVITY_CONFIG.userAgent,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ metadata: CLIENT_METADATA, mode: 1 }),
    }, 10000, proxyOptions);

    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    console.error("[Antigravity Subscription] Error:", error.message);
    return null;
  }
}
