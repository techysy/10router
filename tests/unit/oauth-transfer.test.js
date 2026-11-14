/**
 * Encrypted OAuth credentials transfer (secureTransfer + accountTransfer).
 *
 * secureTransfer: real node:crypto — roundtrip, wrong passphrase, tamper,
 * short passphrase. accountTransfer: real sqlite via temp DATA_DIR —
 * dedup priority (JWT sub → refreshToken → name), create/update split.
 */
import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";

import { sealTransfer, openTransfer } from "../../src/lib/auth/secureTransfer.js";

// Issue #44: importAccounts probes synced Qoder web sessions through
// proxyAwareFetch. Mock it file-wide (no other suite in this file hits the
// network) so the probe tests run against a canned console endpoint. The
// factory defers the read to call time — resetModules reloads in beforeAll.
const webFetch = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => webFetch(...args),
}));

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

  it("carries providerSpecificData across machines (Desktop card keeps its session)", async () => {
    // On `mimo-desktop` the account session IS the credential, so a transfer must
    // carry it or the target machine has nothing to route with. Seed the row the
    // way the Desktop-card session-only import does.
    await mod.importAccounts("mimo-desktop", [
      {
        name: "Desktop Session",
        accessToken: "mimo-desktop-session-6786673",
        providerSpecificData: {
          mimoPassToken: "PT-abc123",
          mimoUserId: "6786673",
          authMethod: "desktop-session",
        },
      },
    ]);
    const { getProviderConnections } = await import("../../src/models/index.js");
    const conns = await getProviderConnections({ provider: "mimo-desktop" });
    const seeded = conns.find((c) => c.accessToken === "mimo-desktop-session-6786673");
    expect(seeded?.providerSpecificData?.mimoPassToken).toBe("PT-abc123");

    // Export → the passToken must be in the payload (cross-machine transfer).
    const exported = mod.buildExportAccounts("mimo-desktop", conns);
    const row = exported.find((a) => a.accessToken === "mimo-desktop-session-6786673");
    expect(row?.providerSpecificData?.mimoPassToken).toBe("PT-abc123");

    // Re-import on another machine (fresh provider) → session preserved.
    const res = await mod.importAccounts("mimo-desktop-copy", [
      { ...row, provider: "mimo-desktop-copy" },
    ]);
    expect(res.imported).toBe(1);
    const copyConns = await getProviderConnections({ provider: "mimo-desktop-copy" });
    expect(copyConns[0]?.providerSpecificData?.mimoPassToken).toBe("PT-abc123");
  });

  it("refuses to re-contaminate the cloud card from an old transfer file", async () => {
    // A file exported before migration 005 can still carry a Desktop session
    // folded into its xiaomi-mimo row. Importing it must not put that session
    // back on the cloud card — that is what made it advertise a weekly Desktop
    // quota it does not own.
    const res = await mod.importAccounts("xiaomi-mimo", [
      {
        name: "Legacy",
        accessToken: "sk-cloud-key",
        providerSpecificData: {
          mimoPassToken: "PT-stale",
          mimoUserId: "6786673",
          mimoCUserId: "C-stale",
          authMethod: "desktop-session",
          baseUrl: "https://api.xiaomimimo.com/v1/chat/completions",
        },
      },
    ]);
    expect(res.imported).toBe(1);
    const { getProviderConnections } = await import("../../src/models/index.js");
    const [conn] = await getProviderConnections({ provider: "xiaomi-mimo" });
    expect(conn.providerSpecificData.mimoPassToken).toBeUndefined();
    expect(conn.providerSpecificData.mimoUserId).toBeUndefined();
    expect(conn.providerSpecificData.mimoCUserId).toBeUndefined();
    expect(conn.providerSpecificData.authMethod).toBeUndefined();
    // …while unrelated fields the cloud card does own survive.
    expect(conn.providerSpecificData.baseUrl).toBe("https://api.xiaomimimo.com/v1/chat/completions");
  });

  it("re-import merges providerSpecificData instead of wiping omitted fields", async () => {
    // First import carries both fields; second carries only one → merge keeps both.
    await mod.importAccounts("gemini", [
      { name: "M", accessToken: tokenFor("sub-merge"), providerSpecificData: { a: 1, b: 2 } },
    ]);
    await mod.importAccounts("gemini", [
      { name: "M", accessToken: tokenFor("sub-merge"), providerSpecificData: { b: 99 } },
    ]);
    const { getProviderConnections } = await import("../../src/models/index.js");
    const conns = await getProviderConnections({ provider: "gemini" });
    const row = conns.find((c) => c.name === "M");
    expect(row?.providerSpecificData?.a).toBe(1);
    expect(row?.providerSpecificData?.b).toBe(99);
  });

  it("skips items without accessToken", async () => {
    const res = await mod.importAccounts("gemini", [{ name: "no-token" }]);
    expect(res.failed).toBe(1);
  });

  it("buildExportAccounts exports provider-matching rows with generic fields + providerSpecificData", async () => {
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

describe("Xiaomi MiMo modal — session-only detection wiring", () => {
  it("routes any `found` response to the found phase (not just apiKey ones)", () => {
    const modal = readFileSync(
      new URL("../../src/shared/components/XiaomiMimoAuthModal.js", import.meta.url),
      "utf8",
    );
    // Both detect paths must branch on `data.found` alone — session-only
    // responses carry no apiKey and used to fall into the not-found branch.
    expect(modal).not.toMatch(/data\.found\s*&&\s*data\.apiKey/);
    const foundChecks = modal.match(/if \(data\.found\)/g) || [];
    expect(foundChecks.length).toBeGreaterThanOrEqual(2);
    // Session-only rendering + import wiring must stay present.
    expect(modal).toContain("detectResult.sessionOnly");
    expect(modal).toContain("Connect with Desktop Session");
  });
});

describe("export route — dashboard password header contract", () => {
  const originalDataDir = process.env.DATA_DIR;
  const originalInitial = process.env.INITIAL_PASSWORD;
  let tempDir;
  let route;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-xfer-route-"));
    process.env.DATA_DIR = tempDir;
    process.env.INITIAL_PASSWORD = "dash-pw-test";
    vi.resetModules();
    const db = await import("@/lib/db/index.js");
    await db.initDb();
    await db.createProviderConnection({
      provider: "gemini",
      authType: "oauth",
      email: "seeded@example.com",
      accessToken: "tok-live",
      refreshToken: "rt-live",
    });
    route = await import("@/app/api/oauth/transfer/export/route.js");
  });

  afterAll(() => {
    process.env.DATA_DIR = originalDataDir;
    if (originalInitial === undefined) delete process.env.INITIAL_PASSWORD;
    else process.env.INITIAL_PASSWORD = originalInitial;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch { /* best-effort on Windows */ }
  });

  const post = (headers, body) =>
    route.POST(new Request("http://localhost/api/oauth/transfer/export", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }));

  it("rejects an export without the x-10r-password header (401)", async () => {
    const res = await post({}, { provider: "gemini", passphrase: "abcd-1234" });
    expect(res.status).toBe(401);
  });

  it("rejects a wrong dashboard password", async () => {
    const res = await post({ "x-10r-password": "nope" }, { provider: "gemini", passphrase: "abcd-1234" });
    expect(res.status).toBe(401);
  });

  it("still accepts the legacy x-9r-password header (pre-rename clients)", async () => {
    const res = await post({ "x-9r-password": "dash-pw-test" }, { provider: "gemini", passphrase: "abcd-1234" });
    expect(res.status).toBe(200);
  });

  it("with the right dashboard password: seals a blob the passphrase reopens", async () => {
    const res = await post({ "x-10r-password": "dash-pw-test" }, { provider: "gemini", passphrase: "abcd-1234" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.count).toBeGreaterThanOrEqual(1);
    const opened = openTransfer(JSON.parse(JSON.stringify(data.blob)), "abcd-1234");
    expect(opened.accounts.some((a) => a.accessToken === "tok-live")).toBe(true);
  });
});

