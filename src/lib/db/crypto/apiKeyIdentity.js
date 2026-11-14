// Key identity for stored usage records (issue #9, item 5).
//
// The usage log used to keep the full `sk-…` value in every row — the largest
// and most-shared table in the database, and the one people screenshot, export
// and paste into issues. Nothing needs the raw value back: the log only ever
// *groups* by key (per-key stats) and *labels* it (the name from the apiKeys
// table), both of which work off a stable digest, while the display only needs
// the first few characters.
//
// So a record now carries:
//   * a masked value for display (`sk-496f00…`), and
//   * a SHA-256 digest for grouping and for looking the key's name up.
//
// The digest is not secret (it is a one-way function of a value the holder
// already has), which is the point: reading the database no longer hands over a
// usable credential, and grouping/lookup keep working unchanged.

import crypto from "node:crypto";

export function maskApiKey(key) {
  if (!key || typeof key !== "string") return null;
  const trimmed = key.trim();
  if (trimmed.length <= 12) return trimmed.charAt(0) + "***";
  // Keep the tail: keys sharing a machine-id prefix (team keys) must not
  // collide into one indistinguishable display string.
  return trimmed.slice(0, 8) + "***" + trimmed.slice(-4);
}

export function hashApiKey(key) {
  if (!key || typeof key !== "string") return null;
  return crypto.createHash("sha256").update(key.trim()).digest("hex");
}

// Usage backups carry a digest plus a display mask; older backups carry the
// plaintext key. Resolve once so dedup, history and daily stats use one identity.
export function apiKeyIdentity(key, suppliedHash) {
  const rawKey = typeof key === "string" ? key.trim() : "";
  let apiKeyHash = null;
  if (suppliedHash != null && suppliedHash !== "") {
    if (typeof suppliedHash !== "string" || !/^[a-f0-9]{64}$/i.test(suppliedHash.trim())) {
      throw new Error("Invalid usage apiKeyHash: expected a SHA-256 hex digest");
    }
    apiKeyHash = suppliedHash.trim().toLowerCase();
    if (rawKey && !isMaskedApiKey(rawKey) && apiKeyHash !== hashApiKey(rawKey)) {
      throw new Error("Usage apiKeyHash does not match the plaintext apiKey");
    }
  } else if (isMaskedApiKey(rawKey)) {
    // A display mask cannot recover the original key's identity. Hashing it
    // would invent a different key and corrupt deduplication/name lookup.
    throw new Error("Masked usage apiKey requires apiKeyHash");
  } else if (rawKey) {
    apiKeyHash = hashApiKey(rawKey);
  }
  return { apiKeyMasked: isMaskedApiKey(rawKey) ? rawKey : maskApiKey(rawKey), apiKeyHash };
}

// True when a stored value is already masked (legacy `sk-496f00***` or the
// tail-keeping `sk-496f0***aa00`), so migrations can skip rows that have been
// converted and stay idempotent. Real keys never contain asterisks.
export function isMaskedApiKey(value) {
  return typeof value === "string" && value.includes("***");
}
