// Check-in run ledger — one row per attempt, per provider connection.
//
// Why a table instead of the per-service "dailyDone" maps: the daily maps only
// answer "did we already try today", not "did the credit actually arrive".
// Sign-in endpoints in this space routinely answer 200 with an empty body, a
// business code, or a templated refusal; the ledger is what lets the dashboard
// show 到账量 and lets verify() reconcile before/after balances.
//
// Rows are append-only; retention is pruned by the scheduler (30 days).
export default {
  version: 7,
  name: "checkin-runs",
  up(db) {
    db.run(`CREATE TABLE IF NOT EXISTS checkinRuns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      connectionId TEXT,
      accountLabel TEXT,
      day TEXT NOT NULL,
      status TEXT NOT NULL,
      amount REAL,
      unit TEXT,
      beforeJson TEXT,
      afterJson TEXT,
      code TEXT,
      message TEXT,
      at TEXT NOT NULL
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idxCheckinRunsDay ON checkinRuns(day)`);
    db.run(`CREATE INDEX IF NOT EXISTS idxCheckinRunsConn ON checkinRuns(provider, connectionId, day)`);
  },
};
