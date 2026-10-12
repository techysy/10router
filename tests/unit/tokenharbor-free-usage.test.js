import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseTokenHarborHtml, getTokenHarborFreeUsage } from "../../open-sse/services/usage/tokenharbor-free.js";
import { isUsageEligible } from "../../src/shared/utils/usageEligibility.js";

const mocks = vi.hoisted(() => ({
  proxyAwareFetch: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.proxyAwareFetch,
}));

describe("Token Harbor Free Quota & Lifecycle", () => {
  beforeEach(() => {
    mocks.proxyAwareFetch.mockClear();
  });

  describe("parseTokenHarborHtml", () => {
    it("parses valid dashboard HTML with free allowance and reset time", () => {
      const sampleHtml = `
        <html>
          <body>
            <div>Free allowance 25% used of total</div>
            <div>Resets in 3d 12h</div>
            <div>Dashboard</div>
          </body>
        </html>
      `;
      const res = parseTokenHarborHtml(sampleHtml);
      expect(res.quotas).toBeDefined();
      expect(res.quotas.freeAllowance.used).toBe(25);
      expect(res.quotas.freeAllowance.total).toBe(100);
      expect(res.quotas.freeAllowance.remaining).toBe(75);
      expect(res.quotas.freeAllowance.remainingPercentage).toBe(75);
      expect(res.quotas.freeAllowance.displayRemaining).toBe(true);
      expect(res.quotas.freeAllowance.recurring).toBe(true);
      expect(res.quotas.freeAllowance.resetAt).toBeDefined();
      expect(new Date(res.quotas.freeAllowance.resetAt).getTime()).toBeGreaterThan(Date.now());
    });

    it("detects unauthenticated or redirected login pages", () => {
      const loginHtml = `
        <html>
          <body>
            <a href="/api/auth/signin">Sign in with Google</a>
          </body>
        </html>
      `;
      const res = parseTokenHarborHtml(loginHtml);
      expect(res.error).toMatch(/expired or invalid/i);
    });

    it("handles authenticated user without free allowance gracefully", () => {
      const emptyHtml = `
        <html>
          <body>
            <div>Welcome back user!</div>
            <a href="/api/auth/signout">Sign out</a>
          </body>
        </html>
      `;
      const res = parseTokenHarborHtml(emptyHtml);
      expect(res.message).toMatch(/No free allowance found/i);
    });
  });

  describe("getTokenHarborFreeUsage", () => {
    it("prefers creditDaddyWebSession.cookie over apiKey", async () => {
      mocks.proxyAwareFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => "<div>Free allowance 40% of total</div><div>Dashboard</div>",
      });

      const res = await getTokenHarborFreeUsage("key-cookie", null, {
        creditDaddyWebSession: { cookie: "cd-session-cookie" },
      });

      expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mocks.proxyAwareFetch.mock.calls[0];
      expect(url).toBe("https://tokenharbor.ai/dashboard");
      expect(opts.headers.Cookie).toBe("cd-session-cookie");
      expect(res.quotas.freeAllowance.used).toBe(40);
    });

    it("falls back to apiKey when creditDaddyWebSession is absent", async () => {
      mocks.proxyAwareFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => "<div>Free allowance 10% used</div><div>Dashboard</div>",
      });

      const res = await getTokenHarborFreeUsage("raw-cookie-string", null, null);

      expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mocks.proxyAwareFetch.mock.calls[0];
      expect(opts.headers.Cookie).toBe("raw-cookie-string");
      expect(res.quotas.freeAllowance.used).toBe(10);
    });

    it("returns message on 401/403 without throwing", async () => {
      mocks.proxyAwareFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
      });

      const res = await getTokenHarborFreeUsage("bad-cookie");
      expect(res.message).toMatch(/invalid or expired/i);
    });
  });

  describe("isUsageEligible", () => {
    it("recognizes tokenharbor-free with authType cookie as eligible", () => {
      expect(isUsageEligible({ provider: "tokenharbor-free", authType: "cookie" })).toBe(true);
      expect(isUsageEligible({ provider: "tokenharbor-free", authType: "apikey" })).toBe(false);
    });
  });
});
