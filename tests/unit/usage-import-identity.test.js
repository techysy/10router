// Real SQLite regressions for API-key identity across usage backup/import.
// Each case (and each restore target) gets a genuinely fresh DATA_DIR: deleting
// history alone leaves usageDaily and the lifetime counter behind.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const tempDirs = [];
let tempDir;
let db;
let adapter;
let usage;
let readers;
let hashApiKey;
let maskApiKey;
let fixtureId = 0;

async function openFreshDatabase() {
  adapter?.close();
  adapter = null;
  // driver.js deliberately keeps its singleton on global across module reloads.
  delete global._dbAdapter;
  vi.resetModules();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-usage-import-identity-"));
  tempDirs.push(tempDir);
  process.env.DATA_DIR = tempDir;
  db = await import("@/lib/db/index.js");
  await db.initDb();
  adapter = await (await import("@/lib/db/driver.js")).getAdapter();
  usage = await import("@/lib/db/repos/usageRepo.js");
  readers = await import("@/app/api/settings/database/import-usage/importUsage.js");
  ({ hashApiKey, maskApiKey } = await import("@/lib/db/crypto/apiKeyIdentity.js"));
  expect((await import("@/lib/db/paths.js")).DATA_FILE).toBe(path.join(tempDir, "db", "data.sqlite"));
  expect(counters()).toEqual({ history: 0, daily: 0, lifetime: 0 });
}

beforeEach(openFreshDatabase);

