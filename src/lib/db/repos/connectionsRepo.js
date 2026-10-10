import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { getDisabledByProvider, disableModels } from "./disabledModelsRepo.js";
import {
  encryptConnectionData,
  decryptConnectionData,
  restoreUnreadableCredentials,
  UNREADABLE_CREDENTIALS_KEY,
} from "../crypto/credentialCipher.js";

const OPTIONAL_FIELDS = [
  "displayName", "email", "globalPriority", "defaultModel",
  "accessToken", "refreshToken", "expiresAt", "tokenType",
  "scope", "projectId", "apiKey", "testStatus",
  "lastTested", "lastError", "lastErrorAt", "rateLimitedUntil", "expiresIn", "errorCode",
  "consecutiveUseCount", "idToken", "lastRefreshAt",
  "earliestPackageExpiry", "earliestPackageName", "quotaCheckedAt",
];

// Every read and every write of a connection funnels through these two, which is
// what makes credential encryption transparent to the rest of the app (issue #9,
// item 2): `data` is encrypted on the way into SQLite and decrypted on the way
// out, so no caller has to know about it — including the request path that pulls
// a token to call upstream.
function rowToConn(row) {
  if (!row) return null;
  const extra = parseJson(row.data, {});
  const { data: decoded, error, unreadable } = decryptConnectionData(extra);
  if (error) {
    // Loud but not fatal: surface it on the row the dashboard already renders
    // instead of throwing from every read (which would take the whole app down
    // when a database is restored without its key file).
    const synthesized = { testStatus: "unavailable", lastError: `Credentials unreadable: ${error}` };
    Object.assign(decoded, synthesized);
    // …and NOT destructive: the ciphertext travels with the object so that any
    // write built from it (startup cleanup, error-state updates, refresh
    // merges) puts it back into the row instead of erasing it. See
    // restoreUnreadableCredentials() — applied in connToRow.
    decoded[UNREADABLE_CREDENTIALS_KEY] = { ...unreadable, synthesized };
  }
  return {
    ...decoded,
    id: row.id,
    provider: row.provider,
    authType: row.authType,
    name: row.name,
    email: row.email,
    priority: row.priority,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function connToRow(c) {
  const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;
  // Fold any ciphertext that could not be decrypted on read back into the row
  // (and strip the reserved carrier key + the synthesized failure state) BEFORE
  // encrypting. encryptSecret is idempotent on enc:v1: values, so a restored
  // ciphertext passes through untouched — the row keeps the credential instead
  // of losing it when the current key can't read it.
  const restored = restoreUnreadableCredentials(rest);
  return {
    id,
    provider,
    authType,
    name: name ?? null,
    email: email ?? null,
    priority: priority ?? null,
    isActive: isActive === false ? 0 : 1,
    data: stringifyJson(encryptConnectionData(restored)),
    createdAt,
    updatedAt,
  };
}

function upsert(db, c) {
  const r = connToRow(c);
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       provider=excluded.provider, authType=excluded.authType, name=excluded.name,
       email=excluded.email, priority=excluded.priority, isActive=excluded.isActive,
       data=excluded.data, updatedAt=excluded.updatedAt`,
    [r.id, r.provider, r.authType, r.name, r.email, r.priority, r.isActive, r.data, r.createdAt, r.updatedAt]
  );
}

function deriveConnectionName(data, fallbackName) {
  if (data.provider === "github") {
    return data.providerSpecificData?.githubLogin
      || data.providerSpecificData?.githubEmail
      || data.email
      || data.providerSpecificData?.githubName
      || fallbackName;
  }
  return fallbackName;
}

export async function getProviderConnections(filter = {}) {
  const db = await getAdapter();
  const where = [];
  const params = [];
  if (filter.provider) { where.push("provider = ?"); params.push(filter.provider); }
  if (filter.isActive !== undefined) { where.push("isActive = ?"); params.push(filter.isActive ? 1 : 0); }
  const sql = `SELECT * FROM providerConnections${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  const rows = db.all(sql, params);
  const list = rows.map(rowToConn);
  list.sort((a, b) => (a.priority || 999) - (b.priority || 999));
  return list;
}

export async function getProviderConnectionById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]);
  return rowToConn(row);
}

