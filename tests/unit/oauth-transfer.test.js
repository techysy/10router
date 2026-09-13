/**
 * Encrypted OAuth credentials transfer (secureTransfer + accountTransfer).
 *
 * secureTransfer: real node:crypto — roundtrip, wrong passphrase, tamper,
 * short passphrase. accountTransfer: real sqlite via temp DATA_DIR —
 * dedup priority (JWT sub → refreshToken → name), create/update split.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";

import { sealTransfer, openTransfer } from "../../src/lib/auth/secureTransfer.js";

describe("secureTransfer envelope", () => {
  const payload = { provider: "gemini", accounts: [{ name: "A", accessToken: "tok-1" }] };

  it("roundtrips with the right passphrase", () => {
    const blob = sealTransfer(payload, "hunter2!");
    expect(blob.format).toBe("10router-oauth-secure-v1");
    expect(blob.cipher).toBe("aes-256-gcm");
    const opened = openTransfer(JSON.parse(JSON.stringify(blob)), "hunter2!");
    expect(opened).toEqual(payload);
  });

  it("rejects a wrong passphrase (GCM auth) and never leaks the payload", () => {
    const blob = sealTransfer(payload, "hunter2!");
    expect(() => openTransfer(blob, "wrong-pass")).toThrow("WRONG_PASSWORD");
    const tampered = { ...blob, payload: blob.payload.slice(0, -4) + "AAAA" };
    expect(() => openTransfer(tampered, "hunter2!")).toThrow();
  });

  it("rejects foreign formats and blobs without the envelope fields", () => {
    expect(() => openTransfer({ format: "something-else" }, "x")).toThrow("UNSUPPORTED_FORMAT");
    expect(() => openTransfer({ format: "10router-oauth-secure-v1" }, "x")).toThrow("CORRUPT");
    expect(() => openTransfer(null, "x")).toThrow("CORRUPT");
  });

  it("refuses short passphrases at seal time", () => {
    expect(() => sealTransfer(payload, "abc")).toThrow("PASSPHRASE_TOO_SHORT");
  });

  it("same payload + passphrase yields different ciphertexts (random salt/iv)", () => {
    const a = sealTransfer(payload, "hunter2!");
    const b = sealTransfer(payload, "hunter2!");
    expect(a.payload).not.toBe(b.payload);
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
  });
});

describe("accountTransfer.importAccounts", () => {
  const originalDataDir = process.env.DATA_DIR;
  let tempDir;
  let mod;

  const tokenFor = (sub) => {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    return `${b64({ alg: "none" })}.${b64({ iss: "https://r/realm", sub })}.sig`;
  };

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-oauth-transfer-"));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    const db = await import("@/lib/db/index.js");
    await db.initDb();
    mod = await import("../../src/lib/oauth/accountTransfer.js");
  });

  afterAll(() => {
    process.env.DATA_DIR = originalDataDir;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch { /* best-effort on Windows */ }
  });

  it("imports new identities as created connections", async () => {
    const res = await mod.importAccounts("gemini", [
      { name: "Main", accessToken: tokenFor("sub-1"), refreshToken: "rt-1" },
      { name: "Second", accessToken: tokenFor("sub-2"), refreshToken: "rt-2" },
    ]);
    expect(res.imported).toBe(2);
    expect(res.failed).toBe(0);
  });

  it("dedups by JWT sub → update in place, not duplicate", async () => {
    const res = await mod.importAccounts("gemini", [
      { name: "Main renamed", accessToken: tokenFor("sub-1"), refreshToken: "rt-1b" },
    ]);
    expect(res.updated).toBe(1);
    expect(res.imported).toBe(0);
  });

  it("falls back to refreshToken identity for opaque tokens", async () => {
    // seed an opaque-token connection via a first import (no JWT)
    await mod.importAccounts("claude", [{ name: "Opaque", accessToken: "opaque-tok", refreshToken: "opaque-rt" }]);
    const res = await mod.importAccounts("claude", [
      { name: "Opaque", accessToken: "opaque-tok-2", refreshToken: "opaque-rt" },
    ]);
    expect(res.updated).toBe(1);
  });

  it("skips items without accessToken", async () => {
    const res = await mod.importAccounts("gemini", [{ name: "no-token" }]);
    expect(res.failed).toBe(1);
  });

  it("buildExportAccounts only exports provider-matching rows with generic fields", async () => {
    const conns = await (async () => {
      const { getProviderConnections } = await import("@/lib/db/index.js").then((m) => ({ getProviderConnections: m.getProviderConnections }));
      return getProviderConnections;
    })();
    const { getProviderConnections: g } = await import("../../src/models/index.js");
    const accounts = mod.buildExportAccounts("gemini", await g("gemini"));
    expect(accounts.length).toBeGreaterThanOrEqual(2);
    for (const a of accounts) {
      expect(a.provider).toBe("gemini");
      expect(Object.keys(a)).toEqual(expect.arrayContaining(["name", "accessToken", "refreshToken", "uid"]));
    }
  });
});
