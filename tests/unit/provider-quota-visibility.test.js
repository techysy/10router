import { describe, expect, it } from "vitest";
import {
  computeDepletedHiddenKeys,
  filterQuotasByVisibility,
  getHiddenQuotaRows,
  parseQuotaData,
  trimHiddenQuotaKeys,
} from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

describe("provider quota visibility", () => {
  const data = {
    quotas: {
      "gemini-pro-agent": {
        displayName: "Gemini 3.1 Pro (High)",
        used: 200,
        total: 1000,
        resetAt: "2026-07-04T00:00:00Z",
        remainingPercentage: 80,
      },
      "claude-opus-4-6-thinking": {
        displayName: "Claude Opus 4.6 (Thinking)",
        used: 100,
        total: 1000,
        resetAt: "2026-07-04T00:00:00Z",
        remainingPercentage: 90,
      },
    },
  };

  it("groups Antigravity model quotas into Gemini and Claude families", () => {
    const quotas = parseQuotaData("antigravity", data);
    expect(quotas.map((q) => q.modelKey)).toEqual([
      "gemini",
      "claude",
    ]);
    expect(quotas[0].name).toBe("Gemini (Flash / Pro)");
    expect(quotas[1].name).toBe("Claude (Sonnet / Opus)");
  });

  it("shows all quotas by default and hides configured provider rows", () => {
    const quotas = parseQuotaData("antigravity", data);
    expect(filterQuotasByVisibility("antigravity", quotas, {})).toHaveLength(2);

    const visibility = {
      antigravity: { hidden: ["claude"] },
    };
    const visible = filterQuotasByVisibility("antigravity", quotas, visibility);
    const hidden = getHiddenQuotaRows("antigravity", quotas, visibility);

    expect(visible.map((q) => q.modelKey)).toEqual(["gemini"]);
    expect(hidden.map((q) => q.modelKey)).toEqual(["claude"]);
  });

  it("trims stale or obsolete model keys", () => {
    const quotas = parseQuotaData("antigravity", data);
    const trimmed = trimHiddenQuotaKeys(["claude", "stale-model-xyz", "gemini-3.8-flash-low"], quotas);
    expect(trimmed).toEqual(["claude"]);

    const visibility = {
      antigravity: { hidden: ["claude", "stale-model-xyz"] },
    };
    const visible = filterQuotasByVisibility("antigravity", quotas, visibility);
    const hidden = getHiddenQuotaRows("antigravity", quotas, visibility);

    expect(visible.map((q) => q.modelKey)).toEqual(["gemini"]);
    expect(hidden.map((q) => q.modelKey)).toEqual(["claude"]);
  });

  it("does not apply one provider hidden list to another provider", () => {
    const quotas = parseQuotaData("antigravity", data);
    const visibility = {
      codex: { hidden: ["gemini"] },
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

describe("claude quota rows (Fable tracker)", () => {
  it("sorts claude windows in fixed order and fills remaining from used/total", () => {
    const quotas = parseQuotaData("claude", {
      quotas: {
        "weekly sonnet (7d)": { used: 10, total: 100, resetAt: null },
        "session (5h)": { used: 1, total: 100, resetAt: null },
        "weekly fable (7d)": { used: 25, total: 100, resetAt: null },
        "weekly (7d)": { used: 50, total: 100, resetAt: null },
      },
    });

    expect(quotas.map((q) => q.name)).toEqual([
      "session (5h)",
      "weekly (7d)",
      "weekly fable (7d)",
      "weekly sonnet (7d)",
    ]);
    const fable = quotas.find((q) => q.name === "weekly fable (7d)");
    expect(fable.remaining).toBe(75);
    expect(fable.remainingPercentage).toBe(75);
  });
});

describe("antigravity family grouping (multi-account)", () => {
  const agyData = {
    quotas: {
      "gemini-3-pro": { displayName: "Gemini 3 Pro", used: 10, total: 100, remainingPercentage: 90, resetAt: null },
      "gemini-3-flash": { displayName: "Gemini 3 Flash", used: 50, total: 100, remainingPercentage: 50, resetAt: null },
      "claude-sonnet-5": { displayName: "Claude Sonnet 5", used: 80, total: 100, remainingPercentage: 20, resetAt: null },
      "gemini-3-pro-image": { displayName: "Gemini 3 Pro Image", used: 1, total: 10, remainingPercentage: 90, resetAt: null },
    },
  };

  it("groups gemini/claude rows and keeps image models individual", () => {
    const quotas = parseQuotaData("antigravity", agyData);
    const names = quotas.map((q) => q.modelKey);
    expect(names).toEqual(["gemini", "claude", "gemini-3-pro-image"]);
    // Group representative = most exhausted member of the family
    const gemini = quotas.find((q) => q.modelKey === "gemini");
    expect(gemini.remainingPercentage).toBe(50);
    const claude = quotas.find((q) => q.modelKey === "claude");
    expect(claude.remainingPercentage).toBe(20);
  });

  it("trimHiddenQuotaKeys drops stale keys per connection snapshot only", () => {
    // Connection A is grouped (no individual gemini-* rows), connection B
    // still reports them — trimming A's hidden list must not affect B.
    const hidden = ["gemini", "gemini-3-pro", "claude-sonnet-5"];
    const groupedQuotas = parseQuotaData("antigravity", agyData);
    const trimmedA = trimHiddenQuotaKeys(hidden, groupedQuotas);
    expect(trimmedA).toEqual(["gemini"]);
    // Same stored list against B's individual-row snapshot keeps the model key
    const individualQuotas = [
      { modelKey: "gemini-3-pro", name: "Gemini 3 Pro" },
      { modelKey: "claude-sonnet-5", name: "Claude Sonnet 5" },
    ];
    expect(trimHiddenQuotaKeys(hidden, individualQuotas)).toEqual(["gemini-3-pro", "claude-sonnet-5"]);
  });

  it("filterQuotasByVisibility with a stale hidden list still shows the group row", () => {
    const quotas = parseQuotaData("antigravity", agyData);
    const visibility = {
      connA: { hidden: ["gemini-3-pro", "gemini-3-flash"] }, // stale pre-grouping keys
    };
    const visible = filterQuotasByVisibility("connA", quotas, visibility);
    expect(visible.map((q) => q.modelKey)).toEqual(["gemini", "claude", "gemini-3-pro-image"]);
    // Hiding the group hides just the group row, not the image model
    const hiddenGroup = filterQuotasByVisibility("connA", quotas, {
      connA: { hidden: ["gemini"] },
    });
    expect(hiddenGroup.map((q) => q.modelKey)).toEqual(["claude", "gemini-3-pro-image"]);
  });
});
