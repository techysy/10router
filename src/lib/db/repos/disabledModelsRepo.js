import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const SCOPE = "disabledModels";

// ───────────────────────────────────────────────────────────────────────────
// Key normalisation.
//
// A provider answers to several names: its id, its registry `alias`, its
// `uiAlias`, and anything listed in `aliases[]`. Call sites disagreed about which
// one to store a disabled-model row under — the first-connection default-disable
// used the id (`PROVIDER_ID_TO_ALIAS`), while the dashboard page reads and writes
// the name `getProviderAlias()` gives it (`uiAlias || alias || id`). One provider
// therefore ended up with two rows holding the same ids (`xiaomi-mimo` + `mimo`),
// and a toggle written under one name is invisible to a reader consulting the
// other: a model the user just enabled stays disabled, or vice versa.
//
// So every entry point here resolves its key to the storage name, reads the UNION
// of all names for that provider, and writes a single collapsed row. Reads also
// publish the result under every known name, so a lookup by any of them resolves
// instead of silently reporting "nothing disabled".
// ───────────────────────────────────────────────────────────────────────────

let keyGroups = null;

async function loadKeyGroups() {
  if (keyGroups) return keyGroups;
  const toCanonical = new Map();
  const byCanonical = new Map();
  try {
    const mod = await import("open-sse/providers/registry/index.js");
    const registry = mod.default || mod.REGISTRY || [];
    for (const entry of registry) {
      const canonical = entry.uiAlias || entry.alias || entry.id;
      if (!canonical) continue;
      const names = new Set(
        [entry.id, entry.alias, entry.uiAlias, ...(Array.isArray(entry.aliases) ? entry.aliases : [])].filter(Boolean)
      );
      const group = byCanonical.get(canonical) || new Set();
      for (const name of names) {
        toCanonical.set(name, canonical);
        group.add(name);
      }
      byCanonical.set(canonical, group);
    }
  } catch (error) {
    // A registry hiccup must never break model toggles — fall back to plain keys.
    console.log("Disabled-model key map unavailable:", error?.message || error);
  }
  keyGroups = { toCanonical, byCanonical };
  return keyGroups;
}

/** The single name a provider's disabled-model row is stored under. */
export async function resolveDisabledKey(key) {
  if (!key) return key;
  const { toCanonical } = await loadKeyGroups();
  return toCanonical.get(key) || key;
}

/** All names denoting the same provider as `key`, plus its storage name. */
async function siblingKeys(key) {
  const { toCanonical, byCanonical } = await loadKeyGroups();
  const canonical = toCanonical.get(key) || key;
  const names = byCanonical.get(canonical);
  const keys = new Set(names ? [...names] : []);
  keys.add(key);
  keys.add(canonical);
  return { canonical, keys: [...keys] };
}

/**
 * Every provider's disabled model ids, keyed by the storage name AND by every
 * alias of that provider.
 *
 * When a provider somehow has rows under more than one name, the row under the
 * storage name wins: that is the row the dashboard reads and writes, so it carries
 * the user's latest intent. A legacy row under another name is only consulted when
 * there is no storage-name row at all (otherwise the stale duplicate would undo an
 * include the user just made).
 */
export async function getDisabledModels() {
  const db = await getAdapter();
  const rows = db.all(`SELECT key, value FROM kv WHERE scope = ?`, [SCOPE]);
  const { toCanonical, byCanonical } = await loadKeyGroups();

  const groups = new Map(); // canonical -> { own: Set|null, union: Set }
  for (const r of rows) {
    const canonical = toCanonical.get(r.key) || r.key;
    let group = groups.get(canonical);
    if (!group) {
      group = { own: null, union: new Set() };
      groups.set(canonical, group);
    }
    const ids = parseJson(r.value, []) || [];
    if (r.key === canonical) group.own = new Set(ids);
    for (const id of ids) group.union.add(id);
  }

  const out = {};
  for (const [canonical, group] of groups) {
    const ids = [...(group.own || group.union)];
    out[canonical] = ids;
    const names = byCanonical.get(canonical);
    if (names) for (const name of names) out[name] = ids;
  }
  return out;
}

export async function getDisabledByProvider(providerAlias) {
  if (!providerAlias) return [];
  const all = await getDisabledModels();
  return all[providerAlias] || [];
}

const WRITE_ROW = `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`;
const DELETE_ROW = `DELETE FROM kv WHERE scope = ? AND key = ?`;
const READ_ROW = `SELECT value FROM kv WHERE scope = ? AND key = ?`;

// Sync read used INSIDE a transaction. Mirrors getDisabledModels() precedence —
// the storage-name row wins, legacy sibling rows only fill in when there is no
// storage-name row — without any await, so a concurrent toggle can't slip a
// stale read between the fetch and the merge-write.
function readFresh(db, keys, canonical) {
  let own = null;
  const union = new Set();
  for (const key of keys) {
    const row = db.get(READ_ROW, [SCOPE, key]);
    if (!row) continue;
    const ids = parseJson(row.value, []) || [];
    if (key === canonical) own = ids;
    for (const id of ids) union.add(id);
  }
  return own !== null ? own : [...union];
}

// Alias resolution (async) runs before the transaction; the read-merge-write
// itself is atomic inside it — an earlier version pre-read `current` outside,
// which let two concurrent toggles both merge from the same stale snapshot and
// lose one write.
export async function disableModels(providerAlias, ids) {
  if (!providerAlias || !Array.isArray(ids)) return;
  const db = await getAdapter();
  const { canonical, keys } = await siblingKeys(providerAlias);
  db.transaction(() => {
    const current = readFresh(db, keys, canonical);
    const merged = [...new Set([...current, ...ids])];
    db.run(WRITE_ROW, [SCOPE, canonical, stringifyJson(merged)]);
    // Collapse rows this provider left under another name — otherwise a stale
    // duplicate keeps re-adding ids the user has since enabled.
    for (const key of keys) {
      if (key === canonical) continue;
      db.run(DELETE_ROW, [SCOPE, key]);
    }
  });
}

export async function enableModels(providerAlias, ids) {
  if (!providerAlias) return;
  const db = await getAdapter();
  const { canonical, keys } = await siblingKeys(providerAlias);
  const clearing = !Array.isArray(ids) || ids.length === 0;
  db.transaction(() => {
    let next = [];
    if (!clearing) {
      const removeSet = new Set(ids);
      const current = readFresh(db, keys, canonical);
      next = current.filter((id) => !removeSet.has(id));
    }
    if (next.length === 0) {
      for (const key of keys) db.run(DELETE_ROW, [SCOPE, key]);
      return;
    }
    db.run(WRITE_ROW, [SCOPE, canonical, stringifyJson(next)]);
    for (const key of keys) {
      if (key === canonical) continue;
      db.run(DELETE_ROW, [SCOPE, key]);
    }
  });
}