afterEach(() => {
  adapter?.close();
  adapter = null;
  delete global._dbAdapter;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function counters() {
  return {
    history: adapter.get("SELECT COUNT(*) AS n FROM usageHistory").n,
    daily: adapter.all("SELECT data FROM usageDaily").reduce((n, row) => n + JSON.parse(row.data).requests, 0),
    lifetime: Number(adapter.get("SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'")?.value || 0),
  };
}

function entryFor(key) {
  return {
    timestamp: new Date().toISOString(),
    provider: "openai",
    model: "gpt-4o",
    connectionId: "offline-import-connection",
    apiKey: key,
    endpoint: "/v1/chat/completions",
    promptTokens: 10,
    completionTokens: 5,
    tokens: { prompt_tokens: 10, completion_tokens: 5 },
    status: "ok",
  };
}

async function liveRequest() {
  const key = await db.createApiKey("Named import key", "offline-import-machine");
  await usage.saveRequestUsage(entryFor(key.key));
  const row = adapter.get("SELECT * FROM usageHistory");
  expect(row.apiKey).toBe(maskApiKey(key.key));
  expect(row.apiKeyHash).toBe(hashApiKey(key.key));
  expect(counters()).toEqual({ history: 1, daily: 1, lifetime: 1 });
  return { key, row };
}

function currentBackup(format) {
  if (format === "json") return { format, payload: { usageHistory: adapter.all("SELECT * FROM usageHistory ORDER BY id") } };
  const filename = `snapshot-${++fixtureId}.sqlite`;
  const snapshot = path.join(tempDir, filename);
  adapter.run("VACUUM INTO ?", [snapshot]);
  return { format, buffer: fs.readFileSync(snapshot), filename };
}

async function sqliteFixture(rows, { hashColumn = true } = {}) {
  const { DatabaseSync } = await import("node:sqlite");
  const filename = `fixture-${++fixtureId}.sqlite`;
  const file = path.join(tempDir, filename);
  const source = new DatabaseSync(file);
  try {
    source.exec(`CREATE TABLE usageHistory (
      id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, provider TEXT, model TEXT,
      connectionId TEXT, apiKey TEXT, ${hashColumn ? "apiKeyHash TEXT," : ""}
      endpoint TEXT, promptTokens INTEGER, completionTokens INTEGER, cost REAL,
      status TEXT, tokens TEXT, meta TEXT
    )`);
    const columns = ["timestamp", "provider", "model", "connectionId", "apiKey",
      ...(hashColumn ? ["apiKeyHash"] : []), "endpoint", "promptTokens", "completionTokens", "cost", "status", "tokens", "meta"];
    const insert = source.prepare(`INSERT INTO usageHistory (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
    for (const row of rows) {
      insert.run(...columns.map((column) => {
        const value = row[column];
        return (column === "tokens" || column === "meta") && typeof value === "object" && value !== null
          ? JSON.stringify(value)
          : (value ?? null);
      }));
    }
    expect(source.prepare("PRAGMA table_info(usageHistory)").all().some((c) => c.name === "apiKeyHash")).toBe(hashColumn);
  } finally {
    source.close();
  }
  return { format: "sqlite", buffer: fs.readFileSync(file), filename };
}

function readBackup(backup) {
  return backup.format === "json"
    ? readers.readUsageFromJson(backup.payload)
    : readers.readUsageFromSqlite(backup.buffer, backup.filename);
}

function importBackup(backup) {
  return backup.format === "json"
    ? readers.importUsageFromJson(backup.payload)
    : readers.importUsageFromSqlite(backup.buffer, backup.filename);
}

async function expectNamedKey(key, { requests = 1, masked = maskApiKey(key.key) } = {}) {
  const hash = hashApiKey(key.key);
  const bucketKey = `${hash}|gpt-4o|openai`;
  const daily = adapter.all("SELECT data FROM usageDaily").map((row) => JSON.parse(row.data));
  const bucket = daily.flatMap((day) => Object.entries(day.byApiKey)).find(([name]) => name === bucketKey)?.[1];
  expect(bucket).toMatchObject({
    apiKeyHash: hash, apiKeyMasked: masked, requests, promptTokens: 10 * requests, completionTokens: 5 * requests,
  });
  for (const period of ["24h", "all"]) {
    const stats = await usage.getUsageStats(period);
    expect(stats.byApiKey[bucketKey]).toMatchObject({
      keyName: key.name, apiKeyMasked: masked, requests, promptTokens: 10 * requests, completionTokens: 5 * requests,
    });
  }
  const history = adapter.all("SELECT * FROM usageHistory");
  expect(JSON.stringify(history)).not.toContain(key.key);
  expect(JSON.stringify(daily)).not.toContain(key.key);
  expect(await usage.sumApiKeyTokensSince(hash, new Date(0).toISOString())).toBe(15 * requests);
}

describe("current usage backups preserve key identity", () => {
  it.each(["json", "sqlite"])("deduplicates a %s copy of live history without incrementing any counter", async (format) => {
    const { key, row } = await liveRequest();
    const backup = currentBackup(format);
    expect((await readBackup(backup))[0].apiKeyHash).toBe(row.apiKeyHash);
    const before = counters();
    const dailyBefore = adapter.all("SELECT dateKey, data FROM usageDaily");

    expect(await importBackup(backup)).toMatchObject({ imported: 0, skipped: 1, total: 1 });
    expect(counters()).toEqual(before);
    expect(adapter.all("SELECT dateKey, data FROM usageDaily")).toEqual(dailyBefore);
    expect(adapter.get("SELECT apiKeyHash FROM usageHistory").apiKeyHash).toBe(row.apiKeyHash);
    await expectNamedKey(key);
  });

  it.each(["json", "sqlite"])("restores %s history into a fresh database with its named-key association", async (format) => {
    const { key, row } = await liveRequest();
    const config = await db.exportDb();
    const backup = currentBackup(format);

    await openFreshDatabase();
    await db.importDb(config); // Restores the matching named key, no usage counters.
    expect(counters()).toEqual({ history: 0, daily: 0, lifetime: 0 });
    expect(await importBackup(backup)).toMatchObject({ imported: 1, skipped: 0, total: 1 });
    expect(counters()).toEqual({ history: 1, daily: 1, lifetime: 1 });
    expect(adapter.get("SELECT apiKey, apiKeyHash FROM usageHistory")).toMatchObject({ apiKey: row.apiKey, apiKeyHash: row.apiKeyHash });
    await expectNamedKey(key);

    expect(await importBackup(backup)).toMatchObject({ imported: 0, skipped: 1 });
    expect(counters()).toEqual({ history: 1, daily: 1, lifetime: 1 });
  });
});

describe("legacy usage imports", () => {
  it.each(["json", "sqlite"])("derives the original digest from plaintext %s input without a hash field/column", async (format) => {
    const key = await db.createApiKey("Legacy named key", "offline-legacy-machine");
    const entry = entryFor(key.key);
    const backup = format === "json"
      ? { format, payload: { usage: [entry] } }
      : await sqliteFixture([entry], { hashColumn: false });
    expect((await readBackup(backup))[0].apiKeyHash).toBe(hashApiKey(key.key));

    expect(await importBackup(backup)).toMatchObject({ imported: 1, skipped: 0, total: 1 });
    expect(adapter.get("SELECT apiKey, apiKeyHash FROM usageHistory")).toMatchObject({ apiKey: maskApiKey(key.key), apiKeyHash: hashApiKey(key.key) });
    await expectNamedKey(key);

    // The new import and the live writer must agree on the legacy identity.
    await usage.saveRequestUsage({ ...entry });
    expect(await importBackup(backup)).toMatchObject({ imported: 0, skipped: 1 });
    expect(counters()).toEqual({ history: 1, daily: 1, lifetime: 1 });
  });
});

describe("identity validation and grouping", () => {
  it.each(["json", "sqlite"])("normalizes supplied %s digests and keeps two identical masks in separate named buckets", async (format) => {
    const keys = [];
    for (const [name, middle] of [["Named A", "aaaa"], ["Named B", "bbbb"]]) {
      const created = await db.createApiKey(name, "offline-collision-machine");
      keys.push(await db.updateApiKey(created.id, { key: `sk-samep-${middle}-tail` }));
    }
    expect(maskApiKey(keys[0].key)).toBe(maskApiKey(keys[1].key));
    const entry = entryFor(keys[0].key);
    const rows = keys.map((key) => ({ ...entry, apiKey: maskApiKey(key.key), apiKeyHash: hashApiKey(key.key).toUpperCase() }));
    const backup = format === "json" ? { format, payload: { usageHistory: rows } } : await sqliteFixture(rows);
    expect((await readBackup(backup)).map((r) => r.apiKeyHash)).toEqual(keys.map((key) => hashApiKey(key.key)));

    expect(await importBackup(backup)).toMatchObject({ imported: 2, skipped: 0 });
    expect(counters()).toEqual({ history: 2, daily: 2, lifetime: 2 });
    expect(adapter.all("SELECT apiKeyHash FROM usageHistory ORDER BY id").map((r) => r.apiKeyHash)).toEqual(keys.map((key) => hashApiKey(key.key)));
    for (const key of keys) await expectNamedKey(key);
    expect(await importBackup(backup)).toMatchObject({ imported: 0, skipped: 2 });
    expect(counters()).toEqual({ history: 2, daily: 2, lifetime: 2 });
  });

  it.each(["masked", "hash only"])("preserves %s identity for direct repository imports too", async (representation) => {
    const key = await db.createApiKey("Direct named key", "offline-direct-machine");
    const masked = representation === "masked" ? maskApiKey(key.key) : null;
    const entry = { ...entryFor(masked), apiKeyHash: hashApiKey(key.key) };
    expect(await usage.importUsageRows([entry])).toEqual({ imported: 1, skipped: 0 });
    expect(adapter.get("SELECT apiKey, apiKeyHash FROM usageHistory")).toMatchObject({ apiKey: masked, apiKeyHash: hashApiKey(key.key) });
    await expectNamedKey(key, { masked });
    expect(await usage.importUsageRows([entry])).toEqual({ imported: 0, skipped: 1 });
    expect(counters()).toEqual({ history: 1, daily: 1, lifetime: 1 });
  });

  it.each([
    ["malformed digest", /Invalid usage apiKeyHash/],
    ["mismatched plaintext", /does not match/],
    ["mask without digest", /requires apiKeyHash/],
  ])("rejects %s consistently before writing any part of the batch", async (scenario, error) => {
    const key = await db.createApiKey("Validation key", "offline-validation-machine");
    const valid = entryFor(key.key);
    const invalid = { ...valid, timestamp: new Date(Date.now() + 1).toISOString(), apiKey: maskApiKey(key.key) };
    if (scenario === "malformed digest") invalid.apiKeyHash = key.key;
    if (scenario === "mismatched plaintext") {
      invalid.apiKey = key.key;
      invalid.apiKeyHash = hashApiKey("different-plaintext-key");
    }
    const rows = [valid, invalid];
    const payload = { usageHistory: rows };
    expect(() => readers.readUsageFromJson(payload)).toThrow(error);
    await expect(readers.importUsageFromJson(payload)).rejects.toThrow(error);
    const sqlite = await sqliteFixture(rows, { hashColumn: scenario !== "mask without digest" });
    await expect(readBackup(sqlite)).rejects.toThrow(error);
    await expect(importBackup(sqlite)).rejects.toThrow(error);
    await expect(usage.importUsageRows(rows)).rejects.toThrow(error);
    expect(counters()).toEqual({ history: 0, daily: 0, lifetime: 0 });
  });
});
