import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * sql.js is the last resort of the DB driver chain (bun:sqlite → better-sqlite3
 * → node:sqlite → sql.js) and the fallback for any environment without a native
 * sqlite, so it is exactly where a plain install runs.
 *
 * Its debounced save used to give up on the first failure: `persist()` threw,
 * one console line was printed, `dirty` stayed true but the timer was already
 * cleared and nothing rescheduled. The write that triggered the save had already
 * returned success to its caller, so a batch of writes — including a rotated
 * refresh token, which the request path persists through here — was lost with
 * only a console line to show for it, unless some later mutation happened to
 * trigger another save.
 */
const SAVE_DEBOUNCE_MS = 100;

let dir;
let dbPath;
let adapter;

async function makeAdapter() {
  const { createSqlJsAdapter } = await import("../../src/lib/db/adapters/sqljsAdapter.js");
  return createSqlJsAdapter(dbPath);
}

describe("sql.js persist retries instead of dropping the batch", () => {
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-sqljs-"));
    dbPath = path.join(dir, "data.sqlite");
    adapter = await makeAdapter();
  });

  afterEach(() => {
    try { adapter?.close(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("retries after a failed write and eventually lands the data", async () => {
    adapter.run("CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT)");
    await new Promise((r) => setTimeout(r, SAVE_DEBOUNCE_MS * 3));
    expect(fs.existsSync(dbPath)).toBe(true);

    // Fail the next write twice, then let it through.
    const real = fs.writeFileSync;
    let failuresLeft = 2;
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation((...args) => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error("disk busy");
      }
      return real(...args);
    });

    adapter.run("INSERT INTO t (id, v) VALUES ('a', 'rotated-refresh-token')");

    // Backoff is 200ms then 400ms, so 1.5s is comfortably enough for two
    // retries plus the final successful write.
    await new Promise((r) => setTimeout(r, 1500));
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3); // two failures + the landing write

    // Re-open the file from disk: the row must be there.
    const { createSqlJsAdapter } = await import("../../src/lib/db/adapters/sqljsAdapter.js");
    const reopened = await createSqlJsAdapter(dbPath);
    const row = reopened.get("SELECT v FROM t WHERE id = 'a'");
    expect(row?.v).toBe("rotated-refresh-token");
    reopened.close();
  });

  it("does not spin forever on a permanently failing disk", async () => {
    adapter.run("CREATE TABLE t (id TEXT)");
    await new Promise((r) => setTimeout(r, SAVE_DEBOUNCE_MS * 3));

    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("read-only media");
    });

    adapter.run("INSERT INTO t (id) VALUES ('a')");
    await new Promise((r) => setTimeout(r, 800));
    const attemptsAfter800ms = spy.mock.calls.length;
    // It must still be retrying (not given up) but paced by the backoff cap,
    // not looping flat-out at the 100ms debounce.
    expect(attemptsAfter800ms).toBeGreaterThan(0);
    expect(attemptsAfter800ms).toBeLessThan(12);

    spy.mockRestore();
  });

  it("close() never throws on a failed final write", () => {
    adapter.run("CREATE TABLE t (id TEXT)");
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("read-only media");
    });
    expect(() => adapter.close()).not.toThrow();
  });
});
