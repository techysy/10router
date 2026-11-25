// Loomy SMS endpoints rate limiting (review hardening, 1.6.5).
// Sliding-window counter: sends/code attempts are chargeable actions counted
// on every hit regardless of outcome — unlike loginLimiter's failure lockout.
import { describe, it, expect } from "vitest";
import { smsRateLimit } from "../../src/lib/auth/smsRateLimiter.js";

describe("smsRateLimit — sliding window per bucket", () => {
  it("allows up to limit hits inside the window, then refuses with retryAfter", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) {
      expect(smsRateLimit("b1", 3, 60_000, t0 + i).ok).toBe(true);
    }
    const blocked = smsRateLimit("b1", 3, 60_000, t0 + 3);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("frees up as hits age out of the window (true sliding window)", () => {
    const t0 = 2_000_000;
    smsRateLimit("b2", 2, 10_000, t0);
    smsRateLimit("b2", 2, 10_000, t0 + 5_000);
    expect(smsRateLimit("b2", 2, 10_000, t0 + 9_000).ok).toBe(false);
    // both early hits now aged out
    expect(smsRateLimit("b2", 2, 10_000, t0 + 15_001).ok).toBe(true);
  });

  it("buckets are independent (phone vs ip, different phones)", () => {
    const t0 = 3_000_000;
    for (let i = 0; i < 3; i++) smsRateLimit("loomy-send:phone:13100000001", 3, 60_000, t0 + i);
    expect(smsRateLimit("loomy-send:phone:13100000001", 3, 60_000, t0 + 5).ok).toBe(false);
    expect(smsRateLimit("loomy-send:phone:13100000002", 3, 60_000, t0 + 5).ok).toBe(true);
    expect(smsRateLimit("loomy-send:ip:1.2.3.4", 3, 60_000, t0 + 5).ok).toBe(true);
  });

  it("retryAfterSeconds points at the oldest surviving hit", () => {
    const t0 = 4_000_000;
    smsRateLimit("b3", 1, 30_000, t0);
    const blocked = smsRateLimit("b3", 1, 30_000, t0 + 10_000);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(20);
  });
});