describe("export wiring — provider page must hand the verified password to the modal", () => {
  // Regression guard: ce2c5a54 moved the password check to a preflight dialog
  // but dropped the prop wiring, so the modal posted an EMPTY password
  // header and every export died with "Invalid password" — no matter how
  // correct the typed password was. The route still requires the header.
  it("passes dashboardPassword to OAuthTransferModal and captures it on preflight success", () => {
    const page = readFileSync(
      new URL("../../src/app/(dashboard)/dashboard/providers/[id]/page.js", import.meta.url),
      "utf8",
    );
    const usage = page.match(/<OAuthTransferModal[\s\S]*?\/>/)?.[0] || "";
    expect(usage).toContain("dashboardPassword={");
    expect(page).toContain("setOauthTransferPassword(verifiedPassword)");
    // The modal must forward the prop into the header the route checks.
    const modal = readFileSync(
      new URL("../../src/app/(dashboard)/dashboard/providers/[id]/OAuthTransferModal.js", import.meta.url),
      "utf8",
    );
    expect(modal).toMatch(/"x-10r-password":\s*dashboardPassword\s*\|\|/);
    // Success is terminal: both flows must auto-dismiss (with a readable
    // delay) instead of parking the user in a spent dialog.
    expect(modal).toContain("scheduleAutoClose(1200)");
    expect(modal).toMatch(/\(data\?\.imported \|\| 0\) \+ \(data\?\.updated \|\| 0\) > 0\) scheduleAutoClose\(1800\)/);
    // …but a fully-failed import stays open, and a manual close must cancel
    // any pending auto-close (no double onClose races).
    expect(modal).toMatch(/handleClose[\s\S]{0,120}clearTimeout\(closeTimer\.current\)/);
  });
});

