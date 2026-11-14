import { describe, expect, it } from "vitest";
import {
  computeDepletedHiddenKeys,
  filterQuotasByVisibility,
  getHiddenQuotaRows,
  getQuotaVisibilityKey,
  parseQuotaData,
  trimHiddenQuotaKeys,
} from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";
import { buildQuotas } from "../../open-sse/services/usage/dumate.js";

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
    expect(quotas[1].name).toBe("Claude (Sonnet / Opus / GPT)");
    expect(quotas[0].percentScale).toBe(true);
    expect(quotas[1].percentScale).toBe(true);
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

describe("Dumate pack visibility identity", () => {
  const expires = Math.floor(Date.now() / 1000) + 86400;
  const pack = (overrides = {}) => ({
    packageType: "grant_point", source: "event_bonus", status: "active",
    totalPoints: 100, usedPoints: 0, pointsExpireDate: expires, ...overrides,
  });
  const rowsFor = (packs, kind = "incremental") => parseQuotaData("dumate", {
    quotas: buildQuotas({
      subscription: [], incremental: [], [kind]: packs,
      totalPoints: packs.filter((p) => p.status === "active").reduce((sum, p) => sum + Number(p.totalPoints), 0),
      usedPoints: packs.filter((p) => p.status === "active").reduce((sum, p) => sum + Number(p.usedPoints), 0),
    }, null),
  });

  it.each(["subscription", "incremental"])("does not transfer hidden %s pack A's preference to B after A expires", (kind) => {
    // No invented upstream IDs: exercise the actual documented pack fields.
    const a = pack(kind === "subscription" ? { packageType: "plan_pro", source: undefined } : {});
    const b = { ...a, totalPoints: 200, pointsExpireDate: expires + 86400 };
    const before = rowsFor([a, b], kind);
    const rowA = before.find((row) => row.total === 100);
    const rowB = before.find((row) => row.total === 200);
    const keyA = getQuotaVisibilityKey(rowA);
    const keyB = getQuotaVisibilityKey(rowB);
    expect(keyA).not.toBe(keyB);
    expect(keyA).not.toBe(rowA.name);
    expect(filterQuotasByVisibility("account", before, { account: { hidden: [keyA] } })).not.toContain(rowA);

    for (const packs of [[{ ...a, status: "expired" }, b], [b]]) {
      const after = rowsFor(packs, kind);
      const surviving = after.find((row) => !row.summarizesDetail);
      expect(surviving.name).toBe(rowA.name); // display label was renumbered
      expect(getQuotaVisibilityKey(surviving)).toBe(keyB);
      expect(filterQuotasByVisibility("account", after, { account: { hidden: [keyA] } })).toContain(surviving);
      // Hiding B itself remains effective after the same rename.
      expect(getHiddenQuotaRows("account", after, { account: { hidden: [keyB] } })).toEqual([surviving]);
    }
  });

  it("keeps identity through reorder, spending, inactive siblings and numeric string values", () => {
    const a = pack();
    const b = pack({ totalPoints: 200, pointsExpireDate: expires + 86400 });
    const originalB = rowsFor([a, b]).find((row) => row.total === 200);
    const updatedB = { ...b, totalPoints: "200", usedPoints: 175, pointsExpireDate: String(b.pointsExpireDate), autoRenewStatus: true };
    const keyB = getQuotaVisibilityKey(originalB);
    for (const sibling of [a, { ...a, status: "inactive" }]) {
      const after = rowsFor([updatedB, sibling]);
      expect(after.find((row) => !row.summarizesDetail).modelKey).toBe(keyB);
      expect(getHiddenQuotaRows("account", after, { account: { hidden: [keyB] } })[0]).toMatchObject({ used: 175, total: 200 });
      // Account-scoped keys still isolate another account with the same tuple.
      expect(getHiddenQuotaRows("other", after, { account: { hidden: [keyB] } })).toEqual([]);
    }
  });

  it("distinguishes allowance kind, source, amount and validity without using mutable usage", () => {
    const a = pack({ expireDate: expires + 30 * 86400 });
    const keyOf = (p, kind) => getQuotaVisibilityKey(rowsFor([p], kind).find((row) => !row.summarizesDetail));
    const key = keyOf(a);
    expect(keyOf({ ...a, usedPoints: 99 })).toBe(key);
    for (const p of [
      { ...a, source: "invite_bonus" },
      { ...a, packageType: "plan_point" },
      { ...a, totalPoints: 200 },
      { ...a, pointsExpireDate: expires + 1 },
      { ...a, expireDate: a.expireDate + 1 },
    ]) expect(keyOf(p)).not.toBe(key);
    expect(keyOf(a, "subscription")).not.toBe(key);
  });

  it("keeps permanent top-ups stable when an earlier top-up disappears", () => {
    const a = pack({ packageType: "plan_point", pointsExpireDate: null });
    const b = { ...a, totalPoints: 200 };
    const key = getQuotaVisibilityKey(rowsFor([a, b]).find((row) => row.total === 200));
    expect(rowsFor([b]).find((row) => !row.summarizesDetail).modelKey).toBe(key);
  });

  it("retires ambiguous legacy pack-name hides while retaining the balance-row preference", () => {
    const a = pack();
    const b = pack({ totalPoints: 200 });
    const before = rowsFor([a, b]);
    const hidden = before.map((row) => row.name);
    const after = rowsFor([b]);
    const visibility = { dumate: { hidden } };
    expect(trimHiddenQuotaKeys(hidden, after)).toEqual(["积分余额"]);
    expect(filterQuotasByVisibility("account", after, visibility, "dumate")).toEqual([
      after.find((row) => !row.summarizesDetail),
    ]);
  });

  it("still honors names in legacy snapshots that have no stable key", () => {
    const rows = parseQuotaData("dumate", { quotas: { "积分加油包": { used: 0, total: 100 } } });
    expect(getQuotaVisibilityKey(rows[0])).toBe("积分加油包");
    expect(filterQuotasByVisibility("account", rows, { account: { hidden: ["积分加油包"] } })).toEqual([]);
  });

  it("shares a key for indistinguishable tuples instead of inventing order-based identity", () => {
    const a = pack();
    const b = { ...a, usedPoints: 50 };
    const details = rowsFor([a, b]).filter((row) => !row.summarizesDetail);
    expect(details).toHaveLength(2); // retain both amounts in the breakdown
    expect(details[0].modelKey).toBeTruthy();
    expect(details[0].modelKey).toBe(details[1].modelKey);
    expect(rowsFor([b])[0].modelKey).toBe(details[0].modelKey);
  });

  it.each([
    [" pack-key ", "pack-key"],
    [42, "42"],
    [0, "0"],
    [" ", "Label"],
    [null, "Label"],
    [{ id: "unsupported" }, "Label"],
    [NaN, "Label"],
  ])("normalizes a generic modelKey %j without losing the display name", (modelKey, expected) => {
    const rows = parseQuotaData("dumate", { quotas: { Label: { modelKey, total: 100, used: 0 } } });
    expect(rows[0].name).toBe("Label");
    expect(getQuotaVisibilityKey(rows[0])).toBe(expected);
    expect(filterQuotasByVisibility("account", rows, { account: { hidden: [expected] } })).toEqual([]);
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
      "gemini-3-custom-image": { displayName: "Gemini 3 Custom Image", used: 1, total: 10, remainingPercentage: 90, resetAt: null },
    },
  };

  it("groups gemini/claude rows and keeps image models individual", () => {
    const quotas = parseQuotaData("antigravity", agyData);
    const names = quotas.map((q) => q.modelKey);
    expect(names).toEqual(["gemini", "claude", "gemini-3-custom-image"]);
    // Group representative = most exhausted member of the family
    const gemini = quotas.find((q) => q.modelKey === "gemini");
    expect(gemini.remainingPercentage).toBe(50);
    const claude = quotas.find((q) => q.modelKey === "claude");
    expect(claude.remainingPercentage).toBe(20);
  });

  it("groups gpt-oss models into claude-gpt family and sets percentScale true", () => {
    const dataWithGpt = {
      quotas: {
        "gpt-oss-120b-medium": { displayName: "GPT-OSS 120B (Medium)", used: 0, total: 1000, remainingPercentage: 100 },
        "claude-sonnet-4-6": { displayName: "Claude Sonnet 4.6", used: 100, total: 1000, remainingPercentage: 90 },
        "gemini-3.1-flash-image": { displayName: "Gemini 3.1 Flash Image", used: 0, total: 1000, remainingPercentage: 100 },
      },
    };
    const quotas = parseQuotaData("antigravity", dataWithGpt);
    expect(quotas.map((q) => q.modelKey)).toEqual(["gemini-3.1-flash-image", "claude"]);
    expect(quotas[1].name).toBe("Claude (Sonnet / Opus / GPT)");
    expect(quotas[1].remainingPercentage).toBe(90);
    expect(quotas[0].percentScale).toBe(true);
    expect(quotas[1].percentScale).toBe(true);
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
    expect(visible.map((q) => q.modelKey)).toEqual(["gemini", "claude", "gemini-3-custom-image"]);
    // Hiding the group hides just the group row, not the image model
    const hiddenGroup = filterQuotasByVisibility("connA", quotas, {
      connA: { hidden: ["gemini"] },
    });
    expect(hiddenGroup.map((q) => q.modelKey)).toEqual(["claude", "gemini-3-custom-image"]);
  });
});
