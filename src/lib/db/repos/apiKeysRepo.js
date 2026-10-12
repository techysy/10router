import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

// Single normalization point for the per-key daily token cap: everything that
// is not a positive integer (null/0/""/NaN/floats) means "unlimited" and is
// stored as NULL. Absurdly large values are clamped rather than rejected so a
// stray paste cannot poison the column; the API routes reject on their edge.
export const DAILY_LIMIT_MAX = 1e12;

export function normalizeDailyLimit(value) {
  if (value === null || value === undefined || value === "" || value === false) return null;
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(n, DAILY_LIMIT_MAX);
}

export function normalizeWhitelist(list) {
  if (!Array.isArray(list)) return null;
  const clean = Array.from(new Set(list.map((s) => String(s || "").trim()).filter(Boolean)));
  return clean.length > 0 ? clean : null;
}

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    dailyTokenLimit: normalizeDailyLimit(row.dailyTokenLimit),
    allowedModels: normalizeWhitelist(parseJson(row.allowedModels, null)),
    allowedCombos: normalizeWhitelist(parseJson(row.allowedCombos, null)),
    createdAt: row.createdAt,
  };
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

export async function createApiKey(name, machineId, dailyTokenLimit = null, allowedModels = null, allowedCombos = null) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = await generateApiKeyWithMachine(machineId);
  const cleanModels = normalizeWhitelist(allowedModels);
  const cleanCombos = normalizeWhitelist(allowedCombos);
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    dailyTokenLimit: normalizeDailyLimit(dailyTokenLimit),
    allowedModels: cleanModels,
    allowedCombos: cleanCombos,
    createdAt: new Date().toISOString(),
  };
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, dailyTokenLimit, allowedModels, allowedCombos, createdAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      apiKey.id,
      apiKey.key,
      apiKey.name,
      apiKey.machineId,
      1,
      apiKey.dailyTokenLimit,
      stringifyJson(cleanModels),
      stringifyJson(cleanCombos),
      apiKey.createdAt,
    ]
  );
  return apiKey;
}

// Full record lookup by plaintext key — the enforcement path needs id/name/limit,
// which validateApiKey() deliberately does not return (its boolean shape is a
// frozen dashboardGuard contract).
export async function getApiKeyByKey(key) {
  if (!key) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [key]);
  return rowToKey(row);
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...data };
    merged.dailyTokenLimit = normalizeDailyLimit(merged.dailyTokenLimit);
    if ("allowedModels" in data) {
      merged.allowedModels = normalizeWhitelist(data.allowedModels);
    }
    if ("allowedCombos" in data) {
      merged.allowedCombos = normalizeWhitelist(data.allowedCombos);
    }
    db.run(
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ?, dailyTokenLimit = ?, allowedModels = ?, allowedCombos = ? WHERE id = ?`,
      [
        merged.key,
        merged.name,
        merged.machineId,
        merged.isActive ? 1 : 0,
        merged.dailyTokenLimit,
        stringifyJson(merged.allowedModels),
        stringifyJson(merged.allowedCombos),
        id,
      ]
    );
    result = merged;
  });
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function validateApiKey(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT isActive FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return false;
  return row.isActive === 1 || row.isActive === true;
}
