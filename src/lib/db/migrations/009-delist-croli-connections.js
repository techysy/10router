// Deactivate residual Croli connections after the provider is delisted.
//
// Croli was removed from the registry wholesale on 2026-11-28 (upstream kept
// moving its client-version / risk-control gates; the channel is no longer
// usable). Registry entries are gone, so a residual provider="croli" row no
// longer resolves to its own executor config: DefaultExecutor falls back to
// `PROVIDERS.openai` for the baseUrl, meaning a request still aimed at a croli
// model would send the user's csk_ token to api.openai.com. No data is
// destroyed — the row keeps its credentials; it is only flagged inactive with
// the reason recorded, exactly how a user-toggled "off" connection looks, and
// flipping isActive back on in the UI restores the row (still inert until the
// provider returns).
//
// Idempotent: rows already inactive are left untouched; the framework stamps
// schemaVersion so this runs once. Fail-open: unreadable data blobs are
// skipped. No SCHEMA_VERSION bump — TABLES itself is unchanged, so the
// additive sync and the pre-schema backup trigger do not apply (the versioned
// chain runs independently and is what carries this migration).
const REASON = "croli_delisted_2026-11-28";

export default {
  version: 9,
  name: "delist-croli-connections",
  up(db) {
    let rows;
    try {
      rows = db.all(`SELECT id, isActive, data FROM providerConnections WHERE provider = 'croli'`);
    } catch (err) {
      console.warn("[migration] delist-croli-connections: could not read connections:", err?.message || err);
      return;
    }

    for (const row of rows) {
      try {
        if (row.isActive === 0) continue;
        let data = null;
        try { data = JSON.parse(row.data); } catch { data = null; }
        if (data && typeof data === "object" && !Array.isArray(data)) {
          // Stamp the reason next to the credential, then write both back.
          // Secret fields ride along as their stored `enc:v1` strings — this
          // path never decrypts, so nothing is re-encrypted or lost.
          db.run(
            `UPDATE providerConnections SET isActive = 0, data = ?, updatedAt = ? WHERE id = ?`,
            [JSON.stringify({ ...data, delistReason: REASON }), new Date().toISOString(), row.id],
          );
        } else {
          // Unreadable blob: disable the row (the flag is a column, so the
          // credential bytes stay untouched) rather than overwrite a payload
          // we cannot parse — the same property migration 003 had to learn.
          db.run(
            `UPDATE providerConnections SET isActive = 0, updatedAt = ? WHERE id = ?`,
            [new Date().toISOString(), row.id],
          );
        }
      } catch {
        // Row unusable in some other way — leave it alone; the delisted
        // provider has no refresh handler, so it is never contacted anyway.
      }
    }
  },
};
