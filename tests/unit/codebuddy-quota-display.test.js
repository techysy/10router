import { describe, expect, it } from "vitest";
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

// CodeBuddy credit packs display as remaining/total (counting down) — the
// parse layer tags rows with displayRemaining so the renderers flip the pair.
const PAYLOAD = {
  quotas: {
    "Total Points": { used: 12.5, total: 100, resetAt: "2026-09-30T00:00:00Z" },
    "Bonus Pack 1": { used: 0, total: 50, resetAt: "2026-09-24T00:00:00Z" },
  },
};

describe("parseQuotaData — CodeBuddy displayRemaining", () => {
  it("tags codebuddy-cn rows with displayRemaining", () => {
    const rows = parseQuotaData("codebuddy-cn", PAYLOAD);
    expect(rows.map((r) => r.name)).toEqual(["Total Points", "Bonus Pack 1"]);
    for (const row of rows) {
      expect(row.displayRemaining).toBe(true);
      expect(row.recurring).toBe(true);
    }
    expect(rows[0]).toMatchObject({ used: 12.5, total: 100 });
  });

  it("tags codebuddy-intl rows with displayRemaining", () => {
    const rows = parseQuotaData("codebuddy-intl", PAYLOAD);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.displayRemaining === true)).toBe(true);
  });

  it("leaves other providers untouched", () => {
    const rows = parseQuotaData("github", { quotas: { "core": { used: 3, total: 10 } } });
    expect(rows[0].displayRemaining).toBeUndefined();
  });
});
