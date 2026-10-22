import { describe, it, expect } from "vitest";
import { extractQuotaResetInfo, parseQuotaDurationParts, formatQuotaDuration } from "../../src/shared/utils/quotaError.js";

// Two defects surfaced by the Antigravity dashboard row rendering
// "该账号额度已用完，将于 稍后 重置（约一小段时间后）" while the same row's
// countdown chip said 19m and upstream had said "Resets in 31h44m43s.":
//
//   1. the hint's duration parser swallowed the sentence's trailing period,
//      so it rendered placeholders instead of the real clock;
//   2. the lock ceiling for a precise resetsAtMs was 30 minutes even when the
//      clock was a multi-hour quota window.

const GOOGLE_429 = "[429]: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 31h44m43s.";

describe("quota hint — trailing sentence period", () => {
  it("captures the duration WITHOUT the sentence's stop", () => {
    const { delay } = extractQuotaResetInfo(GOOGLE_429);
    expect(delay).toBe("31h44m43s");
  });

  it("the captured duration actually parses (it used to fail → placeholder)", () => {
    expect(parseQuotaDurationParts(extractQuotaResetInfo(GOOGLE_429).delay)).not.toBeNull();
  });

  it("renders a real clock, in days when the wait is measured in days", () => {
    const parts = parseQuotaDurationParts(extractQuotaResetInfo(GOOGLE_429).delay);
    // 31h44m43s → "1d 7h": a single-unit "31小时" hides how much of the day is left
    expect(formatQuotaDuration(parts)).toBe("1d 7h");
  });

  it("the JSON fractional form still parses (must not lose the decimal point)", () => {
    const json = '{"quotaResetDelay":"1h27m36.139434956s"}';
    const { delay } = extractQuotaResetInfo(json);
    expect(delay).toBe("1h27m36.139434956s");
    expect(parseQuotaDurationParts(delay)).not.toBeNull();
    expect(formatQuotaDuration(parseQuotaDurationParts(delay))).toBe("1h 27m 36s");
  });

  it("a bare duration without a stop is unaffected", () => {
    const { delay } = extractQuotaResetInfo("Resets in 5m 30s");
    expect(delay).toBe("5m");
    expect(parseQuotaDurationParts(delay)).not.toBeNull();
  });
});

describe("engine-side quota delay extraction (drives the lock ceiling)", () => {
  it("reads the same sentence form (it already stripped the stop — the hint must too)", async () => {
    const { extractQuotaResetMs } = await import("../../open-sse/services/accountFallback.js");
    const ms = extractQuotaResetMs(GOOGLE_429);
    expect(ms).toBeGreaterThan(30 * 60 * 1000); // hours, not a 30-minute hint
    expect(ms).toBeCloseTo((31 * 3600 + 44 * 60 + 43) * 1000, -3);
  });
});