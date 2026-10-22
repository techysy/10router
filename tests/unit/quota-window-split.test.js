import { describe, it, expect } from "vitest";
import {
  extractEarliestPackageExpiry,
  quotaZone,
  RED_ZONE_PCT,
  YELLOW_ZONE_PCT,
} from "../../open-sse/services/usage/expiryExtractor.js";

// Subscription accounts expose several rolling windows of different lengths.
// They answer different questions and must not be flattened into one number:
//
//   short window (fastest reset) → "can this serve a request NOW?"
//   long window  (slowest reset) → "how much is left of this account?"
//
// Flattening them is how account 1698 burned to 55/3500 while its 9-day
// sibling sat idle: the single "remaining" figure the relay read never fell
// low enough to hand off.

const DAY = 86400_000;
const HOUR = 3600_000;

function iso(ms) {
  return new Date(Date.now() + ms).toISOString();
}

describe("quotaZone thresholds", () => {
  it("red below 5%, yellow below 20%, green above", () => {
    expect(RED_ZONE_PCT).toBe(5);
    expect(YELLOW_ZONE_PCT).toBe(20);
    expect(quotaZone(0)).toBe("red");
    expect(quotaZone(4.9)).toBe("red");
    expect(quotaZone(5)).toBe("yellow");
    expect(quotaZone(19.9)).toBe("yellow");
    expect(quotaZone(20)).toBe("green");
    expect(quotaZone(100)).toBe("green");
  });

  it("unknown data is green — never pre-emptively switch on missing data", () => {
    expect(quotaZone(null)).toBe("green");
    expect(quotaZone(undefined)).toBe("green");
    expect(quotaZone(NaN)).toBe("green");
  });
});

