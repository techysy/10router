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
        // Short cycle (5h refill) nearly spent; the one-shot bonus pack is the
        // long-lived window and still has most of its allowance.
        Monthly: { used: 96, total: 100, resetAt: iso(2 * HOUR), recurring: true, giftPack: true, periodMs: 5 * HOUR },
        "Bonus Pack 31": { used: 344.83, total: 3500, resetAt: iso(30 * DAY), recurring: false },
      },
    };
    const r = extractEarliestPackageExpiry(usage);
    expect(r.windowCount).toBe(2);
    // Short window = the monthly refill (30d cycle is the shorter-lived of the
    // two here, since the bonus pack outlives it) → nearly spent → red.
    expect(r.shortRemainingPct).toBeCloseTo(4, 5);
    expect(r.zone).toBe("red");
    // Long window = the 30-day one-shot pack → plenty left overall.
    expect(r.longRemainingPct).toBeCloseTo(90.15, 1);
  });

  it("a healthy short window is green even when the long window is low", () => {
    // Already-drained long allowance, freshly refilled short window: this
    // account can serve, it just has little left overall. Colour follows the
    // short window; longZone records the remaining headroom.
    const usage = {
      quotas: {
        "1 hours": { used: 5, total: 100, resetAt: iso(HOUR), recurring: true },
        Weekly: { used: 98, total: 100, resetAt: iso(6 * DAY), recurring: true, periodMs: 7 * DAY },
      },
    };
    const r = extractEarliestPackageExpiry(usage);
    expect(r.shortRemainingPct).toBeCloseTo(95, 5);
    expect(r.zone).toBe("green");
    expect(r.longRemainingPct).toBeCloseTo(2, 5);
    expect(r.longZone).toBe("red");
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

  it("remainingPercentage stays the legacy alias (smallest across windows)", () => {
    const usage = {
      quotas: {
        Monthly: { used: 30, total: 100, resetAt: iso(20 * DAY), recurring: true },
        "Bonus Pack 1": { used: 90, total: 100, resetAt: iso(5 * DAY), recurring: false },
      },
    };
    const r = extractEarliestPackageExpiry(usage);
    expect(r.remainingPercentage).toBeCloseTo(10, 5);
    // but the colour is driven by the short window, not by the smallest
    expect(r.shortRemainingPct).toBeCloseTo(10, 5);
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
    expect(r.shortRemainingPct).toBeCloseTo(99, 5); // p1 is the shortest-lived
    expect(r.longRemainingPct).toBeCloseTo(1, 5); // p2 has the least left
  });
});
