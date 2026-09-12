import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";

const aliasKv = makeKv("modelAliases");
const customKv = makeKv("customModels");
const mitmKv = makeKv("mitmAlias");

// modelAliases: key=alias, value=modelString
export async function getModelAliases() {
  return await aliasKv.getAll();
}

export async function setModelAlias(alias, model) {
  await aliasKv.set(alias, model);
}

export async function deleteModelAlias(alias) {
  await aliasKv.remove(alias);
}

// customModels: key=`${providerAlias}|${id}|${type}`, value=full model object
function customKey(providerAlias, id, type) {
  return `${providerAlias}|${id}|${type}`;
}

export async function getCustomModels() {
  const all = await customKv.getAll();
  return Object.values(all);
}

// Atomic check-then-insert inside transaction to prevent duplicate races.
// UPDATE merges: callers may pass only `enabled` (toggle) — an earlier version
// overwrote the whole row, silently resetting `name` to the id and dropping
// capability fields (vision/contextWindow/…) on every toggle.
export async function addCustomModel({ providerAlias, id, type = "llm", name, vision, reasoning, contextWindow, maxOutput, thinkingFormat, enabled }) {
  const k = customKey(providerAlias, id, type);
  const db = await getAdapter();
  let added = false;
  const patch = {
    ...(name === undefined ? {} : { name }),
    ...(enabled === undefined ? {} : { enabled }),
    ...(vision === undefined ? {} : { vision }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutput === undefined ? {} : { maxOutput }),
    ...(thinkingFormat === undefined ? {} : { thinkingFormat }),
  };
  db.transaction(() => {
    const row = db.get(`SELECT 1 FROM kv WHERE scope = 'customModels' AND key = ?`, [k]);
    if (row) {
      const prev = parseJson(db.get(`SELECT value FROM kv WHERE scope = 'customModels' AND key = ?`, [k])?.value, {}) || {};
      db.run(`UPDATE kv SET value = ? WHERE scope = 'customModels' AND key = ?`, [stringifyJson({ ...prev, ...patch }), k]);
      return;
    }
    const value = stringifyJson({ providerAlias, id, type, name: name || id, ...patch });
    db.run(`INSERT INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, value]);
    added = true;
  });
  return added;
}

/**
 * Bulk enable/disable for a provider's custom models. `ids` (optional) limits
 * the rows touched; omit it to flip every custom model of that provider+type.
 * Rows missing an `enabled` field are treated as enabled (historical default),
 * so disabling writes `enabled: false` explicitly.
 * Returns the number of rows updated.
 */
export async function setCustomModelsEnabled({ providerAlias, type = "llm", enabled, ids = null }) {
  if (!providerAlias || typeof enabled !== "boolean") return 0;
  const db = await getAdapter();
  const idSet = Array.isArray(ids) && ids.length > 0 ? new Set(ids) : null;
  let updated = 0;
  db.transaction(() => {
    const rows = db.all(
      `SELECT key, value FROM kv WHERE scope = 'customModels' AND key LIKE ?`,
      [`${providerAlias}|%|${type}`],
    );
    for (const row of rows) {
      const model = parseJson(row.value, {}) || {};
      if (idSet && !idSet.has(model.id)) continue;
      if (model.enabled === enabled) continue;
      db.run(`UPDATE kv SET value = ? WHERE scope = 'customModels' AND key = ?`, [stringifyJson({ ...model, enabled }), row.key]);
      updated += 1;
    }
  });
  return updated;
}

export async function deleteCustomModel({ providerAlias, id, type = "llm" }) {
  await customKv.remove(customKey(providerAlias, id, type));
}

// Remove every custom model registered under a providerAlias (used when a custom
// provider node is deleted — its customModels would otherwise linger in the kv
// table and pollute /v1/models with orphan entries pointing at a gone node).
// Key format: `${providerAlias}|${id}|${type}` so a prefix match clears them all.
export async function deleteCustomModelsByProvider(providerAlias) {
  const db = await getAdapter();
  db.run(`DELETE FROM kv WHERE scope = 'customModels' AND key LIKE ?`, [`${providerAlias}|%`]);
}

// mitmAlias: key=toolName, value=mappings object
export async function getMitmAlias(toolName) {
  if (toolName) {
    const v = await mitmKv.get(toolName);
    return v || {};
  }
  return await mitmKv.getAll();
}

export async function setMitmAliasAll(toolName, mappings) {
  await mitmKv.set(toolName, mappings || {});
}
