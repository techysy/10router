// CodeBuddy CN built-in "Total Points" (总积分) aggregate row: sums every pack's live balance
// (refills → Cycle fields, bonuses → lifetime Capacity fields) and renders
// before the Monthly row, so users don't have to add packs up themselves.
// The aggregate carries a plain used/total, which makes the "Only with
// balance" filter treat it like any other row (auto-hidden when drained).
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyAwareFetch: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.proxyAwareFetch,
}));

import { getCodeBuddyCnUsage } from "../../open-sse/services/usage/codebuddy-cn.js";
import { parseQuotaData, computeDepletedHiddenKeys } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const DAY = 86400000;
const NOW = Date.now();

function refillFixture(overrides = {}) {
  return {
    PackageName: "CodeBuddy Pro",
    // Cycle window well inside validity → refill pack
    CycleStartTime: NOW - 10 * DAY,
    CycleEndTime: NOW + 20 * DAY,
    DeductionEndTime: NOW + 380 * DAY,
    CycleCapacityUsedPrecise: "6.54",
    CycleCapacitySizePrecise: "500",
    ...overrides,
  };
}

function bonusFixture(overrides = {}) {
  return {
    // Cycle ends exactly at validity → one-shot bonus pack
    CycleStartTime: NOW - 20 * DAY,
    CycleEndTime: NOW + 10 * DAY,
    DeductionEndTime: NOW + 10 * DAY,
    CapacityUsedPrecise: "12",
    CapacitySizePrecise: "100",
    ...overrides,
  };
}

function mockResponse(accounts) {
  mocks.proxyAwareFetch.mockResolvedValue(new Response(JSON.stringify({
    code: 0,
    data: { Response: { Data: { Accounts: accounts } } },
  }), { status: 200, headers: { "content-type": "application/json" } }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("codebuddy-cn usage Total Points aggregate", () => {
  it("sums refill (Cycle) + bonus (Capacity) balances and renders first", async () => {
    mockResponse([bonusFixture(), refillFixture()]);

    const result = await getCodeBuddyCnUsage("token", null, null, null);
    expect(result.message).toBeUndefined();

    const keys = Object.keys(result.quotas);
    expect(keys[0]).toBe("Total Points") // en key; zh dictionaries render 总积分;
    expect(keys).toContain("Monthly");
    expect(keys).toContain("Bonus Pack 1");

    const total = result.quotas["Total Points"];
    expect(total.used).toBe(18.54);
    expect(total.total).toBe(600);
    // Live aggregate: no single cycle → no countdown, no refill semantics
    expect(total.resetAt).toBeNull();
    expect(total.recurring).toBe(false);
  });

  it("rounds away floating-point drift from precise strings", async () => {
    mockResponse([
      bonusFixture({ CapacityUsedPrecise: "0.1" }),
      bonusFixture({ CapacityUsedPrecise: "0.2" }),
    ]);

    const result = await getCodeBuddyCnUsage("token", null, null, null);
    // Raw 0.1 + 0.2 = 0.30000000000000004 — the row must show 0.3
    expect(result.quotas["Total Points"].used).toBe(0.3);
  });

  it("links with the Only-with-balance filter: visible with credit, hidden when drained", async () => {
    mockResponse([refillFixture(), bonusFixture()]);

    const result = await getCodeBuddyCnUsage("token", null, null, null);
    const rows = parseQuotaData("codebuddy-cn", result);
    // The user-facing order: 总积分 first, above the Monthly row
    expect(rows[0].name).toBe("Total Points");
    expect(rows.map((q) => q.name)).toContain("Monthly");
    const totalRow = rows.find((q) => q.name === "Total Points");
    expect(totalRow).toBeDefined();

    // 18.54/600 has balance → stays visible under "Only with balance"
    let hidden = computeDepletedHiddenKeys(rows);
    expect(hidden.has("Total Points")).toBe(false);

    // Drain everything → the aggregate reads 600/600 → auto-hidden
    const drained = parseQuotaData("codebuddy-cn", {
      plan: "CodeBuddy Pro",
      quotas: { "Total Points": { used: 600, total: 600, resetAt: null, recurring: false } },
    });
    hidden = computeDepletedHiddenKeys(drained);
    expect(hidden.has("Total Points")).toBe(true);
  });

  it("keeps the aggregate when a pack reports missing numbers (treated as 0)", async () => {
    mockResponse([refillFixture({ CycleCapacityUsed: undefined, CycleCapacityUsedPrecise: undefined })]);

    const result = await getCodeBuddyCnUsage("token", null, null, null);
    expect(result.quotas["Total Points"].used).toBe(0);
    expect(result.quotas["Total Points"].total).toBe(500);
  });
});
