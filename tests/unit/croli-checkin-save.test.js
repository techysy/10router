import { beforeEach, describe, expect, it, vi } from "vitest";

// saveResults is the only writer of the croliLastClaim settings map. The DB
// layer is mocked wholesale — this suite pins the map-replacement semantics,
// not storage.
vi.mock("@/lib/db/index.js", () => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(async () => ({})),
  getProviderConnections: vi.fn(async () => []),
}));

let written = null;
let currentFixture = null;
vi.mock("@/lib/db/repos/settingsRepo.js", () => ({
  mutateSettingsMap: vi.fn(async (_key, mutator) => {
    written = await mutator(currentFixture);
    return written;
  }),
}));

const { saveResults } = await import("../../src/sse/services/croliCheckin.js");

const CONN_A = { id: "conn-a" };
const CONN_B = { id: "conn-b" };
const ROW_A_OLD = { connectionId: "conn-a", status: "checked-in", at: "2026-11-22T01:00:00.000Z", claimedAmount: 100 };
const ROW_B_OLD = { connectionId: "conn-b", status: "already", at: "2026-11-22T01:05:00.000Z", claimedAmount: 0 };
const ROW_X_GONE = { connectionId: "conn-gone", status: "checked-in", at: "2026-11-21T09:00:00.000Z", claimedAmount: 50 };

describe("croliCheckin saveResults map scoping", () => {
  beforeEach(() => {
    written = null;
    currentFixture = null;
  });

  it("a manual single-connection check-in preserves sibling accounts' rows", async () => {
    // Regression: the mutator used to return only the current tick's rows,
    // wiping conn-b's today-row — the next skipIfCheckedToday tick would
    // re-run its upstream check-in.
    currentFixture = { at: "x", trigger: "scheduled", results: [ROW_A_OLD, ROW_B_OLD] };
    const saved = await saveResults(
      [{ connectionId: "conn-a", status: "checked-in", at: "2026-11-22T10:00:00.000Z", claimedAmount: 300 }],
      [CONN_A], "manual", new Set(["conn-a", "conn-b"]));
    expect(saved).toEqual([
      { connectionId: "conn-a", status: "checked-in", at: "2026-11-22T10:00:00.000Z", claimedAmount: 300 },
    ]);
    expect(written.results).toEqual([
      { connectionId: "conn-a", status: "checked-in", at: "2026-11-22T10:00:00.000Z", claimedAmount: 300 },
      ROW_B_OLD,
    ]);
    expect(written.trigger).toBe("manual");
  });

  it("a full-tick save garbage-collects rows for connections that no longer exist", async () => {
    currentFixture = { at: "x", trigger: "scheduled", results: [ROW_A_OLD, ROW_B_OLD, ROW_X_GONE] };
    await saveResults(
      [{ connectionId: "conn-a", status: "already", at: "2026-11-22T11:00:00.000Z", claimedAmount: 0 },
       { connectionId: "conn-b", status: "checked-in", at: "2026-11-22T11:01:00.000Z", claimedAmount: 200 }],
      [CONN_A, CONN_B]);
    expect(written.results.map((row) => row.connectionId)).toEqual(["conn-a", "conn-b"]);
  });

  it("memoized results do not overwrite the stored row", async () => {
    currentFixture = { at: "x", trigger: "scheduled", results: [ROW_A_OLD] };
    const saved = await saveResults(
      [{ ...ROW_A_OLD, at: "2026-11-22T12:00:00.000Z", memoized: true }],
      [CONN_A]);
    expect(saved).toEqual([ROW_A_OLD]);
    expect(written.results).toEqual([ROW_A_OLD]);
  });
});
