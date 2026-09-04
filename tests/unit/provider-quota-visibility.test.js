import { describe, expect, it } from "vitest";
import {
  computeDepletedHiddenKeys,
  filterQuotasByVisibility,
  getHiddenQuotaRows,
  parseQuotaData,
} from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

describe("provider quota visibility", () => {
  const data = {
    quotas: {
      "gemini-pro-agent": {
        displayName: "Gemini 3.1 Pro (High)",
        used: 200,
        total: 1000,
        resetAt: "2026-07-04T00:00:00Z",
      },
      "claude-opus-4-6-thinking": {
        displayName: "Claude Opus 4.6 (Thinking)",
        used: 100,
        total: 1000,
        resetAt: "2026-07-04T00:00:00Z",
      },
    },
  };

  it("keeps Antigravity modelKey so hidden settings use stable quota ids", () => {
    const quotas = parseQuotaData("antigravity", data);
    expect(quotas.map((q) => q.modelKey)).toEqual([
      "gemini-pro-agent",
      "claude-opus-4-6-thinking",
    ]);
  });

  it("shows all quotas by default and hides configured provider rows", () => {
    const quotas = parseQuotaData("antigravity", data);
    expect(filterQuotasByVisibility("antigravity", quotas, {})).toHaveLength(2);

    const visibility = {
      antigravity: { hidden: ["claude-opus-4-6-thinking"] },
    };
    const visible = filterQuotasByVisibility("antigravity", quotas, visibility);
    const hidden = getHiddenQuotaRows("antigravity", quotas, visibility);

    expect(visible.map((q) => q.modelKey)).toEqual(["gemini-pro-agent"]);
    expect(hidden.map((q) => q.modelKey)).toEqual(["claude-opus-4-6-thinking"]);
  });

  it("does not apply one provider hidden list to another provider", () => {
    const quotas = parseQuotaData("antigravity", data);
    const visibility = {
      codex: { hidden: ["gemini-pro-agent"] },
    };
    expect(filterQuotasByVisibility("antigravity", quotas, visibility)).toHaveLength(2);
  });

  it("isolates hidden rows per connection (same provider, two accounts)", () => {
    // Two CodeBuddy CN accounts. Hiding "Bonus Pack 1" on connection A must
    // NOT hide it on connection B. scopeKey is the connection id; the legacy
    // provider key only acts as a fallback for pre-existing settings.
    const cbData = {
      quotas: {
        Monthly: { used: 6, total: 500, resetAt: null, recurring: true },
        "Bonus Pack 1": { used: 12, total: 100, resetAt: null, recurring: false },
      },
    };
    const quotas = parseQuotaData("codebuddy-cn", cbData);
    const visibility = {
      "conn-A": { hidden: ["Bonus Pack 1"] },
    };

    // Connection A hides its Bonus Pack 1.
    const visibleA = filterQuotasByVisibility("conn-A", quotas, visibility, "codebuddy-cn");
    expect(visibleA.map((q) => q.name)).toEqual(["Monthly"]);
    // Connection B is unaffected.
    const visibleB = filterQuotasByVisibility("conn-B", quotas, visibility, "codebuddy-cn");
    expect(visibleB.map((q) => q.name)).toEqual(["Monthly", "Bonus Pack 1"]);
  });

  it("falls back to the legacy provider-scoped key when no per-connection entry exists", () => {
    const quotas = parseQuotaData("codebuddy-cn", {
      quotas: {
        "Bonus Pack 1": { used: 5, total: 100, resetAt: null, recurring: false },
        "Bonus Pack 2": { used: 5, total: 100, resetAt: null, recurring: false },
      },
    });
    // Settings saved before the per-connection change are keyed by provider id.
    const visibility = {
      "codebuddy-cn": { hidden: ["Bonus Pack 2"] },
    };
    const visible = filterQuotasByVisibility("conn-A", quotas, visibility, "codebuddy-cn");
    expect(visible.map((q) => q.name)).toEqual(["Bonus Pack 1"]);
    const hidden = getHiddenQuotaRows("conn-A", quotas, visibility, "codebuddy-cn");
    expect(hidden.map((q) => q.name)).toEqual(["Bonus Pack 2"]);
  });
});

describe("computeDepletedHiddenKeys (CodeBuddy CN daily check-in renumbering)", () => {
  // Normalized rows as produced by parseQuotaData for codebuddy-cn.
  const pack = (name, used, total, extra = {}) => ({
    name, used, total, resetAt: "2026-10-05T00:00:00Z", recurring: false, ...extra,
  });

  it("hides only truly depleted rows (used >= total or 0/0)", () => {
    const quotas = [
      pack("Monthly", 500, 500),
      pack("Bonus Pack 1", 100, 100),       // depleted
      pack("Bonus Pack 2", 0, 100),         // FRESH full pack — has balance
      pack("Bonus Pack 3", 0, 9),
      pack("Bonus Pack 4", 49.68, 100),     // partial
    ];
    const hidden = computeDepletedHiddenKeys(quotas);
    expect(hidden.has("Monthly")).toBe(true);
    expect(hidden.has("Bonus Pack 1")).toBe(true);
    expect(hidden.has("Bonus Pack 2")).toBe(false); // fresh 0/100 stays visible
    expect(hidden.has("Bonus Pack 3")).toBe(false);
    expect(hidden.has("Bonus Pack 4")).toBe(false);
  });

  it("keeps a renumbered pack visible after a past hide under the same name", () => {
    // Earlier, "Bonus Pack 2" was depleted and got hidden persistently. The pack
    // then expired and CodeBuddy shifted a NEW full pack (0/100) into that name.
    // Recomputed from the live snapshot, it must NOT be hidden anymore.
    const quotas = [pack("Bonus Pack 2", 0, 100)]; // fresh, full balance now
    const hidden = computeDepletedHiddenKeys(quotas);
    expect(hidden.size).toBe(0);
  });

  it("ignores rows without a visibility key and keeps unlimited rows visible", () => {
    const quotas = [
      { used: 1, total: 1 }, // no name/modelKey
      pack("Unlimited Row", 999, 999, { unlimited: true }),
      pack("Depleted", 100, 100),
    ];
    const hidden = computeDepletedHiddenKeys(quotas);
    expect(hidden.has("Depleted")).toBe(true);
    expect(hidden.has("Unlimited Row")).toBe(false);
    expect(hidden.size).toBe(1);
  });

  it("returns an empty set for empty/non-array input", () => {
    expect(computeDepletedHiddenKeys([]).size).toBe(0);
    expect(computeDepletedHiddenKeys(null).size).toBe(0);
  });
});