describe("transfer buttons placement — single-auth OAuth providers too", () => {
  // The Export/Import pair used to be inline inside the `hasDualAuthModes`
  // branch of both action areas. `mimo-desktop` declares a SINGLE auth mode
  // (["oauth"]) — its session IS its credential, and cross-machine migration is
  // exactly what its users need — yet it landed in the else arm that only ever
  // had an Add button, so the card never offered transfer. The pair is now one
  // helper called from all four arms; an inline copy would silently miss one.
  const page = readFileSync(
    new URL("../../src/app/(dashboard)/dashboard/providers/[id]/page.js", import.meta.url),
    "utf8",
  );

  it("renders through one helper gated on oauthTransferOn (not inline copies)", () => {
    expect(page).toContain("const renderOAuthTransferButtons = (className) =>");
    // The gate must keep BOTH conditions: the toggle and the CN check-in mutual
    // exclusion that the inline versions had.
    const def = page.match(/const renderOAuthTransferButtons[\s\S]{0,140}/)?.[0] || "";
    expect(def).toContain("oauthTransferOn && !codeBuddyCheckinOn");
    // No leftover inline conditional JSX blocks anywhere.
    expect(page).not.toMatch(/\{\s*\(oauthTransferOn && !codeBuddyCheckinOn\) && \(/);
  });

  it("calls the helper in every arm: zero-connection and has-connection, dual and single", () => {
    const calls = page.match(/renderOAuthTransferButtons\((?:"w-full sm:w-auto")?\)/g) || [];
    expect(calls).toHaveLength(4);
    // Plain in the zero-connection row, grid-width class in the connections row.
    expect(calls.filter((c) => c === "renderOAuthTransferButtons()")).toHaveLength(2);
    expect(
      calls.filter((c) => c === 'renderOAuthTransferButtons("w-full sm:w-auto")'),
    ).toHaveLength(2);
  });

  it("mimo-desktop really is single-auth (the arm the fix targets)", () => {
    const registry = readFileSync(
      new URL("../../open-sse/providers/registry/mimo-desktop.js", import.meta.url),
      "utf8",
    );
    const modes = registry.match(/authModes:\s*\[([^\]]*)\]/)?.[1] || "";
    expect(modes).toContain('"oauth"');
    expect(modes).not.toContain("apikey");
    expect(modes).not.toContain("api_key");
    expect(registry).toMatch(/category:\s*"oauth"/); // → present in OAUTH_PROVIDERS, providerInfo exists
  });
});

describe("accountTransfer: api-key compatible nodes (opencode-go shape)", () => {
  const originalDataDir = process.env.DATA_DIR;
  let tempDir;
  let mod;

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-transfer-apikey-"));
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

  it("exports a connection whose credential lives in apiKey (compatible-node shape)", () => {
    const accounts = mod.buildExportAccounts("opencode-go", [
      { id: "c1", authType: "apikey", apiKey: "sk-ocg-key", name: "zen" }, // no accessToken at all
      { id: "c2", authType: "oauth", accessToken: "jwt-tok" },             // oauth shape untouched
    ]);
    expect(accounts).toHaveLength(2);
    expect(accounts[0]).toMatchObject({ provider: "opencode-go", authType: "apikey", accessToken: "sk-ocg-key" });
    expect(accounts[1]).toMatchObject({ provider: "opencode-go", authType: "oauth", accessToken: "jwt-tok" });
  });

  it("skips rows with no credential in either field", () => {
    expect(mod.buildExportAccounts("opencode-go", [{ id: "x", authType: "apikey" }])).toEqual([]);
  });

  it("imports an apikey account with the key in the apiKey field (runtime contract)", async () => {
    const res = await mod.importAccounts("opencode-go", [
      { authType: "apikey", accessToken: "sk-zen-key", name: "zen" },
    ]);
    expect(res.imported).toBe(1);
    const { getProviderConnectionById } = await import("@/lib/db/repos/connectionsRepo.js");
    const conn = await getProviderConnectionById(res.results[0].id);
    expect(conn.apiKey).toBe("sk-zen-key");
    expect(conn.authType).toBe("apikey");
  });

  it("re-import dedups an apikey row by its key instead of creating a duplicate", async () => {
    const res = await mod.importAccounts("opencode-go", [
      { authType: "apikey", accessToken: "sk-zen-key", name: "zen" },
    ]);
    expect(res.updated).toBe(1);
    expect(res.imported).toBe(0);
  });
});

describe("accountTransfer: Qoder web-session probe at import (issue #44)", () => {
  const originalDataDir = process.env.DATA_DIR;
  let tempDir;
  let mod;

  const tokenFor = (sub) => {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    return `${b64({ alg: "none" })}.${b64({ iss: "https://r/realm", sub })}.sig`;
  };
  const session = (cookie, userId) => ({
    userId,
    creditDaddyWebSession: { cookie, capturedAt: "2026-10-01T00:00:00.000Z", userId },
  });

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-qoder-probe-"));
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

  beforeEach(() => {
    webFetch.mockReset();
    // Default: session alive, answers for u-1.
    webFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ user_id: "u-1" }) });
  });

  it("stays null for non-Qoder providers and for Qoder rows without a session", async () => {
    const gem = await mod.importAccounts("gemini", [
      { name: "G", accessToken: tokenFor("probe-g"), providerSpecificData: { foo: 1 } },
    ]);
    expect(gem.webSessions).toBeNull();
    const q = await mod.importAccounts("qoder", [
      { name: "NoSession", accessToken: tokenFor("probe-q1") },
    ]);
    expect(q.webSessions).toBeNull();
    expect(webFetch).not.toHaveBeenCalled();
  });

  it("reports per-account failures without failing the import", async () => {
    webFetch.mockImplementation(async (url, opts) => {
      if (opts?.headers?.Cookie === "dead") return { ok: false, status: 401, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ user_id: "u-1" }) };
    });
    const res = await mod.importAccounts("qoder", [
      { name: "Live", accessToken: tokenFor("probe-live"), providerSpecificData: session("live", "u-1") },
      { name: "Dead", accessToken: tokenFor("probe-dead"), providerSpecificData: session("dead", "u-1") },
    ]);
    expect(res.imported).toBe(2);
    expect(res.failed).toBe(0);
    expect(res.webSessions).toMatchObject({ checked: 2, ok: 1, failed: 1 });
    expect(res.webSessions.failures).toEqual([
      { id: expect.any(String), name: "Dead", reason: "HTTP 401" },
    ]);
  });

  it("routes qoder-cn probes to the CN web console", async () => {
    await mod.importAccounts("qoder-cn", [
      { name: "CN", accessToken: tokenFor("probe-cn"), providerSpecificData: session("cn", "u-1") },
    ]);
    expect(webFetch).toHaveBeenCalledTimes(1);
    expect(webFetch.mock.calls[0][0]).toBe("https://qoder.cn/api/v2/me/usages/big_model_credits");
    expect(webFetch.mock.calls[0][1].headers.Cookie).toBe("cn");
  });

  it("flags a session that answers for a different user (owner cross-check)", async () => {
    const res = await mod.importAccounts("qoder", [
      { name: "Misbound", accessToken: tokenFor("probe-mis"), providerSpecificData: session("mis", "u-9") },
    ]);
    expect(res.webSessions.failed).toBe(1);
    expect(res.webSessions.failures[0].reason).toContain("different Qoder user");
  });

  it("a throwing probe downgrades to a warning, never breaks the import", async () => {
    webFetch.mockRejectedValue(new Error("proxy unreachable"));
    const res = await mod.importAccounts("qoder", [
      { name: "Boom", accessToken: tokenFor("probe-boom"), providerSpecificData: session("boom", "u-1") },
    ]);
    expect(res.imported).toBe(1);
    expect(res.failed).toBe(0);
    expect(res.webSessions).toMatchObject({ checked: 1, ok: 0, failed: 1 });
    expect(res.webSessions.failures[0].reason).toBe("proxy unreachable");
  });

  // Meoo control-key lines (CreditDaddy sync): the credential rides in
  // providerSpecificData.meooControlKey — no OAuth token to demand. Same
  // shape the paste-key import writes, so CD-pushed and pasted rows are
  // identical to every consumer.
  it("meoo control-key line imports without any token", async () => {
    const res = await mod.importAccounts("meoo", [
      {
        name: "余师洋",
        authType: "oauth",
        providerSpecificData: { meooControlKey: "meoo_ak_cdline_1234567890", creditDaddySync: true },
      },
    ]);
    expect(res.imported).toBe(1);
    expect(res.failed).toBe(0);
    const { getProviderConnections } = await import("@/lib/db/repos/connectionsRepo.js");
    const rows = await getProviderConnections({ provider: "meoo" });
    const row = rows.find((c) => c.providerSpecificData?.meooControlKey === "meoo_ak_cdline_1234567890");
    expect(row).toBeTruthy();
    expect(row.authType).toBe("oauth");
    expect(row.accessToken).toBeFalsy();
    expect(row.providerSpecificData.creditDaddySync).toBe(true);
  });

  it("meoo control-key line re-imports dedup onto the same row", async () => {
    const res = await mod.importAccounts("meoo", [
      {
        name: "余师洋 renamed",
        providerSpecificData: { meooControlKey: "meoo_ak_cdline_1234567890", creditDaddySync: true },
      },
    ]);
    expect(res.updated).toBe(1);
    expect(res.imported).toBe(0);
  });

  it("meoo without any credential still fails loudly", async () => {
    const res = await mod.importAccounts("meoo", [{ name: "No key" }]);
    expect(res.failed).toBe(1);
    expect(res.results[0].error).toContain("Missing accessToken");
  });
});