// Internal sync reorder — must be called INSIDE a transaction.
//
// Normalizes priorities to a contiguous 1..N after a DELETE or an explicit
// reorder, so gaps don't accumulate over time.
//
// Deliberately NOT called on insert: a new connection already gets
// MAX(priority)+1, which sorts after every existing row, so the order is
// identical with or without the rewrite. Skipping it there is what makes
// bulk key import O(1) per key instead of O(pool) — see createProviderConnection.
function reorderInTx(db, providerId) {
  const list = db.all(`SELECT * FROM providerConnections WHERE provider = ?`, [providerId]).map(rowToConn);
  list.sort((a, b) => {
    const pDiff = (a.priority || 0) - (b.priority || 0);
    if (pDiff !== 0) return pDiff;
    return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  });
  list.forEach((c, i) => {
    const want = i + 1;
    if ((c.priority || 0) !== want) {
      db.run(`UPDATE providerConnections SET priority = ? WHERE id = ?`, [want, c.id]);
    }
  });
}

export async function createProviderConnection(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  let result;

  let isFirstConnection = false;
  db.transaction(() => {
    // apikey connections are deduped by name and need only the current max
    // priority, so query those directly instead of loading the whole pool
    // (O(pool) per key — bulk key imports were O(n·m) and serialized every
    // parallel writer on this transaction). The oauth branch below still
    // scans, because its identity rules compare fields inside
    // providerSpecificData and have no single-column equivalent.
    const isApikey = data.authType === "apikey" && !!data.name;
    const all = isApikey
      ? db.all(
          `SELECT * FROM providerConnections WHERE provider = ? AND authType = ? AND name = ?`,
          [data.provider, "apikey", data.name]
        ).map(rowToConn)
      : db.all(`SELECT * FROM providerConnections WHERE provider = ?`, [data.provider]).map(rowToConn);
    // isFirstConnection and "Account N" naming need the POOL size, not the
    // dedup-candidate count — for the apikey path `all` is narrowed to
    // same-name rows only.
    const poolSize = isApikey
      ? db.get(`SELECT COUNT(*) AS n FROM providerConnections WHERE provider = ?`, [data.provider])?.n ?? all.length
      : all.length;
    isFirstConnection = poolSize === 0;

    let existing = null;
    if (data.authType === "oauth" && data.email) {
      const incomingUsername = data.providerSpecificData?.username;
      const incomingWs = data.providerSpecificData?.chatgptAccountId;
      existing = all.find(c => {
        if (c.authType !== "oauth" || c.email !== data.email) return false;

        // Codex/OpenAI can issue multiple OAuth grants for the same email.
        // Refresh tokens are rotated single-use; collapsing a new login onto an
        // existing bare-email row overwrites the first account's token pair and
        // makes it look "invalid" after adding a second account. Only update an
        // existing Codex row when both rows expose the same ChatGPT account ID.
        if (data.provider === "codex") {
          const existingWs = c.providerSpecificData?.chatgptAccountId;
          return !!incomingWs && !!existingWs && incomingWs === existingWs;
        }

        // Workspace providers use workspace ID when both sides have it
        const existingWs = c.providerSpecificData?.chatgptAccountId;
        if (incomingWs && existingWs) return incomingWs === existingWs;
        if (incomingWs && !existingWs) return false;
        if (!incomingWs && existingWs) return false;
        // Non-workspace providers: match on (email + username) so cross-IdP
        // accounts don't overwrite each other. Require username on both sides
        // — if only one side has it, treat as a distinct identity rather than
        // collapsing onto the bare-email fallback (which would re-introduce
        // the cross-IdP overwrite).
        const existingUsername = c.providerSpecificData?.username;
        if (incomingUsername && existingUsername) {
          return incomingUsername === existingUsername;
        }
        if (incomingUsername || existingUsername) return false;
        return true;
      });
    } else if (data.authType === "apikey" && data.name) {
      existing = all.find(c => c.authType === "apikey" && c.name === data.name);
    }
    // access_token: never dedup — user manages duplicates manually

    if (existing) {
      // Name collision on an apikey connection used to silently replace the
      // stored apiKey, so a script that reused names ("Key 1", "Key 2", …)
      // destroyed existing pool entries with no 409 and no warning. Callers
      // that genuinely mean "update this one" pass allowOverwrite; everyone
      // else gets a typed error naming the row that would have been replaced.
      if (data.allowOverwrite === false) {
        const err = new Error(
          `A connection named "${existing.name}" already exists for provider "${data.provider}". ` +
          `Pass allowOverwrite: true to replace it.`
        );
        err.code = "PROVIDER_NAME_CONFLICT";
        err.existingId = existing.id;
        err.existingName = existing.name;
        throw err;
      }
      const merged = { ...existing, ...data, updatedAt: now };
      // Re-provisioned credentials merged onto an existing row: the stored
      // failure belongs to the superseded key/token — drop it so the red
      // dashboard error is consumed by the re-auth itself, not only by the
      // next successful request. Explicit values in `data` still win.
      for (const f of ["lastError", "lastErrorAt", "errorCode"]) {
        if (data[f] === undefined) merged[f] = null;
      }
      if (data.testStatus === undefined && merged.testStatus === "unavailable") merged.testStatus = "active";
      // …same for the needs-reauth mark: the credentials being merged in ARE the
      // re-auth, so both the sticky mark and its cooldown stamp are consumed by
      // this write — a fresh token must not keep sitting behind a 24h skip.
      if (data.testStatus === undefined && merged.testStatus === "needs-reauth") {
        merged.testStatus = "active";
        merged.needsReauthUntil = null;
      }
      upsert(db, merged);
      result = merged;
      return;
    }

    let connectionName = data.name || null;
    if (!connectionName && (data.authType === "oauth" || data.authType === "access_token")) {
      connectionName = deriveConnectionName(data, data.email || `Account ${poolSize + 1}`);
    }
    let connectionPriority = data.priority;
    if (!connectionPriority) {
      // MAX(priority)+1 in SQL rather than a reduce over the loaded pool: the
      // apikey path no longer has the whole pool in memory, and the aggregate
      // is served by the index instead of a row scan.
      const maxRow = db.get(`SELECT MAX(priority) AS m FROM providerConnections WHERE provider = ?`, [data.provider]);
      connectionPriority = (maxRow?.m || 0) + 1;
    }

    const conn = {
      id: uuidv4(),
      provider: data.provider,
      authType: data.authType || "oauth",
      name: connectionName,
      priority: connectionPriority,
      isActive: data.isActive !== undefined ? data.isActive : true,
      createdAt: now,
      updatedAt: now,
    };
    for (const f of OPTIONAL_FIELDS) {
      if (data[f] !== undefined && data[f] !== null) conn[f] = data[f];
    }
    if (data.providerSpecificData && Object.keys(data.providerSpecificData).length > 0) {
      conn.providerSpecificData = data.providerSpecificData;
    }
    if (data.email !== undefined) conn.email = data.email;

    upsert(db, conn);
    // No reorderInTx here. `conn.priority` is already MAX(priority)+1, so the
    // row sorts last and the resulting order is what reorderInTx would have
    // produced anyway. The rewrite cost ~2N statements per insert — O(pool) —
    // which made a 5k-key import O(n·m): ~25M statements at a 5k pool, and it
    // serialized every parallel writer on the same transaction.
    result = conn;
  });

  // Default posture on a provider's FIRST connection: every built-in LLM model
  // starts disabled and the user enables what they need (same philosophy as the
  // JSON catalog's "new models default disabled"). Only fires when the provider
  // had no connections at all, so existing installs and added accounts keep
  // their current model config; deleting every connection and re-adding one
  // deliberately re-applies the default. Skipped if the user already has a
  // disabledModels entry for the alias (they've touched the model config).
  if (isFirstConnection && result) {
    try {
      const { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS } = await import("open-sse/config/providerModels.js");
      const alias = PROVIDER_ID_TO_ALIAS[data.provider] || data.provider;
      const staticModels = PROVIDER_MODELS[alias] || [];
      const llmIds = staticModels
        .filter((m) => !m.kind || m.kind === "llm")
        .map((m) => m.id);
      if (llmIds.length > 0) {
        const existing = await getDisabledByProvider(alias);
        if (existing.length === 0) await disableModels(alias, llmIds);
      }
    } catch (error) {
      // Fail-open: a registry hiccup must never block adding a connection.
      console.log("Default-disable init skipped:", error?.message || error);
    }
  }

  return result;
}