describe("extractEarliestPackageExpiry — window split", () => {
  it("CodeBuddy: short window drains first and drives the zone (1698 scenario)", () => {
    // A monthly refill window nearly spent + a bonus pack with days left.
    // The monthly window is the SHORT one (resets monthly but refills), the
    // bonus pack outlives it → long window.
    const usage = {
      quotas: {
        // Subscription = 5h refill (spent) + monthly refill (plenty left).
        // The one-shot pack is extra quota and takes no part in the windows.
        "5 hours": { used: 96, total: 100, resetAt: iso(2 * HOUR), recurring: true, periodMs: 5 * HOUR },
        Monthly: { used: 20, total: 100, resetAt: iso(20 * DAY), recurring: true, giftPack: true, periodMs: 30 * DAY },
        "Bonus Pack 31": { used: 344.83, total: 3500, resetAt: iso(30 * DAY), recurring: false },
      },
    };
    const r = extractEarliestPackageExpiry(usage);
    expect(r.windowSource).toBe("recurring");
    // Short window = 5h refill, nearly spent → red drives the colour.
    expect(r.shortRemainingPct).toBeCloseTo(4, 5);
    expect(r.shortZone).toBe("red");
    // Long window = monthly refill, plenty of headroom.
    expect(r.longRemainingPct).toBeCloseTo(80, 5);
    expect(r.zone).toBe("red");
  });

  it("a refilled short window over an exhausted long window is still RED", () => {
    // The trap: short=95% looks healthy, long=2% means the account is spent
    // for this cycle. Colouring on the short window alone would paint it green
    // and the relay would keep hammering a dead account.
    const usage = {
      quotas: {
        "1 hours": { used: 5, total: 100, resetAt: iso(HOUR), recurring: true },
        Weekly: { used: 98, total: 100, resetAt: iso(6 * DAY), recurring: true, periodMs: 7 * DAY },
      },
    };
    const r = extractEarliestPackageExpiry(usage);
    expect(r.shortRemainingPct).toBeCloseTo(95, 5);
    expect(r.longRemainingPct).toBeCloseTo(2, 5);
    expect(r.shortZone).toBe("green");
    expect(r.longZone).toBe("red");
    // combined colour = the worse of the two
    expect(r.zone).toBe("red");
  });

  it("yellow short over green long is YELLOW", () => {
    const usage = {
      quotas: {
        "5 hours": { used: 85, total: 100, resetAt: iso(3 * HOUR), recurring: true, periodMs: 5 * HOUR },
        Weekly: { used: 10, total: 100, resetAt: iso(6 * DAY), recurring: true, periodMs: 7 * DAY },
      },
    };
    const r = extractEarliestPackageExpiry(usage);
    expect(r.shortZone).toBe("yellow");
    expect(r.longZone).toBe("green");
    expect(r.zone).toBe("yellow");
  });

  it("a balance (no reset date) never colours the account and never leads the expiry sort", () => {
    const usage = {
      quotas: {
        Credits: { used: 0, total: 0, remaining: 2999.87, resetAt: null },
        "Bonus Pack 1": { used: 10, total: 100, resetAt: iso(5 * DAY), recurring: false },
      },
    };
    const r = extractEarliestPackageExpiry(usage);
    // Only the timed pack counts as a window
    expect(r.windowCount).toBe(1);
    expect(r.shortRemainingPct).toBeCloseTo(90, 5);
    expect(r.longRemainingPct).toBeCloseTo(90, 5);
    // the balance must not become "the soonest expiring package"
    expect(r.name).toBe("Bonus Pack 1");
  });

  it("a balance-only account reports no windows (no countdown, no colour)", () => {
    const usage = { quotas: { Credits: { used: 0, total: 0, remaining: 100, resetAt: null } } };
    // Nothing timed at all → null, i.e. "this account has no subscription
    // windows"; callers treat that as healthy-until-upstream-says-otherwise.
    expect(extractEarliestPackageExpiry(usage)).toBeNull();
  });

  it("a one-shot pack expiring does not make a healthy subscription look spent", () => {
    // CodeBuddy shape: Monthly refill (healthy) + an exhausted Bonus Pack.
    // The pack is EXTRA quota — its expiry says nothing about the
    // subscription, so it must not win the "long window" slot.
    const usage = {
      quotas: {
        Monthly: { used: 20, total: 100, resetAt: iso(20 * DAY), recurring: true, giftPack: true, periodMs: 30 * DAY },
        "5 hours": { used: 10, total: 100, resetAt: iso(4 * HOUR), recurring: true, periodMs: 5 * HOUR },
        "Bonus Pack 31": { used: 3500, total: 3500, resetAt: iso(30 * DAY), recurring: false },
      },
    };
    const r = extractEarliestPackageExpiry(usage);
    expect(r.windowSource).toBe("recurring");
    expect(r.recurringWindowCount).toBe(2);
    // windows come from the subscription only
    expect(r.shortZone).toBe("green");
    expect(r.longZone).toBe("green");
    expect(r.zone).toBe("green");
  });

  it("a pure credit account falls back to its packs as windows", () => {
    const usage = {
      quotas: {
        "Bonus Pack 1": { used: 95, total: 100, resetAt: iso(3 * DAY), recurring: false },
        "Bonus Pack 2": { used: 10, total: 100, resetAt: iso(20 * DAY), recurring: false },
      },
    };
    const r = extractEarliestPackageExpiry(usage);
    expect(r.windowSource).toBe("packs");
    expect(r.recurringWindowCount).toBe(0);
    // Short = the soonest-expiring pack (95% used → 5% left → yellow at the
    // 5% boundary); long = the other pack. Combined = the worse one.
    expect(r.shortZone).toBe("yellow");
    expect(r.longZone).toBe("green");
    expect(r.zone).toBe("yellow");
  });

  it("short/long split by reset PERIOD, not by quota size", () => {
    // Small-but-long-lived vs large-but-short-lived: size must not decide.
    const usage = {
      quotas: {
        "7 days": { used: 0, total: 1000, resetAt: iso(6 * DAY), recurring: true, periodMs: 7 * DAY },
        "5 hours": { used: 0, total: 50, resetAt: iso(4 * HOUR), recurring: true, periodMs: 5 * HOUR },
      },
    };
    const r = extractEarliestPackageExpiry(usage);
    expect(r.shortRemainingPct).toBe(100); // the 5h window, despite its smaller total
    expect(r.longRemainingPct).toBe(100); // the 7d window
  });

  it("remainingPercentage stays the legacy alias (smallest across ALL buckets)", () => {
    const usage = {
      quotas: {
        Monthly: { used: 30, total: 100, resetAt: iso(20 * DAY), recurring: true },
        "Bonus Pack 1": { used: 90, total: 100, resetAt: iso(5 * DAY), recurring: false },
      },
    };
    const r = extractEarliestPackageExpiry(usage);
    // legacy field still reports the smallest of everything (the pack, 10%)
    expect(r.remainingPercentage).toBeCloseTo(10, 5);
    // while the subscription colour reads only the recurring window (70%)
    expect(r.shortRemainingPct).toBeCloseTo(70, 5);
    expect(r.zone).toBe("green");
  });

  it("packs[] itemisation feeds the split from the packs, not the bucket aggregate", () => {
    const usage = {
      quotas: {
        addOn: {
          used: 0, total: 0, resetAt: iso(DAY),
          packs: [
            { name: "p1", used: 1, total: 100, resetAt: iso(3 * DAY), recurring: false },
            { name: "p2", used: 99, total: 100, resetAt: iso(9 * DAY), recurring: false },
          ],
        },
      },
    };
    const r = extractEarliestPackageExpiry(usage);
    expect(r.windowCount).toBe(2);
    expect(r.windowSource).toBe("packs");
    expect(r.shortRemainingPct).toBeCloseTo(99, 5); // p1 is the shortest-lived
    expect(r.longRemainingPct).toBeCloseTo(1, 5); // p2 has the least left
  });

  it("Antigravity: family filter isolates gemini vs claude_gpt pools", () => {
    // Real Antigravity shape: gemini 5h is drained to 0% (red), while claude_gpt
    // is full (100% green). Without family filter, the whole account is red!
    const usage = {
      quotas: {
        gemini_5h: { used: 100, total: 100, resetAt: iso(HOUR), recurring: true, periodMs: 5 * HOUR },
        gemini_weekly: { used: 90, total: 100, resetAt: iso(6 * DAY), recurring: true, periodMs: 7 * DAY },
        claude_gpt_5h: { used: 5, total: 100, resetAt: iso(2 * HOUR), recurring: true, periodMs: 5 * HOUR },
        claude_gpt_weekly: { used: 10, total: 100, resetAt: iso(5 * DAY), recurring: true, periodMs: 7 * DAY },
      },
    };

    // Filter by claude_gpt: sees only the healthy claude buckets → green!
    const claudeResult = extractEarliestPackageExpiry(usage, { family: "claude_gpt" });
    expect(claudeResult.family).toBe("claude_gpt");
    expect(claudeResult.shortRemainingPct).toBe(95);
    expect(claudeResult.longRemainingPct).toBe(90);
    expect(claudeResult.shortZone).toBe("green");
    expect(claudeResult.longZone).toBe("green");
    expect(claudeResult.zone).toBe("green");
    expect(claudeResult.name).toBe("claude_gpt_5h");

    // Filter by gemini: sees the drained gemini bucket → red!
    const geminiResult = extractEarliestPackageExpiry(usage, { family: "gemini" });
    expect(geminiResult.family).toBe("gemini");
    expect(geminiResult.shortRemainingPct).toBe(0);
    expect(geminiResult.zone).toBe("red");
    expect(geminiResult.name).toBe("gemini_5h");
  });
});
