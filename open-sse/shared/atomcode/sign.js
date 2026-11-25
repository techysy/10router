import crypto from "crypto";

// AtomCode (AtomGit CodingPlan) LLM gateway request signing.
//
// The CodingPlan inference gateway (llm-api.atomgit.com/v1) rejects a bare
// OAuth bearer with HTTP 403 {code:"ATOMCODE_SIG_MISSING"} and a wrong
// signature with {code:"ATOMCODE_SIG_INVALID"}: every request must carry a
// per-request HMAC signature plus X-AtomCode-* headers. The algorithm is
// recovered from the official build v5.2.8 (crate atomcode-codingplan-crypto,
// versions/v1.rs). The signing secret below is a static app key extracted from
// that binary (de-obfuscated), not a user credential.
//
// Scheme (verified live against the gateway):
//   window  = floor(ts / 3600)
//   salt    = userId || 0x01 || u64le(window) || sha256(token) || sha256(ver)
//   prk     = HMAC-SHA256(salt, SECRET)                 // HKDF-extract
//   key     = HMAC-SHA256(prk, "atomcode-signing-v1" || 0x01)  // HKDF-expand
//   canon   = "v1\nPOST\n" + path + "\n" + ts + "\n" + hex(nonce) + "\n" + hex(sha256(body))
//   sig     = "v1:" + hex(HMAC-SHA256(key, canon))
// Headers: X-AtomCode-Sig, X-AtomCode-Ts, X-AtomCode-Nonce, X-AtomCode-Alg=1, X-AtomCode-Ver.

const SECRET = Buffer.from(
  "e97250f05303162c8ecd68c688b2f55c1d81e508d243d88466472e7f54637123",
  "hex",
);

export const ATOMCODE_ALG = "1";
export const ATOMCODE_INFO = "atomcode-signing-v1";

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest();
const hmac = (key, buf) => crypto.createHmac("sha256", key).update(buf).digest();

/**
 * Build the signing headers for one chat/completions request.
 * @param {object} p
 * @param {string} p.path   canonical path, e.g. "/v1/chat/completions"
 * @param {Buffer|string} p.body  the exact serialized request body
 * @param {string} p.token  OAuth access token
 * @param {string} p.userId CodingPlan user id (providerSpecificData.userId)
 * @param {string} p.version client version advertised as X-AtomCode-Ver
 * @param {number} [p.ts]    unix seconds (defaults to now)
 * @param {Buffer} [p.nonce] 16 random bytes (defaults to fresh)
 */
export function signAtomCode({ path, body, token, userId, version, ts, nonce }) {
  const now = Number.isFinite(ts) ? ts : Math.floor(Date.now() / 1000);
  const n = nonce || crypto.randomBytes(16);
  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");

  const win = Buffer.alloc(8);
  win.writeBigUInt64LE(BigInt(Math.floor(now / 3600)));
  const salt = Buffer.concat([
    Buffer.from(String(userId), "utf8"),
    Buffer.from([0x01]),
    win,
    sha256(Buffer.from(String(token), "utf8")),
    sha256(Buffer.from(String(version), "utf8")),
  ]);
  const prk = hmac(salt, SECRET);
  const key = hmac(prk, Buffer.concat([Buffer.from(ATOMCODE_INFO, "utf8"), Buffer.from([0x01])]));

  const canon = Buffer.from(
    `v1\nPOST\n${path}\n${now}\n${n.toString("hex")}\n${sha256(bodyBuf).toString("hex")}`,
    "utf8",
  );
  const sig = "v1:" + hmac(key, canon).toString("hex");

  return {
    "X-AtomCode-Sig": sig,
    "X-AtomCode-Ts": String(now),
    "X-AtomCode-Nonce": n.toString("hex"),
    "X-AtomCode-Alg": ATOMCODE_ALG,
    "X-AtomCode-Ver": version,
  };
}
