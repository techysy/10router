// Default-disable on first connection: static LLM models start disabled.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";

describe("createProviderConnection — first connection default-disables static LLM models", () => {
  const originalDataDir = process.env.DATA_DIR;
  let tempDir;
  let db;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-default-disable-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    // Real repos need the real localDb — undo the wholesale mock for this import.
    vi.doUnmock("@/lib/localDb");
    db = await import("@/lib/db/index.js");
    await db.initDb();
  });

  afterAll(() => {
    try { if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("first nvidia connection disables the full static LLM list; second connection leaves it alone", async () => {
    const { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS } = await import("open-sse/config/providerModels.js");
    const alias = PROVIDER_ID_TO_ALIAS["nvidia"] || "nvidia";
    const llmIds = (PROVIDER_MODELS[alias] || [])
      .filter((m) => !m.kind || m.kind === "llm")
      .map((m) => m.id);
    expect(llmIds.length).toBeGreaterThan(0);

    await db.createProviderConnection({ provider: "nvidia", authType: "apikey", name: "acc-1", apiKey: "k1" });
    let disabled = await db.getDisabledModels();
    expect((disabled[alias] || []).sort()).toEqual([...llmIds].sort());

    // User enables one model...
    await db.enableModels(alias, [llmIds[0]]);
    // ...then adds a second account — the default must NOT re-apply.
    await db.createProviderConnection({ provider: "nvidia", authType: "apikey", name: "acc-2", apiKey: "k2" });
    disabled = await db.getDisabledModels();
    expect(disabled[alias] || []).not.toContain(llmIds[0]);
  });

  it("respects a pre-existing disabledModels entry (user already touched config)", async () => {
    const { PROVIDER_ID_TO_ALIAS } = await import("open-sse/config/providerModels.js");
    const alias = PROVIDER_ID_TO_ALIAS["groq"] || "groq";
    await db.disableModels(alias, ["only-this-one"]);
    await db.createProviderConnection({ provider: "groq", authType: "apikey", name: "acc-1", apiKey: "k1" });
    const disabled = await db.getDisabledModels();
    expect(disabled[alias]).toEqual(["only-this-one"]);
  });
});
