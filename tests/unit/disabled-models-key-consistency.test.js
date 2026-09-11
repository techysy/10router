// Disabled-model rows are keyed by provider, and a provider answers to several
// names (id / registry alias / uiAlias / aliases[]). Two code paths disagreed about
// which name to store under, leaving one provider with two rows and making a toggle
// written under one name invisible to a reader using the other. These cases pin the
// single storage name, the merged read, and the collapse-on-write behaviour.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";

describe("disabled models — one canonical key per provider", () => {
  const originalDataDir = process.env.DATA_DIR;
  let tempDir;
  let db;
  let repo;
  let getAdapter;
  let REGISTRY;

  // A provider whose UI name differs from its registry id — the shape that broke.
  const MIXED = "xiaomi-mimo";

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-disabled-key-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    vi.doUnmock("@/lib/localDb");
    db = await import("@/lib/db/index.js");
    repo = await import("@/lib/db/repos/disabledModelsRepo.js");
    ({ getAdapter } = await import("@/lib/db/driver.js"));
    REGISTRY = (await import("open-sse/providers/registry/index.js")).default;
    await db.initDb();
  });

  afterAll(() => {
    try { if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  /** The provider page and the API both resolve keys through this rule. */
  const storageName = (id) => {
    const entry = REGISTRY.find((r) => r.id === id);
    return entry ? entry.uiAlias || entry.alias || entry.id : id;
  };

  it("stores under the same name the dashboard reads with", async () => {
    const entry = REGISTRY.find((r) => r.id === MIXED);
    expect(entry).toBeTruthy();
    // The registry must actually have the divergence, or this file proves nothing.
    expect(entry.uiAlias).toBeTruthy();
    expect(entry.uiAlias).not.toBe(entry.id);

    await repo.disableModels(MIXED, ["a-1"]);
    const all = await repo.getDisabledModels();
    expect(all[storageName(MIXED)]).toContain("a-1");
    await repo.enableModels(MIXED, []);
  });

  it("resolves a lookup through any name the provider goes by", async () => {
    await repo.disableModels(MIXED, ["a-1", "a-2"]);
    const all = await repo.getDisabledModels();
    // Every published name (id, uiAlias, aliases[]) answers with the same list.
    expect(all[MIXED]).toEqual(all[storageName(MIXED)]);
    expect(all["mimo-desktop"]).toEqual(all[storageName(MIXED)]);
    expect(await repo.getDisabledByProvider(MIXED)).toEqual(
      await repo.getDisabledByProvider(storageName(MIXED)),
    );
    await repo.enableModels(MIXED, []);
  });

  it("prefers the storage-name row when a legacy duplicate exists", async () => {
    // The user's latest intent lives in the row the dashboard edits; a stale row
    // under another name must not undo it (that is how an enabled model silently
    // flipped back to disabled).
    await repo.disableModels(MIXED, ["kept-1"]);
    const kv = await getAdapter();
    kv.run(
      `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
      ["disabledModels", MIXED, JSON.stringify(["stale-2"])],
    );

    expect(await repo.getDisabledByProvider(storageName(MIXED))).toEqual(["kept-1"]);
    // ...whichever name it is asked under.
    expect(await repo.getDisabledByProvider(MIXED)).toEqual(["kept-1"]);

    // A write collapses everything onto the storage name.
    await repo.enableModels(storageName(MIXED), ["kept-1"]);
    const rows = kv.all(`SELECT key FROM kv WHERE scope = ?`, ["disabledModels"]).map((r) => r.key);
    expect(rows.filter((k) => k === MIXED || k === storageName(MIXED))).toEqual([]);
    // Enabling really took effect: no surplus row can re-add it.
    expect(await repo.getDisabledByProvider(MIXED)).toEqual([]);
  });

  it("keeps a legacy row readable when there is no storage-name row yet", async () => {
    // Pre-fix installs stored rows under the id only. Upgrading must not lose them.
    const kv = await getAdapter();
    kv.run(
      `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
      ["disabledModels", MIXED, JSON.stringify(["legacy-1", "legacy-2"])],
    );
    expect((await repo.getDisabledByProvider(storageName(MIXED))).sort()).toEqual(["legacy-1", "legacy-2"]);
    expect((await repo.getDisabledByProvider(MIXED)).sort()).toEqual(["legacy-1", "legacy-2"]);

    // A later write migrates it onto the storage name.
    await repo.disableModels(storageName(MIXED), ["new-1"]);
    const rows = kv.all(`SELECT key, value FROM kv WHERE scope = ?`, ["disabledModels"]).map((r) => r.key);
    expect(rows).toEqual([storageName(MIXED)]);
    expect((await repo.getDisabledByProvider(MIXED)).sort()).toEqual(["legacy-1", "legacy-2", "new-1"]);
    await repo.enableModels(MIXED, []);
  });

  it("keeps an unknown provider key as-is (custom / compatible providers)", async () => {
    await repo.disableModels("my-custom-node", ["x-1"]);
    const all = await repo.getDisabledModels();
    expect(all["my-custom-node"]).toEqual(["x-1"]);
    await repo.enableModels("my-custom-node", []);
    expect((await repo.getDisabledModels())["my-custom-node"]).toBeUndefined();
  });

  it("enable-all clears every row the provider has, under any name", async () => {
    await repo.disableModels(MIXED, ["a-1"]);
    const kv = await getAdapter();
    kv.run(
      `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
      ["disabledModels", MIXED, JSON.stringify(["a-9"])],
    );
    await repo.enableModels(storageName(MIXED), []);
    const rows = kv.all(`SELECT key FROM kv WHERE scope = ?`, ["disabledModels"]).map((r) => r.key);
    expect(rows).not.toContain(MIXED);
    expect(rows).not.toContain(storageName(MIXED));
  });
});
