/**
 * Antigravity quota-summary fetcher + parser (v1internal:retrieveUserQuotaSummary).
 *
 * Antigravity enforces two independent windows per model family:
 *   - a 5-hour window (short-term burst pool), and
 *   - a weekly window (long-term cap).
 * The RPC groups models into families ("Gemini Models", "Claude and GPT models")
 * and reports one bucket per family per window. We surface exactly 4 quota rows
 * per account (2 families × {5h, weekly}), normalized to a 0–100 base so the
 * progress bar reflects a real percentage.
 *
 * The window type is read from an explicit `window` field when present, else
 * inferred from bucketId/displayName text (the API is undocumented; field
 * casing/shape differs across Antigravity clients). remainingFraction may be
 * top-level or nested under `remaining.remainingFraction`. Tolerant of both the
 * top-level `groups[]` and `quotaSummary.groups[]` response envelopes.
 */

import { parseResetTime, fetchWithTimeout } from "./shared.js";

const SUMMARY_CACHE_TTL_MS = 60 * 1000;
const _cache = new Map(); // cacheKey -> { data, fetchedAt }
const _inflight = new Map(); // cacheKey -> Promise

function buildCacheKey(accessToken, projectId) {
  return `${accessToken.substring(0, 16)}:${projectId || "default"}`;
}

/**
 * Fetch the retrieveUserQuotaSummary response (cached, best-effort). Returns
 * null on any failure — callers treat this as optional data, never a hard
 * dependency, since the RPC is undocumented and may not answer for every
 * account/tier/host.
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
  if (!options.forceRefresh && cached && Date.now() - cached.fetchedAt < SUMMARY_CACHE_TTL_MS) {
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
            "X-Client-Version": userAgent?.match(/antigravity\/ide\/([\d.]+)/)?.[1] || "2.11.0",
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

/** Extracts `groups[]` from either observed response envelope. */
function extractSummaryGroups(summaryData) {
  const root = summaryData || {};
  if (Array.isArray(root.groups)) return root.groups;
  const nested = root.quotaSummary?.groups;
  return Array.isArray(nested) ? nested : [];
}

// Normalize the many ways the window is written: explicit `window`, bucketId,
// or displayName. Returns a canonical key "5h" | "weekly" | null.
function bucketWindow(bucket) {
  const raw = String(bucket?.window || "").toLowerCase().trim();
  const text = `${String(bucket?.bucketId || "")} ${String(bucket?.displayName || "")}`.toLowerCase();
  const norm = (s) => {
    const w = String(s || "").toLowerCase();
    if (/5h|five[\s_-]?hour|hourly/.test(w)) return "5h";
    if (/weekly|week/.test(w)) return "weekly";
    return null;
  };
  return norm(raw) || norm(text);
}

// remainingFraction may be top-level or nested under remaining.remainingFraction.
function bucketRemainingFraction(bucket) {
  const top = Number(bucket?.remainingFraction);
  if (Number.isFinite(top)) return top;
  const nested = bucket?.remaining && typeof bucket.remaining === "object"
    ? Number(bucket.remaining.remainingFraction)
    : Number.NaN;
  return Number.isFinite(nested) ? nested : Number.NaN;
}

function familyDisplayName(rawName, index) {
  // Keep the upstream/official family label verbatim (English on Google's side)
  // rather than baking a localized string into data — quota rows render
  // displayName directly and are not currently routed through the i18n layer.
  return String(rawName || "").trim() || `Quota Group ${index + 1}`;
}

function windowLabel(windowKey) {
  return windowKey === "5h" ? "5h Window" : "Weekly Window";
}

function slugifyFamilyKey(displayName, index) {
  const cleaned = String(displayName || "")
    .toLowerCase()
    .replace(/\bmodels?\b/g, "")
    .replace(/\band\b/g, " ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || `group_${index + 1}`;
}

function parseBucket(group, bucket, familyName, windowKey, index) {
  const frac = bucketRemainingFraction(bucket);
  if (!Number.isFinite(frac) || frac < 0) return null;
  if (bucket?.disabled === true) return null;

  const remainingFraction = Math.max(0, Math.min(1, frac));
  const resetAt = parseResetTime(bucket?.resetTime);
  const isUnlimited = !resetAt && remainingFraction >= 1;
  const QUOTA_NORMALIZED_BASE = 100; // percent-scale
  const remaining = Math.round(QUOTA_NORMALIZED_BASE * remainingFraction);
  const used = QUOTA_NORMALIZED_BASE - remaining;

  return {
    used: isUnlimited ? 0 : Math.max(0, used),
    total: isUnlimited ? 0 : QUOTA_NORMALIZED_BASE,
    resetAt,
    remainingPercentage: isUnlimited ? 100 : remainingFraction * 100,
    unlimited: isUnlimited,
    fractionReported: true,
    displayName: `${familyName} · ${windowLabel(windowKey)}`,
  };
}

/**
 * Parse the raw retrieveUserQuotaSummary response into per-family, per-window
 * quota entries (5h first, then weekly). Returns a map keyed by a stable slug
 * (e.g. "gemini_5h", "gemini_weekly", "claude_gpt_5h", "claude_gpt_weekly").
 */
export function parseAntigravityQuotaSummary(summaryData) {
  const quotas = {};
  const groups = extractSummaryGroups(summaryData);
  groups.forEach((groupValue, gIdx) => {
    if (!groupValue || typeof groupValue !== "object") return;
    const buckets = Array.isArray(groupValue.buckets) ? groupValue.buckets : [];
    const familyName = familyDisplayName(groupValue.displayName, gIdx);
    const familyKey = slugifyFamilyKey(familyName, gIdx);

    // 5h first, weekly second, anything else last (stable order).
    const rank = (b) => {
      const w = bucketWindow(b);
      if (w === "5h") return 0;
      if (w === "weekly") return 1;
      return 2;
    };
    const seen = new Set();
    const ordered = [...buckets]
      .filter((b) => b && typeof b === "object")
      .sort((a, b) => rank(a) - rank(b));

    for (const [bIdx, bucket] of ordered.entries()) {
      const w = bucketWindow(bucket);
      if (!w) continue; // ignore unknown windows (e.g. image/session-only buckets)
      if (seen.has(w)) continue; // first bucket per window wins
      seen.add(w);
      const quota = parseBucket(groupValue, bucket, familyName, w, bIdx);
      if (quota) quotas[`${familyKey}_${w}`] = quota;
    }
  });
  return quotas;
}

/** @deprecated Kept for callers of the earlier weekly-only parse. Re-export as dual-window. */
export function parseAntigravityWeeklyQuotas(summaryData) {
  return parseAntigravityQuotaSummary(summaryData);
}

/** Fetch + parse in one call — the primary entry point google.js uses. */
export async function fetchAndParseAntigravityQuotaSummary(
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
  return parseAntigravityQuotaSummary(data);
}
