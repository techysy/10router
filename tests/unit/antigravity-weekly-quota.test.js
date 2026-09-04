/**
 * Antigravity weekly quota summary parsing (v1internal:retrieveUserQuotaSummary).
 *
 * Mirrors the upstream shape reverse-engineered by third-party Antigravity
 * clients (see OmniRoute open-sse/services/usage/antigravityWeeklyQuota.ts):
 * model-family groups, each with 5h + weekly buckets keyed by
 * bucketId/displayName text (no explicit window-type field).
 */

import { describe, it, expect } from "vitest";

import {
  parseAntigravityWeeklyQuotas,
} from "../../open-sse/services/usage/antigravityWeeklyQuota.js";

// A realistic retrieveUserQuotaSummary response: two family groups, each with
// a 5h ("prompt") bucket and a weekly bucket.
function summaryPayload(overrides = {}) {
  return {
    groups: [
      {
        displayName: "Gemini Models",
        buckets: [
          { bucketId: "prompt_5h", displayName: "Prompt window (5h)", remainingFraction: 0.5, resetTime: "2026-09-04T18:00:00Z" },
          { bucketId: "prompt_weekly", displayName: "Weekly Prompt window", remainingFraction: 0.8, resetTime: "2026-09-08T00:00:00Z" },
          ...((overrides.geminiBuckets ?? []).map((b) => ({ bucketId: "extra", displayName: "extra", ...b }))),
        ],
      },
      {
        displayName: "Claude and GPT models",
        buckets: [
          { bucketId: "prompt_5h", displayName: "Prompt window (5h)", remainingFraction: 0.25, resetTime: "2026-09-04T18:00:00Z" },
          { bucketId: "prompt_weekly", displayName: "Weekly Prompt window", remainingFraction: 0.9, resetTime: "2026-09-08T00:00:00Z" },
        ],
      },
    ],
  };
}

describe("parseAntigravityWeeklyQuotas", () => {
  it("extracts one weekly entry per family group", () => {
    const quotas = parseAntigravityWeeklyQuotas(summaryPayload());
    expect(Object.keys(quotas).sort()).toEqual(["claude_gpt_weekly", "gemini_weekly"]);
    expect(quotas.gemini_weekly.remainingPercentage).toBeCloseTo(80);
    expect(quotas.gemini_weekly.used).toBe(200);
    expect(quotas.gemini_weekly.total).toBe(1000);
    expect(quotas.gemini_weekly.displayName).toBe("Gemini Models");
    expect(quotas.claude_gpt_weekly.displayName).toBe("Claude and GPT models");
  });

  it("parses resetTime into resetAt", () => {
    const quotas = parseAntigravityWeeklyQuotas(summaryPayload());
    expect(quotas.gemini_weekly.resetAt).toBeTruthy();
    expect(new Date(quotas.gemini_weekly.resetAt).getTime()).toBe(Date.parse("2026-09-08T00:00:00Z"));
  });

  it("accepts the nested quotaSummary.groups envelope", () => {
    const nested = { quotaSummary: { groups: summaryPayload().groups } };
    const quotas = parseAntigravityWeeklyQuotas(nested);
    expect(Object.keys(quotas).sort()).toEqual(["claude_gpt_weekly", "gemini_weekly"]);
  });

  it("returns {} for an unrecognised envelope", () => {
    expect(parseAntigravityWeeklyQuotas({})).toEqual({});
    expect(parseAntigravityWeeklyQuotas(null)).toEqual({});
    expect(parseAntigravityWeeklyQuotas({ groups: "not-an-array" })).toEqual({});
  });

  it("skips groups without a weekly bucket", () => {
    const data = {
      groups: [
        { displayName: "Gemini Models", buckets: [{ bucketId: "prompt_5h", displayName: "5h", remainingFraction: 0.5 }] },
      ],
    };
    expect(parseAntigravityWeeklyQuotas(data)).toEqual({});
  });

  it("skips disabled weekly buckets", () => {
    const data = {
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [{ bucketId: "prompt_weekly", displayName: "Weekly", remainingFraction: 0.8, disabled: true }],
        },
      ],
    };
    expect(parseAntigravityWeeklyQuotas(data)).toEqual({});
  });

  it("skips weekly buckets without a reported fraction", () => {
    const data = {
      groups: [
        { displayName: "Gemini Models", buckets: [{ bucketId: "prompt_weekly", displayName: "Weekly" }] },
      ],
    };
    expect(parseAntigravityWeeklyQuotas(data)).toEqual({});
  });

  it("treats a full fraction with no resetTime as unlimited", () => {
    const data = {
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [{ bucketId: "prompt_weekly", displayName: "Weekly", remainingFraction: 1 }],
        },
      ],
    };
    const quotas = parseAntigravityWeeklyQuotas(data);
    expect(quotas.gemini_weekly.unlimited).toBe(true);
    expect(quotas.gemini_weekly.used).toBe(0);
    expect(quotas.gemini_weekly.total).toBe(0);
    expect(quotas.gemini_weekly.remainingPercentage).toBe(100);
  });
});
