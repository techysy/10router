// Check-in ledger repository (see migrations/007-checkin-runs.js).
//
// Status vocabulary is shared by every adapter and by the dashboard:
//   ok          — claimed and verified (amount/balance confirmed)
//   already     — upstream says it was claimed before today
//   no-activity — nothing to claim today (no campaign / not eligible)
//   needs-reauth— credentials are dead; a human must sign in again
//   limited     — rate/quota limited upstream; retry later
//   failed      — anything else (message carries the reason)
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const RETENTION_DAYS = 30;

function rowToRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    connectionId: row.connectionId,
    accountLabel: row.accountLabel,
    day: row.day,
    status: row.status,
    amount: row.amount,
    unit: row.unit,
    before: parseJson(row.beforeJson, null),
    after: parseJson(row.afterJson, null),
    code: row.code,
    message: row.message,
    at: row.at,
  };
}

export async function recordCheckinRun(run) {
  const db = await getAdapter();
  db.run(
    `INSERT INTO checkinRuns
      (provider, connectionId, accountLabel, day, status, amount, unit, beforeJson, afterJson, code, message, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(run.provider || ""),
      run.connectionId ? String(run.connectionId) : null,
      run.accountLabel ? String(run.accountLabel) : null,
      String(run.day || ""),
      String(run.status || "failed"),
      Number.isFinite(run.amount) ? run.amount : null,
      run.unit ? String(run.unit) : null,
      run.before == null ? null : stringifyJson(run.before),
      run.after == null ? null : stringifyJson(run.after),
      run.code == null ? null : String(run.code),
      run.message == null ? null : String(run.message),
      String(run.at || new Date().toISOString()),
    ]
  );
}

/** Has this connection already reached a terminal-ok state today? */
export async function hasCheckinSuccessToday(provider, connectionId, day) {
  const db = await getAdapter();
  const row = db.get(
    `SELECT id FROM checkinRuns
      WHERE provider = ? AND connectionId = ? AND day = ? AND status IN ('ok', 'already', 'no-activity')
      LIMIT 1`,
    [String(provider), String(connectionId), String(day)]
  );
  return !!row;
}

export async function getCheckinRuns({ day = null, provider = null, limit = 200 } = {}) {
  const db = await getAdapter();
  const where = [];
  const params = [];
  if (day) { where.push(`day = ?`); params.push(String(day)); }
  if (provider) { where.push(`provider = ?`); params.push(String(provider)); }
  const sql = `SELECT * FROM checkinRuns
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY at DESC LIMIT ?`;
  params.push(Math.max(1, Math.min(Number(limit) || 200, 1000)));
  return db.all(sql, params).map(rowToRun);
}

/** Per-provider summary for the dashboard (today + last N days). */
export async function getCheckinSummary({ days = 7 } = {}) {
  const db = await getAdapter();
  const since = new Date(Date.now() - Math.max(1, days) * 86400000).toISOString().slice(0, 10);
  const rows = db.all(
    `SELECT provider, status, COUNT(*) AS n, SUM(COALESCE(amount, 0)) AS amount
       FROM checkinRuns WHERE day >= ? GROUP BY provider, status`,
    [since]
  );
  const byProvider = {};
  for (const r of rows) {
    const p = (byProvider[r.provider] ||= { provider: r.provider, counts: {}, amount: 0 });
    p.counts[r.status] = (p.counts[r.status] || 0) + r.n;
    p.amount += Number(r.amount) || 0;
  }
  return { since, providers: Object.values(byProvider) };
}

/** Drop rows older than the retention window (called once per sweep). */
export async function pruneCheckinRuns({ days = RETENTION_DAYS } = {}) {
  const db = await getAdapter();
  const cutoff = new Date(Date.now() - Math.max(1, days) * 86400000).toISOString().slice(0, 10);
  db.run(`DELETE FROM checkinRuns WHERE day < ?`, [cutoff]);
}
