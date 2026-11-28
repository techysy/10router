// Migration 009 — Croli delisting deactivates its residual connection rows.
//
// The registry entry (and with it the transport config) is gone, so a live
// provider="croli" row would resolve through DefaultExecutor's
// `PROVIDERS[provider] || PROVIDERS.openai` fallback and ship the stored token
// to api.openai.com. The migration flags such rows inactive — data preserved,
// nothing dispatched.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-mig009-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try {
    global._dbAdapter?.instance?.close?.();
  } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function boot() {
  const { getAdapter } = await import("@/lib/db/driver.js");
  return getAdapter();
}

async function migration() {
  const { default: m009 } = await import("@/lib/db/migrations/009-delist-croli-connections.js");
  return m009;
}

function insert(db, id, provider, data, isActive = 1) {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, provider, "oauth", id, null, 1, isActive, JSON.stringify(data), now, now],
  );
}

function readRow(db, id) {
  const row = db.all(`SELECT isActive, data FROM providerConnections WHERE id = ?`, [id])[0];
  return { isActive: row.isActive, data: JSON.parse(row.data) };
}

describe("migration 009: croli rows are deactivated, nothing else moves", () => {
  it("flips an active croli connection to inactive and stamps the reason", async () => {
    const db = await boot();
    insert(db, "croli-1", "croli", { accessToken: "jwt.fixture", refreshToken: "rt.fixture" });
    (await migration()).up(db);

    const row = readRow(db, "croli-1");
    expect(row.isActive).toBe(0);
    expect(row.data.delistReason).toBe("croli_delisted_2026-11-28");
    // Credentials survive untouched — the row is disabled, not destroyed.
    expect(row.data.accessToken).toBe("jwt.fixture");
    expect(row.data.refreshToken).toBe("rt.fixture");
  });

  it("leaves other providers and already-inactive rows alone", async () => {
    const db = await boot();
    insert(db, "other-1", "qwenwork-cn", { accessToken: "keep.me" });
    insert(db, "croli-off", "croli", { accessToken: "already.off" }, 0);
    (await migration()).up(db);

    expect(readRow(db, "other-1").isActive).toBe(1);
    expect(readRow(db, "other-1").data.delistReason).toBeUndefined();
    const off = readRow(db, "croli-off");
    expect(off.isActive).toBe(0);
    expect(off.data.delistReason).toBeUndefined(); // not re-stamped
  });

  it("is idempotent — a second pass changes nothing", async () => {
    const db = await boot();
    insert(db, "croli-2", "croli", { accessToken: "jwt.two" });
    const m009 = await migration();
    m009.up(db);
    const afterFirst = db.all(`SELECT data FROM providerConnections WHERE id = ?`, ["croli-2"])[0].data;
    m009.up(db);
    const afterSecond = db.all(`SELECT data FROM providerConnections WHERE id = ?`, ["croli-2"])[0].data;

    expect(readRow(db, "croli-2").isActive).toBe(0);
    expect(afterSecond).toBe(afterFirst);
  });

  it("is registered in the migration chain (watermark follows new migrations)", async () => {
    const { MIGRATIONS } = await import("@/lib/db/migrations/index.js");
    const m009 = MIGRATIONS.find((m) => m.version === 9);
    expect(m009?.name).toBe("delist-croli-connections");
    expect(MIGRATIONS.at(-1).version).toBe(9);
    // the delisting row never re-activates and runs last
    expect(MIGRATIONS.map((m) => m.version)).toEqual([...MIGRATIONS.map((m) => m.version)].sort((a, b) => a - b));
  });

  it("does not throw on an undecodable data blob (fail-open)", async () => {
    const db = await boot();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["croli-bad", "croli", "oauth", "croli-bad", null, 1, 1, "not-json{{", now, now],
    );

    const m009 = await migration();
    expect(() => m009.up(db)).not.toThrow();
    const row = db.all(`SELECT isActive, data FROM providerConnections WHERE id = ?`, ["croli-bad"])[0];
    expect(row.isActive).toBe(0);          // dispatch stops — that's the point
    expect(row.data).toBe("not-json{{");   // the bytes we couldn't parse survive
  });
});
