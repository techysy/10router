import { describe, expect, it } from "vitest";
import { nextDailyResetMs } from "../../open-sse/utils/dailyReset.js";
import { buildLoomyQuotas } from "../../open-sse/services/usage/loomy.js";
import { parseCodeArtsBenefit } from "../../open-sse/services/usage/codearts.js";
import { extractEarliestPackageExpiry } from "../../open-sse/services/usage/expiryExtractor.js";

const DAY = 24 * 60 * 60 * 1000;

describe("daily reset clock", () => {
  it("returns the next Beijing midnight regardless of the server timezone", () => {
    // 2026-10-20 00:00 UTC = 08:00 Beijing → reset at 16:00 UTC that day.
    expect(new Date(nextDailyResetMs(Date.UTC(2026, 9, 20, 0, 0))).toISOString())
      .toBe("2026-10-20T16:00:00.000Z");
    // 2026-10-20 15:59 UTC = 23:59 Beijing → one minute later.
    expect(new Date(nextDailyResetMs(Date.UTC(2026, 9, 20, 15, 59))).toISOString())
      .toBe("2026-10-20T16:00:00.000Z");
    // 2026-10-20 16:01 UTC = 00:01 Beijing next day → the following midnight.
    expect(new Date(nextDailyResetMs(Date.UTC(2026, 9, 20, 16, 1))).toISOString())
      .toBe("2026-10-21T16:00:00.000Z");
  });
});

describe("Loomy daily gifted pool", () => {
  it("marks a positive daily balance as expiring today for earliest-expiry", () => {
    const now = Date.now();
    const quotas = buildLoomyQuotas(10000, 5000, now);
    const daily = quotas["每日赠送积分 (积分)"];
    expect(daily.recurring).toBe(true);
    expect(Date.parse(daily.resetAt)).toBeGreaterThan(now);
    expect(Date.parse(daily.resetAt)).toBeLessThanOrEqual(now + DAY + 1000);

    const expiry = extractEarliestPackageExpiry({ quotas });
    expect(expiry.name).toBe("每日赠送积分 (积分)");
    expect(expiry.expiry).toBe(daily.resetAt);
  });

  it("does not rank an empty daily pool; the permanent balance has no countdown", () => {
    const quotas = buildLoomyQuotas(10000, 0);
    expect(quotas["每日赠送积分 (积分)"].resetAt).toBeUndefined();
    expect(extractEarliestPackageExpiry({ quotas })).toBe(null);
  });
});

describe("CodeArts daily benefit pool", () => {
  const payload = (used) => ({
    error_code: "0000",
    result: { channel: "IDE", daily_token_limit: 1000, daily_tokens_used: used },
  });

  it("exposes a positive daily benefit as today's earliest expiry", () => {
    const now = Date.now();
    const parsed = parseCodeArtsBenefit(payload(100), now);
    expect(parsed.quota.recurring).toBe(true);
    expect(Date.parse(parsed.quota.resetAt)).toBeGreaterThan(now);

    const expiry = extractEarliestPackageExpiry({ quotas: { "福利 token": parsed.quota } });
    expect(expiry.name).toBe("福利 token");
    expect(expiry.expiry).toBe(parsed.quota.resetAt);
  });

  it("does not rank a drained daily benefit", () => {
    const parsed = parseCodeArtsBenefit(payload(1000));
    expect(parsed.quota.resetAt).toBe(null);
    expect(extractEarliestPackageExpiry({ quotas: { "福利 token": parsed.quota } })).toBe(null);
  });
});
