/**
 * Antigravity weekly-quota fetcher + parser.
 *
 * Antigravity enforces both a 5-hour window (surfaced per-model by
 * getAntigravityUsage() via fetchAvailableModels) and a separate weekly window.
 * The weekly window is NOT part of the per-model response — it lives in a
 * distinct upstream RPC, `v1internal:retrieveUserQuotaSummary`, which groups
 * models into families ("Gemini Models", "Claude and GPT models") and reports
 * one bucket per family per window (5h + weekly), keyed by a
 * bucketId/displayName pair rather than by individual modelId. The window is
 * inferred from the bucketId/displayName text (undocumented API; shape
 * reverse-engineered by third-party Antigravity clients — see OmniRoute).
 */

import { parseResetTime, fetchWithTimeout } from "./shared.js";

const WEEKLY_QUOTA_CACHE_TTL_MS = 60 * 1000;
const _cache = new Map(); // cacheKey -> { data, fetchedAt }
const _inflight = new Map(); // cacheKey -> Promise

function buildCacheKey(accessToken, projectId) {
  return `${accessToken.substring(0, 16)}:${projectId || "default"}`;
}

/**
 * Fetch the weekly-quota-bearing retrieveUserQuotaSummary response (cached,
 * best-effort). Returns null on any failure — callers must treat this as
 * optional data, never a hard dependency, since the RPC is undocumented and
 * may not be available for every account/tier.
 */
export async function fetchAntigravityUserQuotaSummaryCached(
  accessToken,
  projectId,
  quotaSummaryApiUrl,
  userAgent,
  proxyOptions = null,
  options = {}
) {
  if (!accessToken || !projectId || !quotaSummaryApiUrl) return null;

  const cacheKey = buildCacheKey(accessToken, projectId);
  const cached = _cache.get(cacheKey);
  if (!options.forceRefresh && cached && Date.now() - cached.fetchedAt < WEEKLY_QUOTA_CACHE_TTL_MS) {
    return cached.data;
  }

  const inflight = _inflight.get(cacheKey);
  if (inflight !== undefined) return inflight;

  const promise = (async () => {
    try {
      const response = await fetchWithTimeout(
        quotaSummaryApiUrl,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            "User-Agent": userAgent,
            "X-Client-Name": "antigravity",
            "X-Client-Version": "1.23.2",
          },
          body: JSON.stringify({ project: projectId }),
        },
        10000,
        proxyOptions
      );
      if (!response.ok) return null;
      const data = await response.json();
      _cache.set(cacheKey, { data, fetchedAt: Date.now() });
      return data;
    } catch {
      return null;
    }
  })().finally(() => {
    _inflight.delete(cacheKey);
  });

  _inflight.set(cacheKey, promise);
  return promise;
}

/** Matches a bucket's combined bucketId+displayName text against a window keyword. */
function bucketMatchesWindow(bucket, keyword) {
  const text = `${String(bucket.bucketId || "")} ${String(bucket.displayName || "")}`.toLowerCase();
  return keyword.test(text);
}

const WEEKLY_KEYWORD = /\bweekly\b/;

/** Turns a group displayName (e.g. "Gemini Models", "Claude and GPT models") into a quota key. */
function slugifyGroupWeeklyKey(displayName) {
  const cleaned = String(displayName || "")
    .toLowerCase()
    .replace(/\bmodels?\b/g, "")
    .replace(/\band\b/g, " ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned ? `${cleaned}_weekly` : null;
}

/** Extracts `groups[]` from either observed response envelope (top-level or nested). */
function extractSummaryGroups(summaryData) {
  const root = summaryData || {};
  if (Array.isArray(root.groups)) return root.groups;
  const nested = root.quotaSummary?.groups;
  return Array.isArray(nested) ? nested : [];
}

/** Parses one model-family group into its weekly quota entry, or null when absent/invalid. */
function parseGroupWeeklyQuota(group) {
  const buckets = Array.isArray(group.buckets) ? group.buckets : [];
  const weeklyBucketValue = buckets.find(
    (b) => b && typeof b === "object" && bucketMatchesWindow(b, WEEKLY_KEYWORD)
  );
  if (!weeklyBucketValue) return null;

  const weeklyBucket = weeklyBucketValue;
  if (weeklyBucket.disabled === true) return null;

  const key = slugifyGroupWeeklyKey(String(group.displayName || ""));
  if (!key) return null;

  const rawFraction = Number(weeklyBucket.remainingFraction);
  if (!Number.isFinite(rawFraction) || rawFraction < 0) return null;

  const remainingFraction = Math.max(0, Math.min(1, rawFraction));
  const resetAt = parseResetTime(weeklyBucket.resetTime);
  const isUnlimited = !resetAt && remainingFraction >= 1;
  const QUOTA_NORMALIZED_BASE = 1000;
  const total = QUOTA_NORMALIZED_BASE;
  const remaining = Math.round(total * remainingFraction);

  return {
    key,
    quota: {
      used: isUnlimited ? 0 : Math.max(0, total - remaining),
      total: isUnlimited ? 0 : total,
      resetAt,
      remainingPercentage: isUnlimited ? 100 : remainingFraction * 100,
      unlimited: isUnlimited,
      fractionReported: true,
      displayName: String(group.displayName || "").trim() || undefined,
    },
  };
}

/**
 * Parse the raw retrieveUserQuotaSummary response into weekly UsageQuota
 * entries, one per model family group. Tolerant of the two response envelopes
 * third-party clients have observed (groups[] at the top level, or nested
 * under quotaSummary.groups[]).
 */
export function parseAntigravityWeeklyQuotas(summaryData) {
  const quotas = {};
  for (const groupValue of extractSummaryGroups(summaryData)) {
    if (!groupValue || typeof groupValue !== "object") continue;
    const entry = parseGroupWeeklyQuota(groupValue);
    if (entry) quotas[entry.key] = entry.quota;
  }
  return quotas;
}

/** Fetch + parse in one call — the only entry point google.js needs. */
export async function fetchAndParseAntigravityWeeklyQuotas(
  accessToken,
  projectId,
  quotaSummaryApiUrl,
  userAgent,
  proxyOptions = null,
  options = {}
) {
  const data = await fetchAntigravityUserQuotaSummaryCached(
    accessToken,
    projectId,
    quotaSummaryApiUrl,
    userAgent,
    proxyOptions,
    options
  );
  return parseAntigravityWeeklyQuotas(data);
}
