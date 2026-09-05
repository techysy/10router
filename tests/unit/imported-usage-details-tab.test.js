// Imported usage rows (ZCode plugin / 9r backup) must surface in the details
// tab: getRequestDetails synthesizes entries from meta.imported usageHistory
// rows, live double-writes stay deduped (no imported marker), and the provider
// filter dropdown unions both sources.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-imported-details-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  await db.updateSettings({ enableObservability2: true, observabilityBatchSize: 1 });
});

afterAll(() => {
  // Best-effort: sqlite handles can lag release on Windows, EPERM on rmSync
  // is a cleanup race, not a test failure.
  if (tempDir) { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {} }
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const IMPORTED_ROW = {
  timestamp: "2026-09-01T10:00:00.000Z",
  provider: "zcode-bigmodel-coding-plan",
  model: "GLM-4.6",
  connectionId: null,
  apiKey: null,
  endpoint: "zcode://zcode-agent",
  promptTokens: 1200,
  completionTokens: 340,
  cost: 0,
  status: "ok",
  tokens: { prompt_tokens: 1200, completion_tokens: 340 },
  meta: {},
};

async function importRow(overrides = {}) {
  const { importUsageRows } = await import("@/lib/db/repos/usageRepo.js");
  const { imported } = await importUsageRows([{ ...IMPORTED_ROW, ...overrides }]);
  return imported;
}

describe("imported usage in details tab", () => {
  it("imported row appears in getRequestDetails with imported marker", async () => {
    expect(await importRow()).toBe(1);

    const res = await db.getRequestDetails({ pageSize: 50 });
    const row = res.details.find((d) => d.provider === "zcode-bigmodel-coding-plan");
    expect(row).toBeTruthy();
    expect(row.imported).toBe(true);
    expect(row.model).toBe("GLM-4.6");
    expect(row.tokens.prompt_tokens).toBe(1200);
    expect(row.status).toBe("success");
    expect(row.request.endpoint).toBe("zcode://zcode-agent");
    expect(res.pagination.totalItems).toBeGreaterThanOrEqual(1);
  });

  it("live double-write (usageHistory without marker) is not synthesized", async () => {
    const { saveRequestUsage } = await import("@/lib/db/repos/usageRepo.js");
    await saveRequestUsage({
      provider: "zai-coding-plan",
      model: "GLM-5.3-Flash",
      tokens: { prompt_tokens: 50, completion_tokens: 10 },
      timestamp: "2026-09-02T10:00:00.000Z",
      status: "ok",
    });

    const res = await db.getRequestDetails({ pageSize: 100 });
    const zaiRows = res.details.filter((d) => d.provider === "zai-coding-plan");
    expect(zaiRows).toHaveLength(0);
  });

  it("provider filter narrows to the imported provider", async () => {
    await importRow({ provider: "zcode-zai-start-plan", model: "GLM-5.3-Flash", timestamp: "2026-09-03T10:00:00.000Z" });

    const res = await db.getRequestDetails({ provider: "zcode-zai-start-plan", pageSize: 50 });
    expect(res.details.length).toBeGreaterThanOrEqual(1);
    expect(res.details.every((d) => d.provider === "zcode-zai-start-plan")).toBe(true);
  });

  it("status ok→success mapping; error status maps to error", async () => {
    await importRow({ provider: "zcode-err", timestamp: "2026-09-04T10:00:00.000Z", status: "error" });
    const res = await db.getRequestDetails({ provider: "zcode-err" });
    expect(res.details[0]?.status).toBe("error");
  });

  it("distinct providers union: dropdown includes imported-only provider", async () => {
    const { getDistinctProviders } = await import("@/lib/db/index.js");
    const ids = await getDistinctProviders();
    // requestDetails has no zcode-* row — only usageHistory does.
    expect(ids).not.toContain("zcode-zai-start-plan");
    // The API route unions usageHistory imported providers on top (covered by
    // the SQL used there); here we verify the same query returns it.
    const { getAdapter } = await import("@/lib/db/driver.js");
    const dbAdapter = await getAdapter();
    const unioned = dbAdapter.all(
      `SELECT DISTINCT provider FROM usageHistory WHERE provider IS NOT NULL AND meta LIKE '%"imported":true%'`
    ).map((r) => r.provider);
    expect(unioned).toContain("zcode-zai-start-plan");
    expect(unioned).not.toContain("zai-coding-plan");
  });

  it("import is idempotent — second run of same row is skipped", async () => {
    expect(await importRow()).toBe(0);
  });
});
