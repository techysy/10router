// `atomcode-signing-v1` — request signature for the AtomGit gateway.
//
// Algorithm (verified against the MIT Atom2Api fixture; the official tree only
// publishes the signer interface, not its body):
//
//   tokenHash    = SHA-256(oauthToken)
//   versionHash  = SHA-256(clientVersion)
//   salt         = userId || 0x01 || LE64(floor(timestamp / 3600))
//                  || tokenHash || versionHash
//   prk          = HMAC-SHA256(key=salt, msg=masterKey)          (HKDF extract)
//   signingKey   = HMAC-SHA256(key=prk, msg="atomcode-signing-v1" || 0x01)
//                                                                (one expand block)
//   canonical    = "v1" \n METHOD \n path \n ts \n nonceHex \n SHA256(body)hex
//   signature    = HMAC-SHA256(key=signingKey, msg=canonical)
//
// Headers: X-AtomCode-Sig: v1:<hex>, X-AtomCode-Ts, X-AtomCode-Nonce,
// X-AtomCode-Alg: 1, X-AtomCode-Ver: <clientVersion>.
//
// Kept as a pure function: the caller injects timestamp/nonce so the output is
// reproducible in tests, and the master key can be replaced without touching
// transport code.

import { createHash, createHmac, randomBytes } from "node:crypto";

import {
  ATOMCODE_SIGN_ALG,
  ATOMCODE_SIGN_CLIENT_VERSION,
  ATOMCODE_SIGN_HEADER_ALG,
  ATOMCODE_SIGN_HEADER_NONCE,
  ATOMCODE_SIGN_HEADER_SIG,
  ATOMCODE_SIGN_HEADER_TS,
  ATOMCODE_SIGN_HEADER_VER,
  ATOMCODE_SIGN_LABEL,
  ATOMCODE_SIGN_NONCE_BYTES,
  ATOMCODE_SIGN_VERSION,
  atomcodeSignClientVersion,
  atomcodeSignMasterKeyHex,
} from "./constants.js";

const sha256 = (value) => createHash("sha256").update(value).digest();
const hmac = (key, value) => createHmac("sha256", key).update(value).digest();

/**
 * Sign one upstream request.
 *
 * @param {object} input
 * @param {string} input.method         HTTP method
 * @param {string} input.path           escaped path only (no host, no query)
 * @param {string|Buffer} input.body    exact body bytes sent upstream
 * @param {string} input.accessToken    OAuth bearer
 * @param {string} input.userId         AtomGit numeric/sting user id
 * @param {string} [input.clientVersion]
 * @param {number} [input.timestamp]    unix seconds (defaults to now)
 * @param {Buffer} [input.nonce]        16 bytes (defaults to random)
 * @param {string} [input.masterKeyHex]
 * @returns {Record<string,string>} the five X-AtomCode-* headers
 */
export function signAtomcodeRequest({
  method,
  path,
  body = "",
  accessToken,
  userId,
  clientVersion,
  timestamp,
  nonce,
  masterKeyHex,
}) {
  const token = typeof accessToken === "string" ? accessToken.trim() : "";
  const user = typeof userId === "string" ? userId.trim() : String(userId ?? "").trim();
  if (!token) throw new Error("AtomCode signing requires an OAuth token");
  if (!user) throw new Error("AtomCode signing requires a user id");

  const version = atomcodeSignClientVersion(clientVersion);
  const keyHex = atomcodeSignMasterKeyHex(masterKeyHex);
  const masterKey = Buffer.from(keyHex, "hex");
  if (masterKey.length !== 32) {
    throw new Error("AtomCode signing master key must be 32-byte hex");
  }

  const nonceBytes = nonce ?? randomBytes(ATOMCODE_SIGN_NONCE_BYTES);
  if (!Buffer.isBuffer(nonceBytes) || nonceBytes.length !== ATOMCODE_SIGN_NONCE_BYTES) {
    throw new Error(`AtomCode signing nonce must be ${ATOMCODE_SIGN_NONCE_BYTES} bytes`);
  }

  const seconds = Number.isFinite(timestamp) ? Math.floor(timestamp) : Math.floor(Date.now() / 1000);
  const timeBucket = Buffer.alloc(8);
  timeBucket.writeBigUInt64LE(BigInt(Math.floor(seconds / 3600)));

  const salt = Buffer.concat([
    Buffer.from(user, "utf8"),
    Buffer.from([1]),
    timeBucket,
    sha256(token),
    sha256(version),
  ]);

  // HKDF-SHA256 extract + one expand block (32-byte output).
  const prk = hmac(salt, masterKey);
  const signingKey = hmac(
    prk,
    Buffer.concat([Buffer.from(ATOMCODE_SIGN_LABEL, "utf8"), Buffer.from([1])])
  );

  const bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
  const nonceHex = nonceBytes.toString("hex");
  const canonical = [
    ATOMCODE_SIGN_VERSION,
    String(method || "POST").toUpperCase(),
    path,
    String(seconds),
    nonceHex,
    sha256(bodyBuffer).toString("hex"),
  ].join("\n");

  const signature = hmac(signingKey, canonical).toString("hex");

  return {
    [ATOMCODE_SIGN_HEADER_SIG]: `${ATOMCODE_SIGN_VERSION}:${signature}`,
    [ATOMCODE_SIGN_HEADER_TS]: String(seconds),
    [ATOMCODE_SIGN_HEADER_NONCE]: nonceHex,
    [ATOMCODE_SIGN_HEADER_ALG]: ATOMCODE_SIGN_ALG,
    [ATOMCODE_SIGN_HEADER_VER]: version,
  };
}

/** Default client version used when a connection does not override it. */
export function atomcodeDefaultClientVersion() {
  return ATOMCODE_SIGN_CLIENT_VERSION;
}
