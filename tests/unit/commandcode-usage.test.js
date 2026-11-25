import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getCommandCodeUsage } from "../../open-sse/services/usage/commandcode.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import {
  USAGE_SUPPORTED_PROVIDERS,
  USAGE_APIKEY_PROVIDERS,
} from "../../src/shared/constants/providers.js";
import { parseQuotaData, getRemainingPercentage } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const mockCreditsResponse = {
  credits: {
    belowThreshold: false,
    creditThreshold: 0,
    monthlyCredits: 9.9855356116,
    purchasedCredits: 0,
    freeCredits: 0,
  },
  windowLimits: {
    limited: true,
    exceeded: null,
    fiveHour: {
      used: 0.00246955,
      cap: 3,
      exceeded: false,
      resetAt: 1789319490812,
    },
    weekly: {
      used: 0.00246955,
      cap: 6,
      exceeded: false,
      resetAt: 1789906290812,
    },
  },
};

const mockSubscriptionResponse = {
  success: true,
  data: {
    id: "sub_1U9bTqDSZgxV3MJKSHySjj4u",
    status: "active",
    planId: "individual-go",
    currentPeriodEnd: "2026-09-29T01:53:57.000Z",
  },
};

function jsonResponse(body, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("Command Code Usage Handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is registered in USAGE_SUPPORTED_PROVIDERS and USAGE_APIKEY_PROVIDERS", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("commandcode");
    expect(USAGE_APIKEY_PROVIDERS).toContain("commandcode");
  });

  it("handles missing or empty API key gracefully", async () => {
    const result = await getCommandCodeUsage("");
    expect(result.message).toContain("not configured");
  });

  it("handles 401 unauthorized gracefully", async () => {
    proxyAwareFetch.mockReturnValueOnce(jsonResponse({ error: "Unauthorized" }, 401));

    const result = await getCommandCodeUsage("invalid-key");
    expect(result.message).toContain("invalid or expired");
  });

  it("parses credits and window limits correctly for Go plan", async () => {
    proxyAwareFetch.mockImplementation((url) => {
      const urlStr = String(url);
      if (urlStr.includes("credits")) {
        return jsonResponse(mockCreditsResponse);
      }
      if (urlStr.includes("subscriptions")) {
        return jsonResponse(mockSubscriptionResponse);
      }
      return Promise.reject(new Error("Unknown url"));
    });

    const result = await getCommandCodeUsage("user_testkey123");
    expect(result.plan).toBe("Go");
    expect(result.quotas).toBeDefined();

    // 5-hour rolling limit
    const fiveHour = result.quotas["session (5h)"];
    expect(fiveHour).toBeDefined();
    expect(fiveHour.total).toBe(3);
    expect(fiveHour.used).toBeCloseTo(0.0025, 4);
    expect(fiveHour.remaining).toBeCloseTo(2.9975, 4);
    expect(fiveHour.remainingPercentage).toBe(100);
    expect(fiveHour.recurring).toBe(true);
    expect(fiveHour.resetAt).toBe(new Date(1789319490812).toISOString());

    // Weekly rolling limit
    const weekly = result.quotas["weekly (7d)"];
    expect(weekly).toBeDefined();
    expect(weekly.total).toBe(6);
    expect(weekly.used).toBeCloseTo(0.0025, 4);
    expect(weekly.remaining).toBeCloseTo(5.9975, 4);
    expect(weekly.recurring).toBe(true);
    expect(weekly.resetAt).toBe(new Date(1789906290812).toISOString());

    // Monthly credits
    const monthly = result.quotas["Monthly Credits"];
    expect(monthly).toBeDefined();
    expect(monthly.total).toBe(10);
    expect(monthly.remaining).toBeCloseTo(9.9855, 4);
    expect(monthly.used).toBeCloseTo(0.0145, 4);
    expect(monthly.resetAt).toBe("2026-09-29T01:53:57.000Z");
    expect(monthly.recurring).toBe(true);
  });

  it("dispatches through getUsageForProvider", async () => {
    proxyAwareFetch.mockImplementation((url) => {
      const urlStr = String(url);
      if (urlStr.includes("credits")) return jsonResponse(mockCreditsResponse);
      if (urlStr.includes("subscriptions")) return jsonResponse(mockSubscriptionResponse);
      return Promise.reject(new Error("Unknown url"));
    });

    const result = await getUsageForProvider({
      provider: "commandcode",
      apiKey: "user_test123",
    });

    expect(result.plan).toBe("Go");
    expect(result.quotas["session (5h)"]).toBeDefined();
    expect(proxyAwareFetch.mock.calls[0][1].headers["x-command-code-version"]).toBe("1.88.0");
    expect(proxyAwareFetch.mock.calls[0][1].headers["User-Agent"]).toBe("cli");
  });

  it("surfaces purchased credits if present", async () => {
    const withPurchased = {
      ...mockCreditsResponse,
      credits: {
        ...mockCreditsResponse.credits,
        purchasedCredits: 25.5,
      },
    };
    proxyAwareFetch.mockImplementation((url) => {
      const urlStr = String(url);
      if (urlStr.includes("credits")) return jsonResponse(withPurchased);
      return jsonResponse(mockSubscriptionResponse);
    });

    const result = await getCommandCodeUsage("user_testkey123");
    const purchased = result.quotas["Purchased Credits"];
    expect(purchased).toBeDefined();
    expect(purchased.total).toBe(25.5);
    expect(purchased.remaining).toBe(25.5);
    expect(purchased.recurring).toBe(false);
  });

  it("normalizes and orders quotas in parseQuotaData", () => {
    const usagePayload = {
      plan: "Go",
      quotas: {
        "Purchased Credits": { used: 0, total: 20, remaining: 20, recurring: false },
        "Monthly Credits": { used: 2, total: 10, remaining: 8, recurring: true },
        "weekly (7d)": { used: 1, total: 6, remaining: 5, recurring: true },
        "session (5h)": { used: 0.5, total: 3, remaining: 2.5, recurring: true },
      },
    };

    const normalized = parseQuotaData("commandcode", usagePayload);
    expect(normalized.length).toBe(4);
    expect(normalized.map((q) => q.name)).toEqual([
      "session (5h)",
      "weekly (7d)",
      "Monthly Credits",
      "Purchased Credits",
    ]);
    expect(normalized[0].remaining).toBe(2.5);
    expect(normalized[0].recurring).toBe(true);
    expect(normalized[0].displayRemaining).toBe(true);
  });

  it("calculates remaining percentage correctly when remaining is a dollar amount", () => {
    // When monthly credits remaining is $9.9855 out of $10, remainingPercentage is 100.
    // getRemainingPercentage must NOT treat remaining ($9.9855) as 10%!
    const quota = {
      name: "Monthly Credits",
      used: 0.0145,
      total: 10,
      remaining: 9.9855,
      remainingPercentage: 100,
    };

    expect(getRemainingPercentage(quota)).toBe(100);
  });
});
