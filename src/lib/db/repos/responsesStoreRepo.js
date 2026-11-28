import { getAdapter } from "../driver.js";
import { hashApiKey } from "../crypto/apiKeyIdentity.js";
import { decryptSecret, encryptSecret } from "../crypto/credentialCipher.js";

// Responses continuations are short-lived working state, not a transcript to
// keep: 24h matches how long an agent session plausibly resumes, and bounds what
// a leaked database hands over.
const TTL_MS = 24 * 60 * 60 * 1000;
// A snapshot is the whole conversation, so it can be large. Past this size the
// row is refused rather than silently truncating history a later turn depends on.
export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

// Callers are separated by the digest of their API key, so one caller cannot read
// or overwrite another's conversation by guessing a response id. Keyless local
// traffic (loopback, CLI) shares one bucket — those callers are all the machine
// owner, and there is no secret to digest.
function callerScope(apiKey) {
  return hashApiKey(apiKey) || "local-no-key";
}

export async function getResponseSnapshot(id, apiKey) {
  const db = await getAdapter();
  const row = db.get(
    "SELECT data FROM responsesStore WHERE id = ? AND apiKeyHash = ? AND expiresAt > ?",
    [id, callerScope(apiKey), Date.now()],
  );
  if (!row) return null;
  return JSON.parse(decryptSecret(row.data));
}

export async function saveResponseSnapshot(id, apiKey, snapshot) {
  const data = JSON.stringify(snapshot);
  if (Buffer.byteLength(data) > MAX_SNAPSHOT_BYTES) {
    throw new Error(`Responses snapshot exceeds ${MAX_SNAPSHOT_BYTES} bytes`);
  }
  const encrypted = encryptSecret(data);
  const apiKeyHash = callerScope(apiKey);
  const now = Date.now();
  const db = await getAdapter();
  db.transaction(() => {
    db.run("DELETE FROM responsesStore WHERE expiresAt <= ?", [now]);
    db.run(
      `INSERT INTO responsesStore (id, apiKeyHash, data, expiresAt) VALUES (?, ?, ?, ?)
       ON CONFLICT (id, apiKeyHash) DO UPDATE SET data = excluded.data, expiresAt = excluded.expiresAt`,
      [id, apiKeyHash, encrypted, now + TTL_MS],
    );
  });
}
