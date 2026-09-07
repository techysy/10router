/**
 * Antigravity quota-summary host ordering (retrieveUserQuotaSummary).
 *
 * Chat traffic lands on the daily host and the daily/prod environments report
 * different counters, so the summary RPC must be tried daily-first — querying
 * prod alone underreports a daily-active account (the same order the native
 * IDE client and CLIProxyAPI use). A 2xx answer only wins once it carries
 * parseable groups[]; otherwise the next host is tried, and the per-model
 * fetchAvailableModels fallback still covers "no host answers".
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const SUMMARY_GROUP_PAYLOAD = {
  groups: [
    {
      displayName: "Gemini Models",
      buckets: [
        { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.71, resetTime: "2026-09-10T00:00:00Z" },
        { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.95, resetTime: "2026-09-07T18:00:00Z" },
      ],
    },
    {
      displayName: "Claude and GPT models",
      buckets: [
        { bucketId: "3p-weekly", window: "weekly", remainingFraction: 0.34, resetTime: "2026-09-09T12:00:00Z" },
        { bucketId: "3p-5h", window: "5h", remainingFraction: 1, resetTime: "2026-09-07T19:00:00Z" },
      ],
    },
  ],
};

const FALLBACK_MODELS_PAYLOAD = {
  models: {
    "gemini-3.8-flash-low": {
      displayName: "Gemini 3.8 Flash (Low)",
      quotaInfo: { remainingFraction: 0.35, resetTime: "2026-09-08T12:00:00Z" },
    },
  },
};

const DAILY_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
const SANDBOX_URL = "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary";
const PROD_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// Per-test behavior for retrieveUserQuotaSummary by host; each test uses a
// distinct access token so the module-level 60s summary cache never crosses.
const summaryHostBehavior = {
  daily: () => jsonResponse(200, SUMMARY_GROUP_PAYLOAD),
  sandbox: () => jsonResponse(200, SUMMARY_GROUP_PAYLOAD),
  prod: () => jsonResponse(200, SUMMARY_GROUP_PAYLOAD),
};

const proxyAwareFetch = vi.fn(async (url) => {
  if (url.includes(":loadCodeAssist")) {
    return jsonResponse(200, { cloudaicompanionProject: "project-1", currentTier: { name: "Pro" } });
  }
  if (url.includes(":retrieveUserQuotaSummary")) {
    if (url === DAILY_URL) return summaryHostBehavior.daily();
    if (url === SANDBOX_URL) return summaryHostBehavior.sandbox();
    return summaryHostBehavior.prod();
  }
  return jsonResponse(200, FALLBACK_MODELS_PAYLOAD);
});

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));

function summaryCalls() {
  return proxyAwareFetch.mock.calls.map(([url]) => url).filter((url) => url.includes(":retrieveUserQuotaSummary"));
}

describe("Antigravity quota-summary host ordering", () => {
  beforeEach(() => {
    proxyAwareFetch.mockClear();
    summaryHostBehavior.daily = () => jsonResponse(200, SUMMARY_GROUP_PAYLOAD);
    summaryHostBehavior.sandbox = () => jsonResponse(200, SUMMARY_GROUP_PAYLOAD);
    summaryHostBehavior.prod = () => jsonResponse(200, SUMMARY_GROUP_PAYLOAD);
  });

  it("queries the daily host first and stops there when it answers", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");

    const usage = await getAntigravityUsage("token-daily-first-1", {});

    expect(summaryCalls()).toEqual([DAILY_URL]);
    expect(usage.quotas.gemini_weekly).toMatchObject({
      remainingPercentage: 71,
      percentScale: true,
      displayName: "Gemini Models · Weekly Window",
    });
    expect(Object.keys(usage.quotas).sort()).toEqual([
      "claude_gpt_5h", "claude_gpt_weekly", "gemini_5h", "gemini_weekly",
    ]);
  });

  it("falls through the sandbox host to prod when the daily host rejects the call", async () => {
    summaryHostBehavior.daily = () => jsonResponse(403, {});
    summaryHostBehavior.sandbox = () => jsonResponse(404, {});
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");

    const usage = await getAntigravityUsage("token-prod-fallback1", {});

    expect(summaryCalls()).toEqual([DAILY_URL, SANDBOX_URL, PROD_URL]);
    expect(usage.quotas.gemini_weekly).toMatchObject({ remainingPercentage: 71 });
  });

  it("bypasses cache when forceRefresh is requested", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");

    await getAntigravityUsage("token-force-refresh-test", {});
    expect(summaryCalls()).toHaveLength(1);

    // Default call within TTL hits cache (no new network request)
    await getAntigravityUsage("token-force-refresh-test", {});
    expect(summaryCalls()).toHaveLength(1);

    // Call with force: true must bypass cache and issue a new request
    await getAntigravityUsage("token-force-refresh-test", {}, null, { force: true });
    expect(summaryCalls()).toHaveLength(2);
  });

  it("still answers via the per-model fetchAvailableModels fallback when no summary host responds", async () => {
    summaryHostBehavior.daily = () => jsonResponse(500, {});
    summaryHostBehavior.sandbox = () => jsonResponse(500, {});
    summaryHostBehavior.prod = () => jsonResponse(500, {});
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");

    const usage = await getAntigravityUsage("token-all-summary-down", {});

    expect(usage.quotas["gemini-3.8-flash-low"]).toMatchObject({
      used: 650,
      total: 1000,
      remainingPercentage: 35,
    });
  });
});
