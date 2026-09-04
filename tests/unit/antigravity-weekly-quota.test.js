/**
 * Antigravity quota-summary parsing (v1internal:retrieveUserQuotaSummary).
 *
 * Mirrors the shape reverse-engineered by third-party Antigravity clients
 * (CodexBar, antigravity-quota-status) and the 10router improvement proposal:
 * model-family groups, each carrying a 5h and a weekly bucket. The parser
 * surfaces 4 rows per account (2 families × {5h, weekly}), normalized to a
 * 0–100 base, tolerant of both response envelopes and of top-level vs nested
 * remainingFraction.
 */

import { describe, it, expect } from "vitest";

import {
  parseAntigravityQuotaSummary,
} from "../../open-sse/services/usage/antigravityWeeklyQuota.js";

// Realistic response: two family groups, each with a 5h and a weekly bucket.
// Uses explicit `window` + bucketId (the shape the proposal documents).
function summaryPayload() {
  return {
    groups: [
      {
        displayName: "Gemini Models",
        buckets: [
          { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.5, resetTime: "2026-09-04T18:00:00Z" },
          { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.8, resetTime: "2026-09-08T00:00:00Z" },
        ],
      },
      {
        displayName: "Claude and GPT models",
        buckets: [
          { bucketId: "3p-5h", window: "5h", remainingFraction: 0.25, resetTime: "2026-09-04T18:00:00Z" },
          { bucketId: "3p-weekly", window: "weekly", remainingFraction: 0.9, resetTime: "2026-09-08T00:00:00Z" },
        ],
      },
    ],
  };
}

describe("parseAntigravityQuotaSummary (dual window)", () => {
  it("extracts 4 rows (2 families × 5h/weekly), percent-based", () => {
    const quotas = parseAntigravityQuotaSummary(summaryPayload());
    expect(Object.keys(quotas).sort()).toEqual([
      "claude_gpt_5h", "claude_gpt_weekly", "gemini_5h", "gemini_weekly",
    ]);
    // percent scale (total 100)
    expect(quotas.gemini_weekly.total).toBe(100);
    expect(quotas.gemini_weekly.remainingPercentage).toBeCloseTo(80);
    expect(quotas.gemini_weekly.used).toBe(20);
    expect(quotas.gemini_5h.total).toBe(100);
    expect(quotas.gemini_5h.remainingPercentage).toBeCloseTo(50);
    expect(quotas.gemini_5h.used).toBe(50);
    // display name carries family + window
    expect(quotas.gemini_5h.displayName).toBe("Gemini Models · 5h Window");
    expect(quotas.gemini_weekly.displayName).toBe("Gemini Models · Weekly Window");
    expect(quotas.claude_gpt_weekly.displayName).toBe("Claude and GPT models · Weekly Window");
  });

  it("parses resetTime into resetAt per window", () => {
    const quotas = parseAntigravityQuotaSummary(summaryPayload());
    expect(quotas.gemini_weekly.resetAt).toBeTruthy();
    expect(new Date(quotas.gemini_weekly.resetAt).getTime()).toBe(Date.parse("2026-09-08T00:00:00Z"));
    expect(quotas.gemini_5h.resetAt).toBeTruthy();
    expect(new Date(quotas.gemini_5h.resetAt).getTime()).toBe(Date.parse("2026-09-04T18:00:00Z"));
  });

  it("accepts the nested quotaSummary.groups envelope", () => {
    const nested = { quotaSummary: { groups: summaryPayload().groups } };
    const quotas = parseAntigravityQuotaSummary(nested);
    expect(Object.keys(quotas).sort()).toEqual([
      "claude_gpt_5h", "claude_gpt_weekly", "gemini_5h", "gemini_weekly",
    ]);
  });

  it("infers the window from bucketId/displayName text when no explicit window field", () => {
    const data = {
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            { bucketId: "gemini-5h", displayName: "5 hour window", remainingFraction: 1 },
            { bucketId: "gemini-weekly", displayName: "Weekly", remainingFraction: 0.6 },
          ],
        },
      ],
    };
    const quotas = parseAntigravityQuotaSummary(data);
    expect(Object.keys(quotas).sort()).toEqual(["gemini_5h", "gemini_weekly"]);
    expect(quotas.gemini_weekly.remainingPercentage).toBeCloseTo(60);
  });

  it("reads remainingFraction nested under remaining.remainingFraction", () => {
    const data = {
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            { bucketId: "gemini-weekly", window: "weekly", remaining: { remainingFraction: 0.75 }, resetTime: "2026-09-08T00:00:00Z" },
          ],
        },
      ],
    };
    const quotas = parseAntigravityQuotaSummary(data);
    expect(quotas.gemini_weekly.remainingPercentage).toBeCloseTo(75);
    expect(quotas.gemini_weekly.used).toBe(25);
  });

  it("returns {} for an unrecognised envelope", () => {
    expect(parseAntigravityQuotaSummary({})).toEqual({});
    expect(parseAntigravityQuotaSummary(null)).toEqual({});
    expect(parseAntigravityQuotaSummary({ groups: "not-an-array" })).toEqual({});
  });

  it("ignores buckets whose window cannot be determined", () => {
    const data = {
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [{ bucketId: "image-only", remainingFraction: 0.5 }],
        },
      ],
    };
    expect(parseAntigravityQuotaSummary(data)).toEqual({});
  });

  it("skips disabled buckets", () => {
    const data = {
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [{ bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.8, disabled: true }],
        },
      ],
    };
    expect(parseAntigravityQuotaSummary(data)).toEqual({});
  });

  it("skips buckets without a reported fraction", () => {
    const data = {
      groups: [
        { displayName: "Gemini Models", buckets: [{ bucketId: "gemini-weekly", window: "weekly" }] },
      ],
    };
    expect(parseAntigravityQuotaSummary(data)).toEqual({});
  });

  it("treats a full fraction with no resetTime as unlimited", () => {
    const data = {
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [{ bucketId: "gemini-5h", window: "5h", remainingFraction: 1 }],
        },
      ],
    };
    const quotas = parseAntigravityQuotaSummary(data);
    expect(quotas.gemini_5h.unlimited).toBe(true);
    expect(quotas.gemini_5h.used).toBe(0);
    expect(quotas.gemini_5h.total).toBe(0);
    expect(quotas.gemini_5h.remainingPercentage).toBe(100);
  });
});
