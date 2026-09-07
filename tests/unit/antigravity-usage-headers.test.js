import { describe, it, expect, vi, beforeEach } from "vitest";

const proxyAwareFetch = vi.fn(async (url) => ({
  ok: true,
  status: 200,
  json: async () => {
    if (url.includes(":loadCodeAssist")) {
      return { cloudaicompanionProject: "project-1", currentTier: { name: "Pro" } };
    }
    if (url.includes(":retrieveUserQuotaSummary")) {
      return {
        groups: [
          {
            displayName: "Gemini Models",
            buckets: [
              { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.71, resetTime: "2026-09-10T00:00:00Z" },
            ],
          },
        ],
      };
    }
    return { models: {} };
  },
  text: async () => "{}",
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch,
}));

describe("Antigravity usage headers", () => {
  beforeEach(() => proxyAwareFetch.mockClear());

  it("uses the official IDE user agent and omits router-only source headers", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");

    await getAntigravityUsage("access-token", {});

    // loadCodeAssist + retrieveUserQuotaSummary (daily host, first try) —
    // a successful summary returns early, so fetchAvailableModels never runs.
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
    const summaryCall = proxyAwareFetch.mock.calls.find(([url]) => url.includes(":retrieveUserQuotaSummary"));
    expect(summaryCall[0]).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary");
    for (const [, options] of proxyAwareFetch.mock.calls) {
      expect(options.headers["User-Agent"]).toBe("antigravity/ide/2.11.0 darwin/arm64");
      expect(options.headers).not.toHaveProperty("x-request-source");
    }
  });
});
