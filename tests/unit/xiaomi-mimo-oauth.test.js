import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import {
  generateKeyPair,
  decryptCallback,
  buildAuthorizeUrl,
  buildManualAuthorizeUrl,
  getKeyName,
} from "../../src/lib/oauth/providers/xiaomi-mimo.js";
import {
  registerXiaomiMimoSession,
  getXiaomiMimoSessionStatus,
  clearXiaomiMimoSession,
  startXiaomiMimoProxy,
  stopXiaomiMimoProxy,
} from "../../src/lib/oauth/utils/server.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcPath = (rel) => path.join(here, "..", "..", rel);

/**
 * Test-side counterpart of the Xiaomi wire format: performs the OTHER half of
 * the ECDH handshake and AES-256-GCM encrypts `payload` to the client's public
 * key. This lets the whole decrypt path be exercised without any credentials.
 */
function encryptRawFor(clientPublicKeyB64, plaintext) {
  const clientPub = crypto.createPublicKey({
    key: Buffer.from(clientPublicKeyB64, "base64"),
    format: "der",
    type: "spki",
  });
  const { publicKey: ephPub, privateKey: ephPriv } = crypto.generateKeyPairSync("x25519");

  const shared = crypto.diffieHellman({ privateKey: ephPriv, publicKey: clientPub });
  const key = crypto.createHash("sha256").update(shared).digest();

  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  // SPKI DER for X25519 = 12-byte prefix + 32-byte raw key
  const ephRaw = ephPub.export({ format: "der", type: "spki" }).subarray(12);

  return Buffer.concat([nonce, ephRaw, ciphertext, tag]).toString("base64");
}

const encryptFor = (clientPublicKeyB64, payload) =>
  encryptRawFor(clientPublicKeyB64, JSON.stringify(payload));

async function hit(port, query, headers = {}, init = {}) {
  // The listener only answers on its per-listener secret path (that path IS the
  // anti-CSRF capability), so tests must address it through the URL it handed out.
  const base = proxy?.callbackUrl || `http://127.0.0.1:${port}/`;
  const url = new URL(base);
  if (query) url.search = query.startsWith("?") ? query : `?${query}`;
  return fetch(url.toString(), { headers, ...init });
}

/** Hit an arbitrary path — used to prove anything but the secret path is refused. */
async function hitPath(port, path, headers = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, { headers });
}

let proxy;

// Sessions deliberately outlive the proxy listener (the platform's authorize page makes
// the user paste a code by hand, so a key must survive a listener timeout), which means
// stopping the proxy is NOT a way to reset them. Reset them explicitly instead.
const TEST_STATES = ["s", "s1", "s2"];
function resetSessions() {
  for (const state of TEST_STATES) clearXiaomiMimoSession(state);
}

beforeEach(async () => {
  stopXiaomiMimoProxy();
  resetSessions();
  proxy = await startXiaomiMimoProxy();
});

afterEach(() => {
  stopXiaomiMimoProxy();
  resetSessions();
});

describe("xiaomi-mimo OAuth crypto", () => {
  it("round-trips an encrypted callback payload", () => {
    const { publicKey, privateKeyDer } = generateKeyPair();
    const u = encryptFor(publicKey, { uid: "u-1", sk: "sk-abc", url: "https://x/v1" });

    const out = decryptCallback(privateKeyDer, u);
    expect(out.uid).toBe("u-1");
    expect(out.sk).toBe("sk-abc");
    expect(out.url).toBe("https://x/v1");
  });

  it("falls back to the default base url when the payload omits it", () => {
    const { publicKey, privateKeyDer } = generateKeyPair();
    const u = encryptFor(publicKey, { uid: "u-2", sk: "sk-2" });

    expect(decryptCallback(privateKeyDer, u).url).toBe("https://api.xiaomimimo.com/v1");
  });

  it("rejects a payload shorter than nonce+pubkey+tag", () => {
    const { privateKeyDer } = generateKeyPair();
    const short = Buffer.alloc(40).toString("base64");
    expect(() => decryptCallback(privateKeyDer, short)).toThrow(/too short/i);
  });

  it("rejects a payload encrypted to a different key (GCM auth failure)", () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const u = encryptFor(b.publicKey, { uid: "u", sk: "sk" });
    expect(() => decryptCallback(a.privateKeyDer, u)).toThrow();
  });

  it("builds an authorize url carrying the public key and kn", () => {
    const url = new URL(buildAuthorizeUrl("PUB", "http://localhost:1234/"));
    expect(url.pathname).toBe("/authorize");
    expect(url.searchParams.get("pk")).toBe("PUB");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:1234/");
    expect(url.searchParams.get("kn")).toBe("mimocode");
  });

  it("sends app=MiMo, like the official client's builder", () => {
    // The platform selects which client the authorization code is minted for from this
    // parameter. Without it the page returns a blob encrypted for a DIFFERENT key, so
    // the code is well-formed and the right size yet no key we hold can open it.
    const url = new URL(buildAuthorizeUrl("PUB", "http://localhost:1234/", "key-1"));
    expect(url.searchParams.get("app")).toBe("MiMo");
    expect(url.searchParams.get("key_name")).toBe("key-1");
  });

  it("offers the platform's own code-display page as the manual fallback", () => {
    const url = new URL(buildManualAuthorizeUrl("PUB", "key-1"));
    expect(url.pathname).toBe("/authorize");
    // Identical request, except the payload is rendered for the user to copy instead of
    // being handed to a listener — the manual half of the official flow.
    expect(url.searchParams.get("pk")).toBe("PUB");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://platform.xiaomimimo.com/authorize/code/callback",
    );
    expect(url.searchParams.get("kn")).toBe("mimocode");
    expect(url.searchParams.get("app")).toBe("MiMo");
  });

  it("derives a stable key name", () => {
    expect(getKeyName()).toBe(getKeyName());
    expect(getKeyName()).toMatch(/^10router-xmd-[0-9a-f]{8}$/);
  });
});

