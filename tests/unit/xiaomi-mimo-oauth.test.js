import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import {
  generateKeyPair,
  decryptCallback,
  buildAuthorizeUrl,
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

async function hit(port, query, headers = {}) {
  return fetch(`http://127.0.0.1:${port}/${query}`, { headers });
}

let proxy;

beforeEach(async () => {
  stopXiaomiMimoProxy();
  proxy = await startXiaomiMimoProxy();
});

afterEach(() => {
  stopXiaomiMimoProxy();
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

  it("derives a stable key name", () => {
    expect(getKeyName()).toBe(getKeyName());
    expect(getKeyName()).toMatch(/^10router-xmd-[0-9a-f]{8}$/);
  });
});

describe("xiaomi-mimo OAuth callback proxy", () => {
  it("binds loopback and reports a callback url", () => {
    expect(proxy.success).toBe(true);
    expect(proxy.callbackUrl).toBe(`http://127.0.0.1:${proxy.port}/`);
  });

  it("rejects a cross-origin request (login-CSRF from a web page)", async () => {
    const res = await hit(proxy.port, "", { Origin: "https://attacker.example" });
    expect(res.status).toBe(403);
  });

  it("allows a navigation redirect that carries no Origin", async () => {
    const res = await hit(proxy.port, "");
    expect(res.status).toBe(400); // reached the handler: missing `u`
  });

  it("allows a loopback Origin", async () => {
    const res = await hit(proxy.port, "", { Origin: "http://127.0.0.1:3000" });
    expect(res.status).toBe(400);
  });

  it("reports an error when no session is pending", async () => {
    const res = await hit(proxy.port, "?u=AAAA");
    expect(res.status).toBe(500);
  });

  it("stores the decrypted key on the matched session", async () => {
    const { publicKey, privateKeyDer } = generateKeyPair();
    registerXiaomiMimoSession({ state: "s1", privateKeyDer });

    const u = encryptFor(publicKey, { uid: "uid-9", sk: "sk-live" });
    const res = await hit(proxy.port, `?u=${encodeURIComponent(u)}`);

    expect(res.status).toBe(200);
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

    const res = await hit(proxy.port, "?u=AAAA");

    expect(res.status).toBe(400);
    // One stray request must not abort every in-flight login.
    expect(getXiaomiMimoSessionStatus("s1").status).toBe("pending");
    expect(getXiaomiMimoSessionStatus("s2").status).toBe("pending");
  });

  it("still flags a lone pending session when its payload fails", async () => {
    const { privateKeyDer } = generateKeyPair();
    registerXiaomiMimoSession({ state: "s1", privateKeyDer });

    const res = await hit(proxy.port, "?u=AAAA");

    expect(res.status).toBe(400);
    const status = getXiaomiMimoSessionStatus("s1");
    expect(status.status).toBe("error");
    expect(status.error).toMatch(/decrypt/i);
  });

  it("never reflects the submitted payload into the error page", async () => {
    // Decrypt failures are swallowed per session and replaced with a constant
    // message, so the rendered page must never contain the submitted bytes.
    const { publicKey, privateKeyDer } = generateKeyPair();
    registerXiaomiMimoSession({ state: "s1", privateKeyDer });

    const u = encryptRawFor(publicKey, "<script>alert(1)</script>");
    const res = await hit(proxy.port, `?u=${encodeURIComponent(u)}`);
    const body = await res.text();

    expect(res.status).toBe(400);
    expect(body).toContain("Authentication Failed");
    expect(body).toContain("Could not decrypt with any pending session key");
    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).not.toContain("alert(1)");
  });

  it("drops sessions when the proxy stops", () => {
    const { privateKeyDer } = generateKeyPair();
    registerXiaomiMimoSession({ state: "s1", privateKeyDer });
    expect(getXiaomiMimoSessionStatus("s1")).not.toBeNull();

    stopXiaomiMimoProxy();
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

  it("keeps the loopback origin guard on the proxy", () => {
    const source = fs.readFileSync(srcPath("src/lib/oauth/utils/server.js"), "utf-8");
    expect(source).toContain("if (!isLoopbackOrigin(req.headers.origin))");
  });

  it("renders callback pages through the escaped house renderer", () => {
    const source = fs.readFileSync(srcPath("src/lib/oauth/utils/server.js"), "utf-8");
    expect(source).toContain("renderCodexResultPage(false, `Decryption failed: ${err.message}`)");
  });
});
