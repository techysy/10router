/**
 * P2: custom-model bulk enable/disable + toggle-merge integrity.
 *
 * Real sqlite via a temp DATA_DIR (same pattern as
 * disabled-models-key-consistency.test.js). Locks:
 * 1. bulk disable/enable flips every row of the provider+type (missing
 *    `enabled` counts as enabled — the historical default);
 * 2. `ids` subset touches only those rows;
 * 3. rows of other providers/types are untouched;
 * 4. toggling enabled must NOT reset `name` or drop capability fields
 *    (the PUT-merge regression this batch fixes);
 * 5. idempotent: re-running the same bulk op updates 0 rows.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";

describe("custom models — bulk enable/disable (P2)", () => {
  const originalDataDir = process.env.DATA_DIR;
  let tempDir;
  let repo;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-custom-bulk-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    db = await import("@/lib/db/index.js");
    repo = await import("@/lib/db/repos/aliasRepo.js");
    await db.initDb?.();
    // seed: 3 custom models for provider A (one enabled:false, one no-field,
    // one enabled:true), 1 for provider B, 1 for provider A type "tts"
    await repo.addCustomModel({ providerAlias: "prov-a", id: "m1", type: "llm", name: "Model One", contextWindow: 128000, enabled: false });
    await repo.addCustomModel({ providerAlias: "prov-a", id: "m2", type: "llm", name: "Model Two" });
    await repo.addCustomModel({ providerAlias: "prov-a", id: "m3", type: "llm", name: "Model Three", enabled: true });
    await repo.addCustomModel({ providerAlias: "prov-b", id: "x1", type: "llm", name: "Other" });
    await repo.addCustomModel({ providerAlias: "prov-a", id: "t1", type: "tts", name: "Voice" });
  });

  let db;
  afterAll(() => {
    process.env.DATA_DIR = originalDataDir;
    // Windows: sqlite handles can outlive the run — EPERM on rmSync is harmless.
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch { /* best-effort cleanup */ }
  });

  it("bulk disable flips every llm row of the provider (missing enabled counts as enabled)", async () => {
    const n = await repo.setCustomModelsEnabled({ providerAlias: "prov-a", type: "llm", enabled: false });
    expect(n).toBe(2); // m1 was seeded disabled — already in target state, skipped
    const all = await repo.getCustomModels();
    const a = Object.fromEntries(all.filter((m) => m.providerAlias === "prov-a" && m.type === "llm").map((m) => [m.id, m]));
    expect(a.m1.enabled).toBe(false);
    expect(a.m2.enabled).toBe(false);
    expect(a.m3.enabled).toBe(false);
    expect(a.m1.contextWindow).toBe(128000); // caps survive
    expect(a.m1.name).toBe("Model One");
    // other provider / other type untouched
    expect(all.find((m) => m.id === "x1").enabled).toBeUndefined();
    expect(all.find((m) => m.id === "t1").enabled).toBeUndefined();
  });

  it("bulk enable flips them back", async () => {
    const n = await repo.setCustomModelsEnabled({ providerAlias: "prov-a", type: "llm", enabled: true });
    expect(n).toBe(3); // m1 was disabled by the previous test — now flipped too
    const all = await repo.getCustomModels();
    expect(all.filter((m) => m.providerAlias === "prov-a" && m.type === "llm").every((m) => m.enabled === true)).toBe(true);
  });

  it("ids subset touches only the listed rows; idempotent rerun updates 0", async () => {
    const n1 = await repo.setCustomModelsEnabled({ providerAlias: "prov-a", type: "llm", enabled: false, ids: ["m2"] });
    expect(n1).toBe(1);
    const n2 = await repo.setCustomModelsEnabled({ providerAlias: "prov-a", type: "llm", enabled: false, ids: ["m2"] });
    expect(n2).toBe(0); // already disabled — idempotent
    const all = await repo.getCustomModels();
    const a = Object.fromEntries(all.filter((m) => m.providerAlias === "prov-a" && m.type === "llm").map((m) => [m.id, m]));
    expect(a.m2.enabled).toBe(false);
    expect(a.m1.enabled).toBe(true);
    expect(a.m3.enabled).toBe(true);
  });

  it("toggle (addCustomModel with only enabled) keeps name and caps — PUT-merge regression", async () => {
    await repo.addCustomModel({ providerAlias: "prov-a", id: "m2", type: "llm", enabled: false });
    const all = await repo.getCustomModels();
    const m2 = all.find((m) => m.providerAlias === "prov-a" && m.id === "m2");
    expect(m2.enabled).toBe(false);
    expect(m2.name).toBe("Model Two"); // was being reset to the id before the fix
    expect(m2.providerAlias).toBe("prov-a");
  });
});
