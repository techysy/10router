export default {
  version: 8,
  name: "responses-store",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS responsesStore (
        id TEXT NOT NULL,
        apiKeyHash TEXT NOT NULL,
        data TEXT NOT NULL,
        expiresAt INTEGER NOT NULL,
        PRIMARY KEY (id, apiKeyHash)
      )
    `);
    db.exec("CREATE INDEX IF NOT EXISTS idx_responses_store_expires ON responsesStore(expiresAt)");
  },
};
