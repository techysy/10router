// Encrypted OAuth-credentials transfer envelope (server-side).
//
// Exports/imports of OAuth connections carry live tokens; the legacy
// codebuddy-cn wb-format export was plain JSON. This module seals the payload
// with a user-supplied passphrase: scrypt-derived key + AES-256-GCM, so the
// file on disk is useless without the passphrase (and GCM's tag makes
// wrong-passphrase / tampered blobs fail closed at decryption time).

import crypto from "node:crypto";

export const TRANSFER_FORMAT = "10router-oauth-secure-v1";

const KDF = { alg: "scrypt", N: 16384, r: 8, p: 1, keyLen: 32 };

const b64 = (buf) => buf.toString("base64");
const unb64 = (s) => Buffer.from(String(s), "base64");

function deriveKey(password, salt) {
  return crypto.scryptSync(String(password), salt, KDF.keyLen, {
    N: KDF.N,
    r: KDF.r,
    p: KDF.p,
    maxmem: 64 * 1024 * 1024,
  });
}

/** Seal a JSON-serializable payload into a transfer envelope. */
export function sealTransfer(payload, password) {
  if (!password || typeof password !== "string" || password.length < 4) {
    throw new Error("PASSPHRASE_TOO_SHORT");
  }
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(password, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const payloadB64 = b64(Buffer.concat([cipher.update(plaintext), cipher.final()]));
  return {
    format: TRANSFER_FORMAT,
    kdf: { ...KDF, salt: b64(salt) },
    cipher: "aes-256-gcm",
    iv: b64(iv),
    tag: b64(cipher.getAuthTag()),
    payload: payloadB64,
  };
}

/** Open a transfer envelope; throws WRONG_PASSWORD / CORRUPT on failure. */
export function openTransfer(blob, password) {
  if (!blob || typeof blob !== "object") throw new Error("CORRUPT");
  if (blob.format !== TRANSFER_FORMAT) throw new Error("UNSUPPORTED_FORMAT");
  if (!blob.kdf?.salt || !blob.iv || !blob.tag || !blob.payload) throw new Error("CORRUPT");
  let key;
  try {
    key = deriveKey(password, unb64(blob.kdf.salt));
  } catch {
    throw new Error("CORRUPT");
  }
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, unb64(blob.iv));
    decipher.setAuthTag(unb64(blob.tag));
    const plain = Buffer.concat([decipher.update(unb64(blob.payload)), decipher.final()]);
    return JSON.parse(plain.toString("utf8"));
  } catch {
    // GCM auth failure = wrong passphrase (or a tampered file) — do not leak which.
    throw new Error("WRONG_PASSWORD");
  }
}
