import { getAdapter } from "../driver.js";

export async function getMeta(key, fallback = null) {
  const db = await getAdapter();
  const row = db.get(`SELECT value FROM _meta WHERE key = ?`, [key]);
  return row ? row.value : fallback;
}

export async function setMeta(key, value) {
  const db = await getAdapter();
  db.run(`INSERT INTO _meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, String(value)]);
}

export async function deleteMeta(key) {
  const db = await getAdapter();
  db.run(`DELETE FROM _meta WHERE key = ?`, [key]);
}

// Keys under one prefix, e.g. every `externalQuota.<source>` snapshot. LIKE is
// ASCII-safe for our prefix grammar (sources are [a-z0-9-]); `_`/`%` escaping is
// deliberately omitted — callers pass literal prefixes like "externalQuota." and
// a stray wildcard there would at worst read more _meta rows, never external
// data. Values come back as stored strings; parsing is the caller's job.
export async function listMetaByPrefix(prefix) {
  const db = await getAdapter();
  return db.all(`SELECT key, value FROM _meta WHERE key LIKE ?`, [`${prefix}%`]);
}

// Sync versions for use during migration (adapter passed directly)
export function getMetaSync(adapter, key, fallback = null) {
  const row = adapter.get(`SELECT value FROM _meta WHERE key = ?`, [key]);
  return row ? row.value : fallback;
}

export function setMetaSync(adapter, key, value) {
  adapter.run(`INSERT INTO _meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, String(value)]);
}