// Critical: OAuth refresh token race — atomic merge inside transaction
export async function updateProviderConnection(id, data) {
  const db = await getAdapter();
  let result;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM providerConnections WHERE id = ?`, [id]);
    if (!row) { result = null; return; }
    const existing = rowToConn(row);
    const merged = { ...existing, ...data, updatedAt: new Date().toISOString() };
    // Opt-in "credentials were replaced" reset. A stored failure belongs to the
    // OLD credential set — once the user re-adds a key / re-authorizes, the red
    // dashboard error is stale and must not linger until the next successful
    // request. Explicit error fields in `data` still win (e.g. a failed
    // validation may pass its own testStatus).
    if ("resetErrorState" in merged) {
      const shouldReset = merged.resetErrorState === true;
      delete merged.resetErrorState;
      if (shouldReset) {
        const reset = { lastError: null, lastErrorAt: null, errorCode: null, testStatus: null, needsReauthUntil: null };
        for (const f of Object.keys(reset)) {
          if (data[f] !== undefined) delete reset[f];
        }
        Object.assign(merged, reset);
      }
    }
    upsert(db, merged);
    if (data.priority !== undefined) reorderInTx(db, existing.provider);
    result = merged;
  });
  return result;
}

export async function deleteProviderConnection(id) {
  const db = await getAdapter();
  let ok = false;
  db.transaction(() => {
    const row = db.get(`SELECT provider FROM providerConnections WHERE id = ?`, [id]);
    if (!row) return;
    db.run(`DELETE FROM providerConnections WHERE id = ?`, [id]);
    reorderInTx(db, row.provider);
    ok = true;
  });
  return ok;
}

export async function deleteProviderConnectionsByProvider(providerId) {
  const db = await getAdapter();
  const before = db.get(`SELECT COUNT(*) AS n FROM providerConnections WHERE provider = ?`, [providerId]);
  db.run(`DELETE FROM providerConnections WHERE provider = ?`, [providerId]);
  return before?.n || 0;
}

export async function reorderProviderConnections(providerId) {
  const db = await getAdapter();
  db.transaction(() => reorderInTx(db, providerId));
}

export async function cleanupProviderConnections() {
  const db = await getAdapter();
  const fieldsToCheck = [
    "displayName", "email", "globalPriority", "defaultModel",
    "accessToken", "refreshToken", "expiresAt", "tokenType",
    "scope", "projectId", "apiKey", "testStatus",
    "lastTested", "lastError", "lastErrorAt", "rateLimitedUntil", "expiresIn",
    "consecutiveUseCount",
  ];
  let cleaned = 0;
  db.transaction(() => {
    const rows = db.all(`SELECT * FROM providerConnections`);
    for (const row of rows) {
      const conn = rowToConn(row);
      let dirty = false;
      for (const f of fieldsToCheck) {
        if (conn[f] === null || conn[f] === undefined) {
          if (f in conn) { delete conn[f]; cleaned++; dirty = true; }
        }
      }
      if (conn.providerSpecificData && Object.keys(conn.providerSpecificData).length === 0) {
        delete conn.providerSpecificData;
        cleaned++;
        dirty = true;
      }
      if (dirty) upsert(db, conn);
    }
  });
  return cleaned;
}
