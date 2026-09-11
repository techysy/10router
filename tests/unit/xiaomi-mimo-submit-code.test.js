import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "crypto";

import {
  completeXiaomiMimoFlow,
  normalizeXiaomiMimoPayload,
  registerXiaomiMimoSession,
  clearXiaomiMimoSession,
  getXiaomiMimoSessionStatus,
} from "../../src/lib/oauth/utils/server.js";
import { generateKeyPair } from "../../src/lib/oauth/providers/xiaomi-mimo.js";

// The platform's authorize page may show a code instead of calling our localhost
// redirect. That code is NOT a plain authorization code — it is the exact same
// ECDH+AES-256-GCM blob the `u` callback param carries, which is why one payload
// can arrive by two routes and why neither carries a state.
//
// These cases build payloads the way the platform does (ephemeral X25519 keypair →
// ECDH with the client's public key → SHA256 → AES-GCM) and drive the real
// decryption, so the wire format itself is under test rather than mocked.

const registered = [];

/** Encrypt `payload` for a client keypair, exactly like the platform does. */
function platformEncrypt(clientPrivateKeyDer, payload) {
  const clientPublicKey = crypto.createPublicKey({
    key: clientPrivateKeyDer,
    format: "der",
    type: "pkcs8",
  });
  const ephemeral = crypto.generateKeyPairSync("x25519");
  const sharedSecret = crypto.diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: clientPublicKey,
  });
  const key = crypto.createHash("sha256").update(sharedSecret).digest();

  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf-8"),
    cipher.final(),
  ]);

  // SPKI's X25519 prefix is 12 bytes, then the raw 32-byte key.
  const ephemeralRaw = ephemeral.publicKey.export({ format: "der", type: "spki" }).subarray(12);
  return Buffer.concat([nonce, ephemeralRaw, ciphertext, cipher.getAuthTag()]).toString("base64");
}

/** Register a pending session and remember it for cleanup. */
function pend(state) {
  const { privateKeyDer } = generateKeyPair();
  registerXiaomiMimoSession({ state, privateKeyDer });
  registered.push(state);
  return privateKeyDer;
}

beforeEach(() => {
  registered.length = 0;
});

afterEach(() => {
  // The session map is module state, so a leftover pending key would make later
  // cases (e.g. no_pending_session) see a session that this test created.
  for (const state of registered) clearXiaomiMimoSession(state);
});

describe("completeXiaomiMimoFlow (pasted authorization code)", () => {
  it("decrypts a pasted code and stores the credential in the matching session", async () => {
    const privateKeyDer = pend("state-a");
    const code = platformEncrypt(privateKeyDer, {
      uid: "uid-42",
      sk: "sk-pasted-key",
      url: "https://api.xiaomimimo.com/v1",
    });

    const outcome = await completeXiaomiMimoFlow(code);

    expect(outcome.ok).toBe(true);
    expect(outcome.state).toBe("state-a");
    expect(outcome.result).toEqual({
      uid: "uid-42",
      accessToken: "sk-pasted-key",
      baseUrl: "https://api.xiaomimimo.com/v1",
    });
    // Stored on the session so /exchange can consume it without the key ever
    // reaching the browser.
    expect(getXiaomiMimoSessionStatus("state-a")).toMatchObject({
      status: "done",
      result: { accessToken: "sk-pasted-key" },
    });
  });

  it("tries every pending key, not just the first", async () => {
    pend("state-1");
    pend("state-2");
    const target = pend("state-3");
    const code = platformEncrypt(target, { uid: "uid-3", sk: "sk-third" });

    const outcome = await completeXiaomiMimoFlow(code);

    expect(outcome).toMatchObject({ ok: true, state: "state-3" });
    expect(getXiaomiMimoSessionStatus("state-1").status).toBe("pending");
    expect(getXiaomiMimoSessionStatus("state-2").status).toBe("pending");
  });

  it("falls back to the default base URL when the payload omits one", async () => {
    const privateKeyDer = pend("state-url");
    const code = platformEncrypt(privateKeyDer, { uid: "u", sk: "sk-1" });

    const outcome = await completeXiaomiMimoFlow(code);

    expect(outcome.result.baseUrl).toBe("https://api.xiaomimimo.com/v1");
  });

  it("accepts a pasted URL wrapper and surrounding whitespace", async () => {
    const privateKeyDer = pend("state-wrapped");
    const code = platformEncrypt(privateKeyDer, { uid: "u", sk: "sk-wrap" });

    const outcome = await completeXiaomiMimoFlow(
      `  https://platform.xiaomimimo.com/authorize/code/callback?kn=mimocode&u=${code}\n  `,
    );

    expect(outcome).toMatchObject({ ok: true, state: "state-wrapped" });
  });

  it("reports empty input, a missing session and unreadable codes distinctly", async () => {
    expect(await completeXiaomiMimoFlow("   ")).toEqual({ ok: false, error: "empty_payload" });
    expect(await completeXiaomiMimoFlow(null)).toEqual({ ok: false, error: "empty_payload" });

    // No session at all — the UI must tell the user to restart the sign-in.
    expect(await completeXiaomiMimoFlow("QUJD")).toEqual({ ok: false, error: "no_pending_session" });

    pend("state-x");
    // A real session exists, but this blob was encrypted for someone else.
    const otherKey = crypto.generateKeyPairSync("x25519").privateKey.export({
      format: "der",
      type: "pkcs8",
    });
    const foreign = platformEncrypt(otherKey, { uid: "u", sk: "sk-other" });
    expect(await completeXiaomiMimoFlow(foreign)).toEqual({ ok: false, error: "decrypt_failed" });
    expect(await completeXiaomiMimoFlow("not-a-real-code")).toEqual({
      ok: false,
      error: "decrypt_failed",
    });
  });

  it("distinguishes a decoded-but-keyless payload from a failed decryption", async () => {
    const privateKeyDer = pend("state-nokey");
    const code = platformEncrypt(privateKeyDer, { uid: "u", url: "https://api.xiaomimimo.com/v1" });

    // The GCM tag verified, so the key was right — blaming the code would send the
    // user to re-copy a code that is actually fine.
    expect(await completeXiaomiMimoFlow(code)).toEqual({ ok: false, error: "missing_api_key" });
  });

  it("leaves every session pending when the payload cannot be read", async () => {
    pend("state-live-1");
    pend("state-live-2");

    const outcome = await completeXiaomiMimoFlow("garbage");

    expect(outcome).toEqual({ ok: false, error: "decrypt_failed" });
    // One stray payload must not abort concurrent logins.
    expect(getXiaomiMimoSessionStatus("state-live-1").status).toBe("pending");
    expect(getXiaomiMimoSessionStatus("state-live-2").status).toBe("pending");
  });
});

describe("normalizeXiaomiMimoPayload", () => {
  it("unwraps a URL, decodes it and strips whitespace", () => {
    expect(normalizeXiaomiMimoPayload("https://x/authorize?u=YWJj%2B2Q")).toBe("YWJj+2Q");
    expect(normalizeXiaomiMimoPayload("https://x/authorize?code=YWJj")).toBe("YWJj");
    expect(normalizeXiaomiMimoPayload("  YWJj\n  ZGVm \t")).toBe("YWJjZGVm");
  });

  it("passes a bare code through untouched", () => {
    expect(normalizeXiaomiMimoPayload("YWJj_-+/=")).toBe("YWJj_-+/=");
  });

  it("returns an empty string for missing input", () => {
    expect(normalizeXiaomiMimoPayload(undefined)).toBe("");
    expect(normalizeXiaomiMimoPayload("  ")).toBe("");
  });
});
