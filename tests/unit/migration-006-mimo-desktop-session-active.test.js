// Migration 006 — flip the Desktop card's never-validated session rows from
// "untested" to "active". A mimo-desktop row has no sk- key to test; the
// import succeeding means a live passToken was read, so "untested" is noise.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-mig006-"));
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

async function insert(db, id, provider, data) {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, provider, "oauth", id, null, 1, 1, JSON.stringify(data), now, now],
  );
}

async function boot() {
  const { getAdapter } = await import("@/lib/db/driver.js");
  const db = await getAdapter();
  return db;
}

function readRow(db, id) {
  const row = db.all(`SELECT data FROM providerConnections WHERE id = ?`, [id])[0];
  return JSON.parse(row.data);
}

describe("migration 006: mimo-desktop session rows flip untested → active", () => {
  it("flips untested Desktop rows and leaves everything else alone", async () => {
    const db = await boot();
    await insert(db, "m1", "mimo-desktop", { testStatus: "untested", accessToken: "mimo-desktop-session-u1" });
    await insert(db, "m2", "mimo-desktop", { testStatus: "active", accessToken: "mimo-desktop-session-u2" });
    await insert(db, "m3", "mimo-desktop", { testStatus: "error", accessToken: "mimo-desktop-session-u3" });
    await insert(db, "c1", "xiaomi-mimo", { testStatus: "untested", accessToken: "sk-real-key" });

    // Run the migration directly (fresh DB already at latest would auto-run it;
    // asserting on the raw up() keeps the test decoupled from the stamping).
    const { default: m006 } = await import("@/lib/db/migrations/006-mimo-desktop-session-active.js");
    m006.up(db);

    expect(readRow(db, "m1").testStatus).toBe("active");
    expect(readRow(db, "m2").testStatus).toBe("active"); // non-untested untouched
    expect(readRow(db, "m3").testStatus).toBe("error"); // recorded error preserved
    expect(readRow(db, "c1").testStatus).toBe("untested"); // other providers untouched
  });

  it("is a no-op on an undecodable data blob (fail-open)", async () => {
    const db = await boot();
    db.run(
      `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["bad", "mimo-desktop", "oauth", "bad", null, 1, 1, "not-json{{", new Date().toISOString(), new Date().toISOString()],
    );
    const { default: m006 } = await import("@/lib/db/migrations/006-mimo-desktop-session-active.js");
    expect(() => m006.up(db)).not.toThrow();
    const row = db.all(`SELECT data FROM providerConnections WHERE id = ?`, ["bad"])[0];
    expect(row.data).toBe("not-json{{"); // byte-identical
  });

  it("stays registered after newer migrations", async () => {
    // Newer migrations (007 checkin-runs, …) legitimately become the latest;
    // this test only guarantees 006 itself is never dropped or renumbered.
    const { MIGRATIONS } = await import("@/lib/db/migrations/index.js");
    const m6 = MIGRATIONS.find((m) => m.version === 6);
    expect(m6?.name).toBe("mimo-desktop-session-active");
    expect(MIGRATIONS.at(-1).version).toBeGreaterThanOrEqual(6);
  });
});
