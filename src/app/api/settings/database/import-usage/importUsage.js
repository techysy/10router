import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Read usageHistory rows from a 9router/10router SQLite file using node:sqlite
// (Node ≥22.5 built-in, no wasm dependency). The file is written to a temp
// location so it can be opened by node:sqlite (which requires a file path).
export async function readUsageFromSqlite(buffer, filename = "data.sqlite") {
  const tmp = path.join(os.tmpdir(), `10router-usage-import-${Date.now()}-${filename}`);
  try {
    fs.writeFileSync(tmp, Buffer.from(buffer));
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(tmp, { readOnly: true });
    try {
      const stmt = db.prepare(
        `SELECT timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta FROM usageHistory ORDER BY id ASC`
      );
      const rows = [];
      for (const r of stmt.all()) {
        rows.push({
          timestamp: r.timestamp,
          provider: r.provider,
          model: r.model,
          connectionId: r.connectionId,
          apiKey: r.apiKey,
          endpoint: r.endpoint,
          promptTokens: r.promptTokens,
          completionTokens: r.completionTokens,
          cost: r.cost,
          status: r.status,
          tokens: parseJsonField(r.tokens),
          meta: parseJsonField(r.meta),
        });
      }
      return rows;
    } finally {
      db.close();
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore cleanup failures */ }
  }
}

// Parse a 10router JSON backup payload — usageHistory may be embedded under
// `usageHistory` or `usage`. Accepts either.
export function readUsageFromJson(payload) {
  if (!payload || typeof payload !== "object") return [];
  const raw = payload.usageHistory || payload.usage;
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => {
    const tokens = typeof r.tokens === "string" ? parseJsonField(r.tokens) : (r.tokens || {});
    // aggregateEntryToDay only reads tokens.prompt_tokens/completion_tokens —
    // normalize top-level counts so hand-written JSON payloads still aggregate
    // into usageDaily instead of logging 0 tokens for the day.
    if (r.promptTokens != null && tokens.prompt_tokens == null && tokens.input_tokens == null) {
      tokens.prompt_tokens = r.promptTokens;
    }
    if (r.completionTokens != null && tokens.completion_tokens == null && tokens.output_tokens == null) {
      tokens.completion_tokens = r.completionTokens;
    }
    return {
      timestamp: r.timestamp,
      provider: r.provider,
      model: r.model,
      connectionId: r.connectionId,
      apiKey: r.apiKey,
      endpoint: r.endpoint,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      cost: r.cost,
      status: r.status,
      tokens,
      meta: typeof r.meta === "string" ? parseJsonField(r.meta) : (r.meta || {}),
    };
  });
}

export async function importUsageFromSqlite(buffer, filename = "data.sqlite") {
  const rows = await readUsageFromSqlite(buffer, filename);
  if (rows.length === 0) return { imported: 0, skipped: 0, total: 0, source: filename };
  const { importUsageRows } = await import("@/lib/db/repos/usageRepo.js");
  const { imported, skipped } = await importUsageRows(rows);
  return { imported, skipped, total: rows.length, source: filename };
}

export async function importUsageFromJson(payload) {
  const rows = readUsageFromJson(payload);
  if (rows.length === 0) return { imported: 0, skipped: 0, total: 0, source: "json" };
  const { importUsageRows } = await import("@/lib/db/repos/usageRepo.js");
  const { imported, skipped } = await importUsageRows(rows);
  return { imported, skipped, total: rows.length, source: "json" };
}

function parseJsonField(str) {
  if (!str) return {};
  if (typeof str !== "string") return str;
  try { return JSON.parse(str); } catch { return {}; }
}