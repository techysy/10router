import fs from "node:fs";
import initSqlJs from "sql.js";
import { PRAGMA_SQL } from "../schema.js";

let SQL = null;

async function loadSql() {
  if (SQL) return SQL;
  SQL = await initSqlJs();
  return SQL;
}

export async function createSqlJsAdapter(filePath) {
  const SQLLib = await loadSql();
  const buf = fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
  const db = new SQLLib.Database(buf);
  db.exec(PRAGMA_SQL);
  // Schema is created/synced by migrate.js after adapter init

  let dirty = false;
  let saveTimer = null;
  let saveFailures = 0;
  const SAVE_DEBOUNCE_MS = 100;
  const SAVE_RETRY_MAX_MS = 30_000;

  function persist() {
    const data = db.export();
    fs.writeFileSync(filePath, Buffer.from(data));
    dirty = false;
    saveFailures = 0;
  }

  function scheduleSave() {
    dirty = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(runSave, SAVE_DEBOUNCE_MS);
  }

  function runSave() {
    saveTimer = null;
    if (!dirty) return;
    try {
      persist();
    } catch (e) {
      // A lost write is not always harmless. The request path persists rotated
      // refresh tokens through this adapter, and a consumed token left in the
      // DB gets the whole OAuth session revoked on the next request (see
      // persistRefreshedCredentials). Retrying on the next mutation alone means
      // a quiet install that stops writing loses the batch outright — and the
      // write that triggered it has already reported success. Back off rather
      // than spin: a permanently locked file settles at the cap instead of
      // hammering the disk.
      saveFailures += 1;
      const delay = Math.min(SAVE_DEBOUNCE_MS * 2 ** saveFailures, SAVE_RETRY_MAX_MS);
      console.error(`[sqljs] save failed (retrying in ${delay}ms):`, e?.message || e);
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(runSave, delay);
    }
  }

  function paramsObj(params) {
    if (!params || (Array.isArray(params) && params.length === 0)) return undefined;
    return params;
  }

  function run(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(paramsObj(params));
      stmt.step();
      const changes = db.getRowsModified();
      const lastInsertRowid = db.exec("SELECT last_insert_rowid() as id")[0]?.values?.[0]?.[0] ?? null;
      scheduleSave();
      return { changes, lastInsertRowid };
    } finally {
      stmt.free();
    }
  }

  function get(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(paramsObj(params));
      if (stmt.step()) return stmt.getAsObject();
      return undefined;
    } finally {
      stmt.free();
    }
  }

  function all(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(paramsObj(params));
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  function exec(sql) {
    db.exec(sql);
    scheduleSave();
  }

  function transaction(fn) {
    const sp = `sp_${Math.random().toString(36).slice(2)}`;
    db.exec(`SAVEPOINT ${sp}`);
    try {
      const result = fn();
      db.exec(`RELEASE ${sp}`);
      scheduleSave();
      return result;
    } catch (e) {
      try { db.exec(`ROLLBACK TO ${sp}`); db.exec(`RELEASE ${sp}`); } catch {}
      throw e;
    }
  }

  function close() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    // Never throw out of close(): a failed final write must not stop the caller
    // shutting down, but it must not vanish either.
    if (dirty) {
      try { persist(); } catch (e) {
        console.error("[sqljs] final save failed, in-memory changes are lost:", e?.message || e);
      }
    }
    db.close();
  }

  // Flush on shutdown. A silent `catch {}` here hid the exact failure that loses
  // a rotated refresh token at process exit, so log it loudly instead.
  const flush = () => {
    if (!dirty) return;
    try { persist(); } catch (e) {
      console.error("[sqljs] shutdown save failed, in-memory changes are lost:", e?.message || e);
    }
  };
  process.on("beforeExit", flush);
  process.on("SIGINT", flush);
  process.on("SIGTERM", flush);

  return { driver: "sql.js", run, get, all, exec, transaction, close, raw: db };
}
