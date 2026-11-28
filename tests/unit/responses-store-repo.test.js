// /v1/responses continuation store (issue #184).
//
// The route test (responses-store-continuation.test.js) mocks this repo, so the
// caller-isolation and expiry rules live here against a real SQLite file: one
// caller must not be able to read another caller's conversation by guessing a
// response id, and an expired continuation must behave exactly like a missing one.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

async function loadRepo() {
  const repo = await import("@/lib/db/repos/responsesStoreRepo.js");
  return { ...repo, db: await (await import("@/lib/db/driver.js")).getAdapter() };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-responses-store-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const HISTORY = [
  { type: "message", role: "user", content: [{ type: "input_text", text: "read src/a.ts" }] },
  { type: "function_call", call_id: "call_1", name: "read_file", arguments: '{"path":"src/a.ts"}' },
];

describe("responsesStoreRepo", () => {
  it("round-trips a snapshot for the caller that saved it", async () => {
    const { saveResponseSnapshot, getResponseSnapshot } = await loadRepo();
    const snapshot = { history: HISTORY, tools: [{ type: "function", name: "read_file" }], instructions: "Be terse.", prompt_cache_key: "sess-1" };
    await saveResponseSnapshot("resp_1", "sk-caller-a", snapshot);

    expect(await getResponseSnapshot("resp_1", "sk-caller-a")).toEqual(snapshot);
  });

  it("keeps the same response id separate per caller", async () => {
    const { saveResponseSnapshot, getResponseSnapshot } = await loadRepo();
    await saveResponseSnapshot("resp_shared", "sk-caller-a", { history: [{ type: "message", role: "user", content: "A's private conversation" }] });
    await saveResponseSnapshot("resp_shared", "sk-caller-b", { history: [{ type: "message", role: "user", content: "B's private conversation" }] });

    // Composite primary key: neither row overwrote the other, and neither leaks.
    expect((await getResponseSnapshot("resp_shared", "sk-caller-a")).history[0].content).toBe("A's private conversation");
    expect((await getResponseSnapshot("resp_shared", "sk-caller-b")).history[0].content).toBe("B's private conversation");
  });

  it("returns null for an id that was never stored", async () => {
    const { getResponseSnapshot } = await loadRepo();
    expect(await getResponseSnapshot("resp_missing", "sk-caller-a")).toBeNull();
  });

  it.each([
    ["another API key", "sk-caller-b"],
    ["a caller that sent no API key", null],
  ])("returns null to %s asking for a stored response", async (_label, key) => {
    const { saveResponseSnapshot, getResponseSnapshot } = await loadRepo();
    await saveResponseSnapshot("resp_a", "sk-caller-a", { history: HISTORY });

    expect(await getResponseSnapshot("resp_a", key)).toBeNull();
  });

  it("groups keyless local callers into one bucket, apart from keyed callers", async () => {
    const { saveResponseSnapshot, getResponseSnapshot } = await loadRepo();
    await saveResponseSnapshot("resp_local", null, { history: HISTORY });
    // Loopback / CLI traffic carries no key: those callers are the machine owner.
    expect(await getResponseSnapshot("resp_local", null)).toEqual({ history: HISTORY });
    expect(await getResponseSnapshot("resp_local", "sk-caller-a")).toBeNull();
  });

  it("treats an expired row as missing and sweeps it on the next write", async () => {
    const { saveResponseSnapshot, getResponseSnapshot, db } = await loadRepo();
    await saveResponseSnapshot("resp_old", "sk-caller-a", { history: HISTORY });
    db.run("UPDATE responsesStore SET expiresAt = ? WHERE id = ?", [Date.now() - 1, "resp_old"]);

    expect(await getResponseSnapshot("resp_old", "sk-caller-a")).toBeNull();

    await saveResponseSnapshot("resp_new", "sk-caller-a", { history: HISTORY });
    const ids = db.all("SELECT id FROM responsesStore").map((r) => r.id).sort();
    expect(ids).toEqual(["resp_new"]);
  });

  it("never stores the conversation in plaintext", async () => {
    const { saveResponseSnapshot, db } = await loadRepo();
    await saveResponseSnapshot("resp_1", "sk-caller-a", { history: [{ type: "message", role: "user", content: "SECRET PROJECT ROADMAP" }] });

    const row = db.get("SELECT data FROM responsesStore WHERE id = ?", ["resp_1"]);
    expect(row.data).toMatch(/^enc:v1:/);
    expect(row.data).not.toContain("SECRET PROJECT ROADMAP");
  });

  it("stores only the API key digest, never the key", async () => {
    const { saveResponseSnapshot, db } = await loadRepo();
    await saveResponseSnapshot("resp_1", "sk-caller-a-very-secret-value", { history: HISTORY });

    const row = db.get("SELECT apiKeyHash FROM responsesStore WHERE id = ?", ["resp_1"]);
    expect(row.apiKeyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.apiKeyHash).not.toContain("sk-caller-a");
  });

  it("refuses an oversized snapshot instead of truncating the history a later turn depends on", async () => {
    const { saveResponseSnapshot, getResponseSnapshot, MAX_SNAPSHOT_BYTES } = await loadRepo();
    const huge = "x".repeat(MAX_SNAPSHOT_BYTES + 1);
    await expect(saveResponseSnapshot("resp_big", "sk-caller-a", { history: [{ type: "message", role: "user", content: huge }] }))
      .rejects.toThrow(/exceeds/);
    expect(await getResponseSnapshot("resp_big", "sk-caller-a")).toBeNull();
  });
});