describe("xiaomi-mimo OAuth callback proxy", () => {
  it("binds loopback and reports an unguessable callback path", () => {
    expect(proxy.success).toBe(true);
    // The path is a capability: the platform fetches exactly this URL, and a page that
    // cannot guess it cannot reach the handler at all.
    expect(proxy.callbackUrl).toMatch(
      new RegExp(`^http://127\\.0\\.0\\.1:${proxy.port}/callback/[0-9a-f]{32}$`),
    );
  });

  it("refuses anything but the secret callback path (login-CSRF from a web page)", async () => {
    // Replaces the old loopback-Origin guard: that one had to go because the platform's
    // own https page is the legitimate caller. The secret path protects the same asset
    // — an attacker page cannot know it, and cannot guess it.
    const res = await hitPath(proxy.port, "/", { Origin: "https://attacker.example" });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("u=");
  });

  it("reports a missing payload to the platform instead of rendering a page", async () => {
    const res = await hit(proxy.port, "", {}, { redirect: "manual" });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location"));
    expect(location.origin).toBe("https://platform.xiaomimimo.com");
    expect(location.pathname).toBe("/authorize/callback");
    expect(location.searchParams.get("status")).toBe("error");
    expect(location.searchParams.get("message")).toBe("missing_data");
  });

  it("serves a cross-origin call from the platform login page", async () => {
    // The platform's page calls this listener with fetch() from its own https origin,
    // which a loopback-only guard used to reject — silently breaking every sign-in.
    const origin = "https://platform.xiaomimimo.com";
    const preflight = await fetch(proxy.callbackUrl, { method: "OPTIONS", headers: { Origin: origin } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
  });

  it("stores the decrypted key on the matched session", async () => {
    const { publicKey, privateKeyDer } = generateKeyPair();
    registerXiaomiMimoSession({ state: "s1", privateKeyDer });

    const u = encryptFor(publicKey, { uid: "uid-9", sk: "sk-live" });
    const res = await hit(proxy.port, `?u=${encodeURIComponent(u)}`, {}, { redirect: "manual" });

    // Success is reported by redirecting the platform's page to its own callback URL,
    // exactly as the official client does — the page then closes out its sign-in UI.
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location"));
    expect(location.pathname).toBe("/authorize/callback");
    expect(location.searchParams.get("status")).toBe("success");

    const status = getXiaomiMimoSessionStatus("s1");
    expect(status.status).toBe("done");
    expect(status.result.accessToken).toBe("sk-live");
    expect(status.result.uid).toBe("uid-9");
  });

  it("never exposes the private key through the status view", async () => {
    const { privateKeyDer } = generateKeyPair();
    registerXiaomiMimoSession({ state: "s1", privateKeyDer });

    const status = getXiaomiMimoSessionStatus("s1");
    expect(status).toEqual({ status: "pending", result: null, error: null });
    expect(JSON.stringify(status)).not.toContain("privateKeyDer");
  });

  // ── unattributable-failure hardening (the callback carries no state) ──────

  it("leaves concurrent sessions pending when an unattributable payload fails", async () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    registerXiaomiMimoSession({ state: "s1", privateKeyDer: a.privateKeyDer });
    registerXiaomiMimoSession({ state: "s2", privateKeyDer: b.privateKeyDer });

    const res = await hit(proxy.port, "?u=AAAA", {}, { redirect: "manual" });

    // Reported to the platform's page as a failure; the in-flight logins stay untouched.
    expect(res.status).toBe(302);
    // One stray request must not abort every in-flight login.
    expect(getXiaomiMimoSessionStatus("s1").status).toBe("pending");
    expect(getXiaomiMimoSessionStatus("s2").status).toBe("pending");
  });

  it("still flags a lone pending session when its payload fails", async () => {
    const { privateKeyDer } = generateKeyPair();
    registerXiaomiMimoSession({ state: "s1", privateKeyDer });

    const res = await hit(proxy.port, "?u=AAAA", {}, { redirect: "manual" });

    expect(res.status).toBe(302);
    const status = getXiaomiMimoSessionStatus("s1");
    expect(status.status).toBe("error");
    expect(status.error).toMatch(/decrypt/i);
  });

  it("reports an unreadable payload to the platform, without reflecting it", async () => {
    // Failures are reported to the platform's page by redirect (there is no page of ours
    // left to render), and the constant message means the submitted bytes can never
    // travel back — the Location must stay a fixed platform URL.
    const { publicKey, privateKeyDer } = generateKeyPair();
    registerXiaomiMimoSession({ state: "s1", privateKeyDer });

    const u = encryptRawFor(publicKey, "<script>alert(1)</script>");
    const res = await hit(proxy.port, `?u=${encodeURIComponent(u)}`, {}, { redirect: "manual" });
    const location = res.headers.get("location") || "";
    const body = await res.text();

    expect(res.status).toBe(302);
    expect(location).toContain("/authorize/callback?status=error&message=decrypt_failed");
    expect(location).not.toContain("alert");
    expect(body).not.toContain("alert(1)");
    expect(body).not.toContain(u);
  });

  it("keeps sessions alive when the proxy stops", () => {
    // The listener is only the AUTOMATIC callback path. The authorize page also shows a
    // code to paste by hand, and that path stays valid after the 5-minute listener
    // times out — so stopping the listener must never drop the keys. It used to, which
    // made a pasted code fail with "does not match this sign-in" exactly when a user
    // fell back to pasting.
    const { privateKeyDer } = generateKeyPair();
    registerXiaomiMimoSession({ state: "s1", privateKeyDer });
    expect(getXiaomiMimoSessionStatus("s1")).not.toBeNull();

    stopXiaomiMimoProxy();
    expect(getXiaomiMimoSessionStatus("s1")).not.toBeNull();

    clearXiaomiMimoSession("s1");
    expect(getXiaomiMimoSessionStatus("s1")).toBeNull();
  });

  it("clearXiaomiMimoSession removes a single session", () => {
    const { privateKeyDer } = generateKeyPair();
    registerXiaomiMimoSession({ state: "s1", privateKeyDer });
    clearXiaomiMimoSession("s1");
    expect(getXiaomiMimoSessionStatus("s1")).toBeNull();
  });

  it("rejects registration without a state or key", () => {
    expect(registerXiaomiMimoSession({ state: "s", privateKeyDer: null })).toBe(false);
    expect(registerXiaomiMimoSession({ state: null, privateKeyDer: Buffer.alloc(1) })).toBe(false);
  });

  it("reuses the running proxy on a second start", async () => {
    const again = await startXiaomiMimoProxy();
    expect(again.port).toBe(proxy.port);
  });
});

describe("xiaomi-mimo OAuth security invariants (source)", () => {
  it("attributes a failure to the solo session instead of blanket-failing", () => {
    const source = fs.readFileSync(srcPath("src/lib/oauth/utils/server.js"), "utf-8");
    expect(source).toContain("if (pendingSessions.length === 1)");
    // The upstream blanket loop over every pending session must not come back.
    expect(source).not.toContain("for (const [, session] of pendingSessions) {");
  });

  it("keeps a per-listener secret callback path", () => {
    // This replaced the loopback-Origin guard, which could never pass for the platform's
    // own https login page (it was rejecting the one legitimate cross-origin caller).
    const source = fs.readFileSync(srcPath("src/lib/oauth/utils/server.js"), "utf-8");
    expect(source).toContain('`/callback/${crypto.randomBytes(16).toString("hex")}`');
    expect(source).toContain("if (url.pathname !== callbackPath)");
  });

  it("reports the hand-off to the platform's own callback page", () => {
    const source = fs.readFileSync(srcPath("src/lib/oauth/utils/server.js"), "utf-8");
    // Mirroring the official client: the page that opened the sign-in is the one that
    // must be told how it went, otherwise its UI hangs with no success state.
    expect(source).toContain("/authorize/callback");
    expect(source).toContain('xiaomiMimoPlatformCallbackUrl("success")');
  });
});
