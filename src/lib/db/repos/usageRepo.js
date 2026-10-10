import { EventEmitter } from "events";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { getMeta, setMeta } from "../helpers/metaStore.js";
import { maskApiKey, hashApiKey } from "../crypto/apiKeyIdentity.js";
import { APP_CONFIG } from "../../../shared/constants/config.js";

const PENDING_TIMEOUT_MS = 60 * 1000;
const RING_CAP = 50;
const CONN_CACHE_TTL_MS = 30 * 1000;
const PERIOD_MS = { "24h": 86400000, "7d": 604800000, "30d": 2592000000, "60d": 5184000000 };

// In-memory state shared across Next.js modules
if (!global._pendingRequests) global._pendingRequests = { byModel: {}, byAccount: {} };
if (!global._lastErrorProvider) global._lastErrorProvider = { provider: "", ts: 0 };
if (!global._statsEmitter) {
  global._statsEmitter = new EventEmitter();
  global._statsEmitter.setMaxListeners(50);
}
if (!global._pendingTimers) global._pendingTimers = {};
if (!global._recentRing) global._recentRing = { items: [], initialized: false };
if (!global._connectionMapCache) global._connectionMapCache = { map: {}, ts: 0 };
if (!global._statsEmitTimers) global._statsEmitTimers = { pending: null, update: null };

const pendingRequests = global._pendingRequests;
const lastErrorProvider = global._lastErrorProvider;
const pendingTimers = global._pendingTimers;
const recentRing = global._recentRing;
const connCache = global._connectionMapCache;
const statsEmitTimers = global._statsEmitTimers;

export const statsEmitter = global._statsEmitter;

function scheduleStatsEvent(event, delayMs = 150) {
  const key = event === "update" ? "update" : "pending";
  if (statsEmitTimers[key]) return;
  statsEmitTimers[key] = setTimeout(() => {
    statsEmitTimers[key] = null;
    statsEmitter.emit(event);
  }, delayMs);
  statsEmitTimers[key]?.unref?.();
}

function getLocalDateKey(timestamp) {
  const d = timestamp ? new Date(timestamp) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addToCounter(target, key, values) {
  if (!target[key]) target[key] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
  target[key].requests += values.requests || 1;
  target[key].promptTokens += values.promptTokens || 0;
  target[key].completionTokens += values.completionTokens || 0;
  target[key].cachedTokens += values.cachedTokens || 0;
  target[key].cost += values.cost || 0;
  if (values.meta) Object.assign(target[key], values.meta);
}

function aggregateEntryToDay(day, entry) {
  const promptTokens = entry.tokens?.prompt_tokens || entry.tokens?.input_tokens || 0;
  const completionTokens = entry.tokens?.completion_tokens || entry.tokens?.output_tokens || 0;
  const cachedTokens = entry.tokens?.cached_tokens || entry.tokens?.cache_read_input_tokens || 0;
  const cost = entry.cost || 0;
  const vals = { promptTokens, completionTokens, cachedTokens, cost };

  day.requests = (day.requests || 0) + 1;
  day.promptTokens = (day.promptTokens || 0) + promptTokens;
  day.completionTokens = (day.completionTokens || 0) + completionTokens;
  day.cachedTokens = (day.cachedTokens || 0) + cachedTokens;
  day.cost = (day.cost || 0) + cost;

  day.byProvider ||= {};
  day.byModel ||= {};
  day.byAccount ||= {};
  day.byApiKey ||= {};
  day.byEndpoint ||= {};

  if (entry.provider) addToCounter(day.byProvider, entry.provider, vals);

  const modelKey = entry.provider ? `${entry.model}|${entry.provider}` : entry.model;
  addToCounter(day.byModel, modelKey, { ...vals, meta: { rawModel: entry.model, provider: entry.provider } });

  if (entry.connectionId) {
    addToCounter(day.byAccount, entry.connectionId, { ...vals, meta: { rawModel: entry.model, provider: entry.provider } });
  }

  const apiKeyVal = entry.apiKey && typeof entry.apiKey === "string" ? entry.apiKey : "local-no-key";
  // The counter KEY used to embed the raw key, and the aggregate it builds is
  // persisted in usageDaily — so the key had to change too, not just the meta.
  // Nothing outside this module reads these keys (the UI reads the assembled
  // `stats.byApiKey`, whose entries carry keyName/apiKeyMasked).
  const apiKeyHash = hashApiKey(entry.apiKey);
  const akModelKey = `${apiKeyHash || "local-no-key"}|${entry.model}|${entry.provider || "unknown"}`;
  // The per-day aggregate ends up in the database too (usageDaily.data), so it
  // carries the same identity as a row: a digest for grouping and lookup, a
  // masked value for display — never the key itself.
  addToCounter(day.byApiKey, akModelKey, {
    ...vals,
    meta: {
      rawModel: entry.model,
      provider: entry.provider,
      apiKeyHash,
      apiKeyMasked: maskApiKey(entry.apiKey),
    },
  });

  const endpoint = entry.endpoint || "Unknown";
  const epKey = `${endpoint}|${entry.model}|${entry.provider || "unknown"}`;
  addToCounter(day.byEndpoint, epKey, { ...vals, meta: { endpoint, rawModel: entry.model, provider: entry.provider } });
}

function pushToRing(entry) {
  recentRing.items.push(entry);
  if (recentRing.items.length > RING_CAP) {
    recentRing.items = recentRing.items.slice(-RING_CAP);
  }
}

async function getConnectionMapCached() {
  if (Date.now() - connCache.ts < CONN_CACHE_TTL_MS) return connCache.map;
  try {
    const { getProviderConnections } = await import("./connectionsRepo.js");
    const all = await getProviderConnections();
    const map = {};
    for (const c of all) map[c.id] = c.name || c.email || c.id;
    connCache.map = map;
    connCache.ts = Date.now();
  } catch {}
  return connCache.map;
}

async function ensureRingInitialized() {
  if (recentRing.initialized) return;
  recentRing.initialized = true;
  try {
    const db = await getAdapter();
    const rows = db.all(`SELECT timestamp, provider, model, connectionId, apiKey, endpoint, cost, status, tokens FROM usageHistory ORDER BY id DESC LIMIT ?`, [RING_CAP]);
    recentRing.items = rows.reverse().map((r) => ({
      timestamp: r.timestamp, provider: r.provider, model: r.model, connectionId: r.connectionId,
      apiKey: r.apiKey, endpoint: r.endpoint, cost: r.cost, status: r.status,
      tokens: parseJson(r.tokens, {}),
    }));
  } catch {}
}

async function calculateCost(provider, model, tokens) {
  if (!tokens || !provider || !model) return 0;
  try {
    const { getPricingForModel } = await import("./pricingRepo.js");
    const pricing = await getPricingForModel(provider, model);
    if (!pricing) return 0;

    // Delegate the actual math to the single source of truth (avoids the two
    // copies drifting apart — see open-sse/providers/pricing.js for the
    // cache-inclusive prompt_tokens convention this assumes).
    const { calculateCostFromTokens } = await import("open-sse/providers/pricing.js");
    return calculateCostFromTokens(tokens, pricing);
  } catch (e) {
    console.error("Error calculating cost:", e);
    return 0;
  }
}

export function trackPendingRequest(model, provider, connectionId, started, error = false) {
  const modelKey = provider ? `${model} (${provider})` : model;
  const timerKey = `${connectionId}|${modelKey}`;

  if (!pendingRequests.byModel[modelKey]) pendingRequests.byModel[modelKey] = 0;
  pendingRequests.byModel[modelKey] = Math.max(0, pendingRequests.byModel[modelKey] + (started ? 1 : -1));
  if (pendingRequests.byModel[modelKey] === 0) delete pendingRequests.byModel[modelKey];

  if (connectionId) {
    if (!pendingRequests.byAccount[connectionId]) pendingRequests.byAccount[connectionId] = {};
    if (!pendingRequests.byAccount[connectionId][modelKey]) pendingRequests.byAccount[connectionId][modelKey] = 0;
    pendingRequests.byAccount[connectionId][modelKey] = Math.max(0, pendingRequests.byAccount[connectionId][modelKey] + (started ? 1 : -1));
    if (pendingRequests.byAccount[connectionId][modelKey] === 0) {
      delete pendingRequests.byAccount[connectionId][modelKey];
      if (Object.keys(pendingRequests.byAccount[connectionId]).length === 0) {
        delete pendingRequests.byAccount[connectionId];
      }
    }
  }

  if (started) {
    clearTimeout(pendingTimers[timerKey]);
    pendingTimers[timerKey] = setTimeout(() => {
      delete pendingTimers[timerKey];
      if (pendingRequests.byModel[modelKey] > 0) pendingRequests.byModel[modelKey] = 0;
      if (connectionId && pendingRequests.byAccount[connectionId]?.[modelKey] > 0) {
        pendingRequests.byAccount[connectionId][modelKey] = 0;
      }
      scheduleStatsEvent("pending");
    }, PENDING_TIMEOUT_MS);
  } else {
    clearTimeout(pendingTimers[timerKey]);
    delete pendingTimers[timerKey];
  }

  if (!started && error && provider) {
    lastErrorProvider.provider = provider.toLowerCase();
    lastErrorProvider.ts = Date.now();
  }

  // [PENDING] console line removed; lifecycle is visible via "▶" and "📊 done" lines
  scheduleStatsEvent("pending");
}

export async function getActiveRequests() {
  const activeRequests = [];
  const connectionMap = await getConnectionMapCached();

  for (const [connectionId, models] of Object.entries(pendingRequests.byAccount)) {
    for (const [modelKey, count] of Object.entries(models)) {
      if (count > 0) {
        const accountName = connectionMap[connectionId] || `Account ${connectionId.slice(0, 8)}...`;
        const match = modelKey.match(/^(.*) \((.*)\)$/);
        activeRequests.push({
          model: match ? match[1] : modelKey,
          provider: match ? match[2] : "unknown",
          account: accountName, count,
        });
      }
    }
  }

  await ensureRingInitialized();
  const seen = new Set();
  const recentRequests = [...recentRing.items]
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .map((e) => {
      const t = e.tokens || {};
      return {
        timestamp: e.timestamp, model: e.model, provider: e.provider || "",
        promptTokens: t.prompt_tokens || t.input_tokens || 0,
        completionTokens: t.completion_tokens || t.output_tokens || 0,
        status: e.status || "ok",
      };
    })
    .filter((e) => {
      if (e.promptTokens === 0 && e.completionTokens === 0) return false;
      const minute = e.timestamp ? e.timestamp.slice(0, 16) : "";
      const key = `${e.model}|${e.provider}|${e.promptTokens}|${e.completionTokens}|${minute}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);

  const errorProvider = (Date.now() - lastErrorProvider.ts < 10000) ? lastErrorProvider.provider : "";
  return { activeRequests, recentRequests, errorProvider };
}

export async function saveRequestUsage(entry) {
  try {
    const db = await getAdapter();

    if (!entry.timestamp) entry.timestamp = new Date().toISOString();
    entry.cost = await calculateCost(entry.provider, entry.model, entry.tokens);
    const tokens = entry.tokens || {};
    const promptTokens = tokens.prompt_tokens || tokens.input_tokens || 0;
    const completionTokens = tokens.completion_tokens || tokens.output_tokens || 0;

    let inserted = false;

    // All 3 writes (history insert, daily upsert, lifetime counter) in ONE transaction.
    // better-sqlite3 is sync → no JS yield mid-transaction → no race in same process.
    db.transaction(() => {
      const existing = db.get(
        `SELECT id, endpoint, meta FROM usageHistory
         WHERE timestamp = ?
           AND COALESCE(provider, '') = COALESCE(?, '')
           AND COALESCE(model, '') = COALESCE(?, '')
           AND COALESCE(connectionId, '') = COALESCE(?, '')
           AND COALESCE(apiKeyHash, '') = COALESCE(?, '')
           AND promptTokens = ?
           AND completionTokens = ?
         ORDER BY id DESC LIMIT 1`,
        [
          entry.timestamp, entry.provider || null, entry.model || null,
          entry.connectionId || null, hashApiKey(entry.apiKey),
          promptTokens, completionTokens,
        ]
      );

      if (existing) {
        // usageKey contract: callers stamp one per upstream attempt (see the
        // saveUsageStats call sites). Content alone cannot tell apart two
        // distinct requests that landed in the same millisecond with identical
        // token counts — the legacy content-only dedup silently ate those
        // (history row + daily aggregate + lifetime counter). Keyed entries
        // dedup only on the same key; keyless callers keep the legacy behavior.
        const existingKey = parseJson(existing.meta, {}).usageKey || "";
        if (!entry.usageKey || existingKey === entry.usageKey) {
          if (!existing.endpoint && entry.endpoint) {
            db.run(`UPDATE usageHistory SET endpoint = ? WHERE id = ?`, [entry.endpoint, existing.id]);
          }
          return;
        }
        // Same content, different attempt — fall through and count it.
      }

      db.run(
        `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, apiKeyHash, endpoint, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.timestamp, entry.provider || null, entry.model || null,
          entry.connectionId || null, maskApiKey(entry.apiKey), hashApiKey(entry.apiKey), entry.endpoint || null,
          promptTokens, completionTokens, entry.cost || 0, entry.status || "ok",
          // meta carries caller extras (executor latency observation, etc.)
          // plus the dedup usageKey. The usageKey previously DISCARDED any
          // entry.meta — the latency observation would never reach the row.
          stringifyJson(tokens), stringifyJson({
            ...(entry.meta && typeof entry.meta === "object" ? entry.meta : {}),
            ...(entry.usageKey ? { usageKey: entry.usageKey } : {}),
          }),
        ]
      );

      const dateKey = getLocalDateKey(entry.timestamp);
      const row = db.get(`SELECT data FROM usageDaily WHERE dateKey = ?`, [dateKey]);
      const day = row ? parseJson(row.data, {}) : {
        requests: 0, promptTokens: 0, completionTokens: 0, cost: 0,
        byProvider: {}, byModel: {}, byAccount: {}, byApiKey: {}, byEndpoint: {},
      };
      aggregateEntryToDay(day, entry);
      db.run(`INSERT INTO usageDaily(dateKey, data) VALUES(?, ?) ON CONFLICT(dateKey) DO UPDATE SET data = excluded.data`, [dateKey, stringifyJson(day)]);

      // Atomic counter increment in same transaction
      const cur = db.get(`SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'`);
      const next = (cur ? parseInt(cur.value, 10) : 0) + 1;
      db.run(`INSERT INTO _meta(key, value) VALUES('totalRequestsLifetime', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(next)]);
      inserted = true;
    });

    if (inserted) {
      pushToRing(entry);
      scheduleStatsEvent("update", 250);
    }
  } catch (e) {
    console.error("Failed to save usage stats:", e);
  }
}

export async function getUsageHistory(filter = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];

  if (filter.provider) { conds.push("provider = ?"); params.push(filter.provider); }
  if (filter.model) { conds.push("model = ?"); params.push(filter.model); }
  if (filter.startDate) { conds.push("timestamp >= ?"); params.push(new Date(filter.startDate).toISOString()); }
  if (filter.endDate) { conds.push("timestamp <= ?"); params.push(new Date(filter.endDate).toISOString()); }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const rows = db.all(`SELECT timestamp, provider, model, connectionId, apiKey, endpoint, cost, status, tokens FROM usageHistory ${where} ORDER BY id ASC`, params);

  return rows.map((r) => ({
    timestamp: r.timestamp, provider: r.provider, model: r.model,
    connectionId: r.connectionId, apiKeyMasked: maskApiKey(r.apiKey), endpoint: r.endpoint,
    cost: r.cost, status: r.status, tokens: parseJson(r.tokens, {}),
  }));
}

function loadDaysInRange(adapter, maxDays) {
  if (maxDays == null) {
    return adapter.all(`SELECT dateKey, data FROM usageDaily ORDER BY dateKey ASC`);
  }
  const today = new Date();
  const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - maxDays + 1);
  const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;
  return adapter.all(`SELECT dateKey, data FROM usageDaily WHERE dateKey >= ? ORDER BY dateKey ASC`, [cutoffKey]);
}

export async function getUsageStats(period = "all") {
  const db = await getAdapter();

  const [{ getProviderConnections }, { getApiKeys }, { getProviderNodes }] = await Promise.all([
    import("./connectionsRepo.js"),
    import("./apiKeysRepo.js"),
    import("./nodesRepo.js"),
  ]);

  let allConnections = [];
  try { allConnections = await getProviderConnections(); } catch {}
  const connectionMap = {};
  for (const c of allConnections) connectionMap[c.id] = c.name || c.email || c.id;

  const providerNodeNameMap = {};
  try {
    const nodes = await getProviderNodes();
    for (const n of nodes) if (n.id && n.name) providerNodeNameMap[n.id] = n.name;
  } catch {}

  let allApiKeys = [];
  try { allApiKeys = await getApiKeys(); } catch {}
  const apiKeyMap = {};
  // Keyed by digest: the log no longer stores the key itself, so the name lookup
  // goes through the same one-way function (issue #9, item 5).
  for (const k of allApiKeys) apiKeyMap[hashApiKey(k.key)] = { name: k.name, id: k.id, createdAt: k.createdAt };

  // recentRequests from live history (last 100 entries enough for 20 deduped)
  const recentRows = db.all(`SELECT timestamp, provider, model, tokens, status FROM usageHistory ORDER BY id DESC LIMIT 100`);
  const seen = new Set();
  const recentRequests = recentRows
    .map((r) => {
      const t = parseJson(r.tokens, {}) || {};
      return {
        timestamp: r.timestamp, model: r.model, provider: r.provider || "",
        promptTokens: t.prompt_tokens || t.input_tokens || 0,
        completionTokens: t.completion_tokens || t.output_tokens || 0,
        cachedTokens: t.cached_tokens || t.cache_read_input_tokens || 0,
        status: r.status || "ok",
      };
    })
    .filter((e) => {
      if (e.promptTokens === 0 && e.completionTokens === 0) return false;
      const minute = e.timestamp ? e.timestamp.slice(0, 16) : "";
      const key = `${e.model}|${e.provider}|${e.promptTokens}|${e.completionTokens}|${minute}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);

  const stats = {
    totalRequests: 0,
    totalPromptTokens: 0, totalCompletionTokens: 0, totalCachedTokens: 0, totalCost: 0,
    byProvider: {}, byModel: {}, byAccount: {}, byApiKey: {}, byEndpoint: {},
    last10Minutes: [],
    pending: pendingRequests,
    activeRequests: [],
    recentRequests,
    errorProvider: (Date.now() - lastErrorProvider.ts < 10000) ? lastErrorProvider.provider : "",
  };

  // Active requests
  for (const [connectionId, models] of Object.entries(pendingRequests.byAccount)) {
    for (const [modelKey, count] of Object.entries(models)) {
      if (count > 0) {
        const accountName = connectionMap[connectionId] || `Account ${connectionId.slice(0, 8)}...`;
        const match = modelKey.match(/^(.*) \((.*)\)$/);
        stats.activeRequests.push({
          model: match ? match[1] : modelKey,
          provider: match ? match[2] : "unknown",
          account: accountName, count,
        });
      }
    }
  }

  // last10Minutes — query 10min window
  const now = new Date();
  const currentMinuteStart = new Date(Math.floor(now.getTime() / 60000) * 60000);
  const tenMinutesAgo = new Date(currentMinuteStart.getTime() - 9 * 60 * 1000);
  const bucketMap = {};
  for (let i = 0; i < 10; i++) {
    const ts = currentMinuteStart.getTime() - (9 - i) * 60 * 1000;
    bucketMap[ts] = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
    stats.last10Minutes.push(bucketMap[ts]);
  }
  const recent10 = db.all(
    `SELECT timestamp, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ? AND timestamp <= ?`,
    [tenMinutesAgo.toISOString(), now.toISOString()]
  );
  for (const r of recent10) {
    const tt = new Date(r.timestamp).getTime();
    const minuteStart = Math.floor(tt / 60000) * 60000;
    if (bucketMap[minuteStart]) {
      bucketMap[minuteStart].requests++;
      bucketMap[minuteStart].promptTokens += r.promptTokens || 0;
      bucketMap[minuteStart].completionTokens += r.completionTokens || 0;
      bucketMap[minuteStart].cost += r.cost || 0;
    }
  }

  const useDailySummary = period !== "24h" && period !== "today";

  if (useDailySummary) {
    const periodDays = { "7d": 7, "30d": 30, "60d": 60 };
    const maxDays = periodDays[period] || null;
    const dayRows = loadDaysInRange(db, maxDays);

    for (const dr of dayRows) {
      const dateKey = dr.dateKey;
      const day = parseJson(dr.data, {});
      stats.totalPromptTokens += day.promptTokens || 0;
      stats.totalCompletionTokens += day.completionTokens || 0;
      stats.totalCachedTokens += day.cachedTokens || 0;
      stats.totalCost += day.cost || 0;

      for (const [prov, p] of Object.entries(day.byProvider || {})) {
        if (!stats.byProvider[prov]) stats.byProvider[prov] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
        stats.byProvider[prov].requests += p.requests || 0;
        stats.byProvider[prov].promptTokens += p.promptTokens || 0;
        stats.byProvider[prov].completionTokens += p.completionTokens || 0;
        stats.byProvider[prov].cachedTokens += p.cachedTokens || 0;
        stats.byProvider[prov].cost += p.cost || 0;
      }

      for (const [mk, m] of Object.entries(day.byModel || {})) {
        const rawModel = m.rawModel || mk.split("|")[0];
        const provider = m.provider || mk.split("|")[1] || "";
        const statsKey = provider ? `${rawModel} (${provider})` : rawModel;
        const providerDisplayName = providerNodeNameMap[provider] || provider;
        if (!stats.byModel[statsKey]) {
          stats.byModel[statsKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel, provider: providerDisplayName, lastUsed: dateKey };
        }
        stats.byModel[statsKey].requests += m.requests || 0;
        stats.byModel[statsKey].promptTokens += m.promptTokens || 0;
        stats.byModel[statsKey].completionTokens += m.completionTokens || 0;
        stats.byModel[statsKey].cachedTokens += m.cachedTokens || 0;
        stats.byModel[statsKey].cost += m.cost || 0;
        if (dateKey > (stats.byModel[statsKey].lastUsed || "")) stats.byModel[statsKey].lastUsed = dateKey;
      }

      for (const [connId, a] of Object.entries(day.byAccount || {})) {
        const accountName = connectionMap[connId] || `Account ${connId.slice(0, 8)}...`;
        const rawModel = a.rawModel || "";
        const provider = a.provider || "";
        const providerDisplayName = providerNodeNameMap[provider] || provider;
        const accountKey = `${rawModel} (${provider} - ${accountName})`;
        if (!stats.byAccount[accountKey]) {
          stats.byAccount[accountKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel, provider: providerDisplayName, connectionId: connId, accountName, lastUsed: dateKey };
        }
        stats.byAccount[accountKey].requests += a.requests || 0;
        stats.byAccount[accountKey].promptTokens += a.promptTokens || 0;
        stats.byAccount[accountKey].completionTokens += a.completionTokens || 0;
        stats.byAccount[accountKey].cachedTokens += a.cachedTokens || 0;
        stats.byAccount[accountKey].cost += a.cost || 0;
        if (dateKey > (stats.byAccount[accountKey].lastUsed || "")) stats.byAccount[accountKey].lastUsed = dateKey;
      }

      for (const [akKey, ak] of Object.entries(day.byApiKey || {})) {
        const rawModel = ak.rawModel || "";
        const provider = ak.provider || "";
        const providerDisplayName = providerNodeNameMap[provider] || provider;
        // Aggregates written by an older build still carry the raw key in
        // `meta.apiKey`; derive the identity from it so pre-upgrade days keep
        // their key names instead of collapsing into "Local (No API Key)".
        const legacyRaw = ak.apiKey;
        const apiKeyHash = ak.apiKeyHash || hashApiKey(legacyRaw);
        const apiKeyMasked = ak.apiKeyMasked || maskApiKey(legacyRaw);
        const keyInfo = apiKeyHash ? apiKeyMap[apiKeyHash] : null;
        const keyName = keyInfo?.name || (apiKeyMasked ? apiKeyMasked.slice(0, 8) + "..." : "Local (No API Key)");
        const apiKeyKey = apiKeyMasked || "local-no-key";
        if (!stats.byApiKey[akKey]) {
          stats.byApiKey[akKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel, provider: providerDisplayName, apiKeyMasked, keyName, apiKeyKey, lastUsed: dateKey };
        }
        stats.byApiKey[akKey].requests += ak.requests || 0;
        stats.byApiKey[akKey].promptTokens += ak.promptTokens || 0;
        stats.byApiKey[akKey].completionTokens += ak.completionTokens || 0;
        stats.byApiKey[akKey].cachedTokens += ak.cachedTokens || 0;
        stats.byApiKey[akKey].cost += ak.cost || 0;
        if (dateKey > (stats.byApiKey[akKey].lastUsed || "")) stats.byApiKey[akKey].lastUsed = dateKey;
      }

      for (const [epKey, ep] of Object.entries(day.byEndpoint || {})) {
        const endpoint = ep.endpoint || epKey.split("|")[0] || "Unknown";
        const rawModel = ep.rawModel || "";
        const provider = ep.provider || "";
        const providerDisplayName = providerNodeNameMap[provider] || provider;
        if (!stats.byEndpoint[epKey]) {
          stats.byEndpoint[epKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, endpoint, rawModel, provider: providerDisplayName, lastUsed: dateKey };
        }
        stats.byEndpoint[epKey].requests += ep.requests || 0;
        stats.byEndpoint[epKey].promptTokens += ep.promptTokens || 0;
        stats.byEndpoint[epKey].completionTokens += ep.completionTokens || 0;
        stats.byEndpoint[epKey].cachedTokens += ep.cachedTokens || 0;
        stats.byEndpoint[epKey].cost += ep.cost || 0;
        if (dateKey > (stats.byEndpoint[epKey].lastUsed || "")) stats.byEndpoint[epKey].lastUsed = dateKey;
      }
    }

    // Overlay precise lastUsed timestamps from history. The overlay scans only
    // a recent window; entries older than that keep day-level lastUsed from
    // usageDaily — bounding the scan matters for "all", where the unbounded
    // variant walked the whole history table on every stats read. Upgrade to a
    // materialized per-key MAX(timestamp) table if exact old timestamps ever
    // matter.
    const OVERLAY_WINDOW_MS = 2 * 86400000;
    const overlayCutoff = Math.max(
      maxDays ? Date.now() - maxDays * 86400000 : 0,
      Date.now() - OVERLAY_WINDOW_MS,
    );
    const histRows = db.all(
      `SELECT timestamp, provider, model, connectionId, apiKey, apiKeyHash, endpoint FROM usageHistory WHERE timestamp >= ?`,
      [new Date(overlayCutoff).toISOString()]
    );
    for (const e of histRows) {
      const ts = e.timestamp;
      const modelKey = e.provider ? `${e.model} (${e.provider})` : e.model;
      if (stats.byModel[modelKey] && new Date(ts) > new Date(stats.byModel[modelKey].lastUsed)) stats.byModel[modelKey].lastUsed = ts;

      if (e.connectionId) {
        const accountName = connectionMap[e.connectionId] || `Account ${e.connectionId.slice(0, 8)}...`;
        const accountKey = `${e.model} (${e.provider} - ${accountName})`;
        if (stats.byAccount[accountKey] && new Date(ts) > new Date(stats.byAccount[accountKey].lastUsed)) stats.byAccount[accountKey].lastUsed = ts;
      }

      const apiKeyKey = (e.apiKey && typeof e.apiKey === "string")
        ? `${e.apiKey}|${e.model}|${e.provider || "unknown"}`
        : "local-no-key";
      if (stats.byApiKey[apiKeyKey] && new Date(ts) > new Date(stats.byApiKey[apiKeyKey].lastUsed)) stats.byApiKey[apiKeyKey].lastUsed = ts;

      const endpoint = e.endpoint || "Unknown";
      const endpointKey = `${endpoint}|${e.model}|${e.provider || "unknown"}`;
      if (stats.byEndpoint[endpointKey] && new Date(ts) > new Date(stats.byEndpoint[endpointKey].lastUsed)) stats.byEndpoint[endpointKey].lastUsed = ts;
    }
  } else {
    // 24h / today: live history
    let cutoff;
    if (period === "today") {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      cutoff = startOfDay.toISOString();
    } else {
      cutoff = new Date(Date.now() - PERIOD_MS["24h"]).toISOString();
    }
    const filtered = db.all(
      `SELECT timestamp, provider, model, connectionId, apiKey, apiKeyHash, endpoint, promptTokens, completionTokens, cost, tokens FROM usageHistory WHERE timestamp >= ?`,
      [cutoff]
    );

    for (const r of filtered) {
      const tokens = parseJson(r.tokens, {}) || {};
      const promptTokens = tokens.prompt_tokens || 0;
      const completionTokens = tokens.completion_tokens || 0;
      const cachedTokens = tokens.cached_tokens || tokens.cache_read_input_tokens || 0;
      const entryCost = r.cost || 0;
      const providerDisplayName = providerNodeNameMap[r.provider] || r.provider;

      stats.totalPromptTokens += promptTokens;
      stats.totalCompletionTokens += completionTokens;
      stats.totalCachedTokens += cachedTokens;
      stats.totalCost += entryCost;

      if (!stats.byProvider[r.provider]) stats.byProvider[r.provider] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
      stats.byProvider[r.provider].requests++;
      stats.byProvider[r.provider].promptTokens += promptTokens;
      stats.byProvider[r.provider].completionTokens += completionTokens;
      stats.byProvider[r.provider].cachedTokens += cachedTokens;
      stats.byProvider[r.provider].cost += entryCost;

      const modelKey = r.provider ? `${r.model} (${r.provider})` : r.model;
      if (!stats.byModel[modelKey]) {
        stats.byModel[modelKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel: r.model, provider: providerDisplayName, lastUsed: r.timestamp };
      }
      stats.byModel[modelKey].requests++;
      stats.byModel[modelKey].promptTokens += promptTokens;
      stats.byModel[modelKey].completionTokens += completionTokens;
      stats.byModel[modelKey].cachedTokens += cachedTokens;
      stats.byModel[modelKey].cost += entryCost;
      if (new Date(r.timestamp) > new Date(stats.byModel[modelKey].lastUsed)) stats.byModel[modelKey].lastUsed = r.timestamp;

      if (r.connectionId) {
        const accountName = connectionMap[r.connectionId] || `Account ${r.connectionId.slice(0, 8)}...`;
        const accountKey = `${r.model} (${r.provider} - ${accountName})`;
        if (!stats.byAccount[accountKey]) {
          stats.byAccount[accountKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel: r.model, provider: providerDisplayName, connectionId: r.connectionId, accountName, lastUsed: r.timestamp };
        }
        stats.byAccount[accountKey].requests++;
        stats.byAccount[accountKey].promptTokens += promptTokens;
        stats.byAccount[accountKey].completionTokens += completionTokens;
        stats.byAccount[accountKey].cachedTokens += cachedTokens;
        stats.byAccount[accountKey].cost += entryCost;
        if (new Date(r.timestamp) > new Date(stats.byAccount[accountKey].lastUsed)) stats.byAccount[accountKey].lastUsed = r.timestamp;
      }

      if (r.apiKey && typeof r.apiKey === "string") {
        const apiKeyHash = r.apiKeyHash || hashApiKey(r.apiKey);
        const keyInfo = apiKeyHash ? apiKeyMap[apiKeyHash] : null;
        const apiKeyMasked = maskApiKey(r.apiKey);
        const keyName = keyInfo?.name || (apiKeyMasked ? apiKeyMasked.slice(0, 8) + "..." : "Local (No API Key)");
        // Group by the per-key sha256 digest, NOT the mask: the mask is `sk-` + the
        // first 5 chars of the machine id, so it is IDENTICAL for every key on one
        // machine — grouping by it collapsed all a machine's keys into a single
        // bucket. The mask stays for display only. Matches the daily-aggregation
        // path above, which already keys byApiKey on the hash.
        const groupId = apiKeyHash || apiKeyMasked;
        const akKey = `${groupId}|${r.model}|${r.provider || "unknown"}`;
        if (!stats.byApiKey[akKey]) {
          stats.byApiKey[akKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel: r.model, provider: providerDisplayName, apiKeyMasked, keyName, apiKeyKey: groupId, lastUsed: r.timestamp };
        }
        const ake = stats.byApiKey[akKey];
        ake.requests++; ake.promptTokens += promptTokens; ake.completionTokens += completionTokens; ake.cachedTokens += cachedTokens; ake.cost += entryCost;
        if (new Date(r.timestamp) > new Date(ake.lastUsed)) ake.lastUsed = r.timestamp;
      } else {
        if (!stats.byApiKey["local-no-key"]) {
          stats.byApiKey["local-no-key"] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel: r.model, provider: providerDisplayName, apiKeyMasked: null, keyName: "Local (No API Key)", apiKeyKey: "local-no-key", lastUsed: r.timestamp };
        }
        const ake = stats.byApiKey["local-no-key"];
        ake.requests++; ake.promptTokens += promptTokens; ake.completionTokens += completionTokens; ake.cachedTokens += cachedTokens; ake.cost += entryCost;
        if (new Date(r.timestamp) > new Date(ake.lastUsed)) ake.lastUsed = r.timestamp;
      }

      const endpoint = r.endpoint || "Unknown";
      const epKey = `${endpoint}|${r.model}|${r.provider || "unknown"}`;
      if (!stats.byEndpoint[epKey]) {
        stats.byEndpoint[epKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, endpoint, rawModel: r.model, provider: providerDisplayName, lastUsed: r.timestamp };
      }
      const epe = stats.byEndpoint[epKey];
      epe.requests++; epe.promptTokens += promptTokens; epe.completionTokens += completionTokens; epe.cachedTokens += cachedTokens; epe.cost += entryCost;
      if (new Date(r.timestamp) > new Date(epe.lastUsed)) epe.lastUsed = r.timestamp;
    }
  }

  stats.totalRequests = Object.values(stats.byProvider).reduce((sum, p) => sum + (p.requests || 0), 0);
  return stats;
}

// Model-family normalization for the distribution chart: this is an API
// gateway serving the same underlying model through many channels, so the
// chart aggregates by FAMILY, not by full model id and never by provider.
//   openai/gpt-4          → gpt        (provider prefix stripped, lowercased)
//   Xiaomi/MiMo-V2.5      → mimo       (version segments are NEVER kept)
//   bai/glm-5.3-flash     → glm
//   85d2a64e-…:323e…      → other      (custom-channel UUID-ish ids)
//
// The version segment used to be kept when it was a pure integer
// (`/^\d+$/` → gpt-4 / claude-3 / gemini-3). That rule split one family across
// two buckets whenever the same product line mixed integer and decimal majors:
// `gpt-6-astra` kept its version ("6" is pure digits) while `gpt-5.6-sol` lost
// it ("5.6" has a dot) — so the legend showed both `gpt` AND `gpt-6`, and the
// same happened for `gemini-3` / `claude-3` (8 families from 12 ids). Dropping
// the version outright restores single-bucket-per-product aggregation.
// Opaque or proprietary codenames mapped to recognized product families.
// E.g. Qoder internal codenames: qfmodel/qmodel → qwen, dfmodel/dmodel → deepseek.
const CODENAME_FAMILIES = [
  [/^q(?:f)?model(?:_.*)?$/, "qwen"],
  [/^d(?:f)?model(?:_.*)?$/, "deepseek"],
  [/^kmodel(?:_.*)?$/, "kimi"],
  [/^g(?:f|m\d+)?model(?:_.*)?$/, "glm"],
  [/^mmodel(?:_.*)?$/, "minimax"],
  [/^(?:ultimate|performance)$/, "claude"],
  [/^qwq(?:-.*)?$/, "qwen"],
];

// Brand consolidation: one vendor ships several product-line prefixes that
// should NOT split into separate legend bars. After the first-segment strip,
// a derived family in the key folds into the mapped family. StepFun exposes
// `step-*` (LLM/vision/image) alongside `stepaudio-*` (TTS/ASR) — same brand,
// so they aggregate to one "step" family rather than showing "step" + "stepaudio".
// Brand consolidation: different product-line prefixes of one brand fold into
// one family so the Model Type chart shows a single bar per vendor rather than
// splitting StepFun's stack into "step" + "stepaudio". Keys are post-strip
// first segments; add entries here as other brand-prefixed lines surface.
const BRAND_FAMILIES = { stepaudio: "step" };

export function modelFamilyName(model) {
  const raw = String(model || "unknown");
  const noPrefix = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
  const lower = noPrefix.toLowerCase();
  // Custom-channel ids look like "<uuid>:<name>" — hex prefix catches them;
  // no length cap (real descriptive names run 25-30 chars).
  if (/^[0-9a-f]{8,}/.test(lower)) return "other";

  for (const [pattern, family] of CODENAME_FAMILIES) {
    if (pattern.test(lower)) return family;
  }

  const segs = lower.split("-");
  // Some brands attach the version DIRECTLY to the name with no hyphen, so it
  // lands inside segs[0] and survives the split: hy4-preview → "hy4",
  // hy3 → "hy3", qwen3.8-flash → "qwen3.8". Stripping a trailing numeric run
  // folds those into one family (hy / qwen) — same aggregation the hyphenated
  // form already gets (gpt-6-astra → gpt). Guard keeps a purely numeric first
  // segment intact instead of collapsing it to "".
  const first = segs[0] || "other";
  const stripped = first.replace(/[0-9]+(?:\.[0-9]+)*$/, "") || first;
  return BRAND_FAMILIES[stripped] || stripped;
}

// Keep the top families by period total, fold the rest into "other" — the
// gateway sees dozens of model ids and the chart must stay readable.
function finalizeModelBuckets(buckets, maxFamilies = 7) {
  const totals = {};
  for (const b of buckets) {
    for (const [f, t] of Object.entries(b.byModel || {})) totals[f] = (totals[f] || 0) + t;
  }
  const top = new Set(
    Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, maxFamilies).map(([f]) => f)
  );
  for (const b of buckets) {
    const merged = {};
    for (const [f, t] of Object.entries(b.byModel || {})) {
      const key = top.has(f) ? f : "other";
      merged[key] = (merged[key] || 0) + t;
    }
    b.byModel = merged;
  }
  return buckets;
}

export async function getChartData(period = "7d") {
  const db = await getAdapter();
  const now = Date.now();

  if (period === "today") {
    const bucketCount = 24;
    const bucketMs = 3600000;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startTime = startOfDay.getTime();
    const endTime = startTime + bucketCount * bucketMs;
    const labelFn = (ts) => new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    const buckets = Array.from({ length: bucketCount }, (_, i) => ({ label: labelFn(startTime + i * bucketMs), tokens: 0, cost: 0, byModel: {} }));

    const rows = db.all(
      `SELECT timestamp, model, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ?`,
      [new Date(startTime).toISOString()]
    );
    for (const r of rows) {
      const t = new Date(r.timestamp).getTime();
      if (t < startTime || t >= endTime) continue;
      const idx = Math.floor((t - startTime) / bucketMs);
      if (idx >= 0 && idx < bucketCount) {
        const tokens = (r.promptTokens || 0) + (r.completionTokens || 0);
        buckets[idx].tokens += tokens;
        buckets[idx].cost += r.cost || 0;
        const fam = modelFamilyName(r.model);
        buckets[idx].byModel[fam] = (buckets[idx].byModel[fam] || 0) + tokens;
      }
    }
    return finalizeModelBuckets(buckets);
  }

  if (period === "24h") {
    const bucketCount = 24;
    const bucketMs = 3600000;
    const labelFn = (ts) => new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    const startTime = now - bucketCount * bucketMs;
    const buckets = Array.from({ length: bucketCount }, (_, i) => ({ label: labelFn(startTime + i * bucketMs), tokens: 0, cost: 0, byModel: {} }));

    const rows = db.all(
      `SELECT timestamp, model, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ?`,
      [new Date(startTime).toISOString()]
    );
    for (const r of rows) {
      const t = new Date(r.timestamp).getTime();
      if (t < startTime || t > now) continue;
      const idx = Math.min(Math.floor((t - startTime) / bucketMs), bucketCount - 1);
      const tokens = (r.promptTokens || 0) + (r.completionTokens || 0);
      buckets[idx].tokens += tokens;
      buckets[idx].cost += r.cost || 0;
      const fam = modelFamilyName(r.model);
      buckets[idx].byModel[fam] = (buckets[idx].byModel[fam] || 0) + tokens;
    }
    return finalizeModelBuckets(buckets);
  }

  const bucketCount = period === "7d" ? 7 : period === "30d" ? 30 : 60;
  const today = new Date();
  const labelFn = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  // "all": every recorded day, oldest → newest. dayRows are sorted by
  // loadDaysInRange, so dayRows[0] is the earliest key on disk.
  if (period === "all") {
    const dayRows = loadDaysInRange(db, null);
    if (!dayRows.length) return [];
    const allMap = {};
    for (const r of dayRows) allMap[r.dateKey] = parseJson(r.data, {});

    const earliest = new Date(dayRows[0].dateKey + "T00:00:00");
    // Midnight-anchored: the outer `today` carries the current wall time, and
    // rounding it up would append an empty bucket for tomorrow.
    const today0 = new Date();
    today0.setHours(0, 0, 0, 0);
    const diffDays = Math.max(1, Math.round((today0 - earliest) / 86400000) + 1);

    const buckets = Array.from({ length: diffDays }, (_, i) => {
      const d = new Date(earliest);
      d.setDate(d.getDate() + i);
      const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const dayData = allMap[dateKey];
      return {
        dateKey,
        label: labelFn(d),
        tokens: dayData ? (dayData.promptTokens || 0) + (dayData.completionTokens || 0) : 0,
        cost: dayData ? (dayData.cost || 0) : 0,
        byModel: {},
      };
    });

    // Same model-distribution fill as the windowed branches, but unbounded —
    // the chart covers the whole table.
    try {
      const mrows = db.all(`SELECT timestamp, model, promptTokens, completionTokens FROM usageHistory`);
      const byKey = {};
      for (const b of buckets) byKey[b.dateKey] = b;
      for (const r of mrows) {
        const b = byKey[getLocalDateKey(r.timestamp)];
        if (!b) continue;
        const tokens = (r.promptTokens || 0) + (r.completionTokens || 0);
        const fam = modelFamilyName(r.model);
        b.byModel[fam] = (b.byModel[fam] || 0) + tokens;
      }
    } catch {}

    return finalizeModelBuckets(buckets.map(({ dateKey, ...rest }) => rest));
  }

  // Build map of dateKey → day data
  const dayRows = loadDaysInRange(db, bucketCount);
  const dayMap = {};
  for (const r of dayRows) dayMap[r.dateKey] = parseJson(r.data, {});

  const buckets = Array.from({ length: bucketCount }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - (bucketCount - 1 - i));
    const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const dayData = dayMap[dateKey];
    return {
      dateKey,
      label: labelFn(d),
      tokens: dayData ? (dayData.promptTokens || 0) + (dayData.completionTokens || 0) : 0,
      cost: dayData ? (dayData.cost || 0) : 0,
      byModel: {},
    };
  });

  // Model distribution needs row-level data — usageDaily aggregates only
  // carry day totals. One range scan grouped by the same local-day buckets.
  try {
    const rangeStart = new Date(today);
    rangeStart.setHours(0, 0, 0, 0);
    rangeStart.setDate(rangeStart.getDate() - (bucketCount - 1));
    const mrows = db.all(
      `SELECT timestamp, model, promptTokens, completionTokens FROM usageHistory WHERE timestamp >= ?`,
      [rangeStart.toISOString()]
    );
    const byKey = {};
    for (const b of buckets) byKey[b.dateKey] = b;
    for (const r of mrows) {
      const b = byKey[getLocalDateKey(r.timestamp)];
      if (!b) continue;
      const tokens = (r.promptTokens || 0) + (r.completionTokens || 0);
      const fam = modelFamilyName(r.model);
      b.byModel[fam] = (b.byModel[fam] || 0) + tokens;
    }
  } catch {}

  return finalizeModelBuckets(buckets.map(({ dateKey, ...rest }) => rest));
}

function latencyScoreFromMs(avgMs) {
  if (avgMs == null) return null;
  if (avgMs < 2000) return 100;
  if (avgMs < 5000) return 80;
  if (avgMs < 10000) return 60;
  if (avgMs < 20000) return 40;
  return 20;
}

function speedScoreFromTps(tps) {
  if (tps == null) return null;
  if (tps >= 80) return 100;
  if (tps >= 50) return 80;
  if (tps >= 25) return 60;
  if (tps >= 10) return 40;
  return 20;
}

// success 60% + latency 20% + speed 20%. A node with ZERO latency samples
// (gateway-synced rows with no local requestDetails, rotated-out ring buffer
// on NAS) never reaches this function — toEntry scores it as null and the
// row does not participate in health ranking at all (user decision: missing
// data is not a neutral score, it is no score). Only the speed axis can be
// missing here (latency measured but no token-timed durations); it takes a
// neutral 50 rather than being rewarded with the success rate.
function computeScore(successRate, latencyScore, speedScore) {
  const ls = latencyScore == null ? 50 : latencyScore;
  const ss = speedScore == null ? 50 : speedScore;
  return Math.round(successRate * 0.6 + ls * 0.2 + ss * 0.2);
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function localDayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export async function getUsageDashboard({ minRequests = 50 } = {}) {
  const db = await getAdapter();

  // Everything on this dashboard is range-independent by design: the heatmap
  // is a fixed trailing-12-month window, node health a fixed trailing-7d
  // window, and the cards are lifetime stats. period/days/start/end query
  // params are accepted (and ignored) for backwards compatibility.
  const now = new Date();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Imported rows (meta.imported = true, e.g. 9r backups / ZCode sync) are
  // excluded from scores: nodes/models compare this instance's own traffic.
  // Exception — gateway-synced rows (meta.gatewaySync = true): those were
  // NATIVE observations on a sibling 10Router/9Router instance (stamped by
  // the sqlite-backup import path and by 10router-sync --source 10r only when
  // the source row was itself not an import), so their status is a real
  // gateway outcome and they do participate. Client-ledger imports — and
  // rows the source instance had itself imported, however far they travel —
  // stay excluded. The daily heatmap intentionally keeps all of them
  // (usageDaily day aggregates).
  const notImported = `(meta IS NULL OR meta NOT LIKE '%"imported":true%' OR meta LIKE '%"gatewaySync":true%')`;

  // The heatmap is GitHub-style: trailing 12 months anchored on today,
  // independent of the score range selected in the UI. The component shows
  // as many trailing weeks as fit the container width.
  const dayRows = db.all(
    `SELECT dateKey, data FROM usageDaily WHERE dateKey >= ? AND dateKey <= ?`,
    [localDayKey(new Date(today.getTime() - 364 * 86400000)), localDayKey(today)]
  );
  const daily = dayRows
    .map((r) => {
      const d = parseJson(r.data, {});
      return {
        date: r.dateKey,
        requests: d.requests || 0,
        tokens: (d.promptTokens || 0) + (d.completionTokens || 0),
        cost: d.cost || 0,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  // Lifetime stats (ZCode-style), independent of any range selector:
  // totals/streaks from usageDaily; longest "session" estimated by clustering
  // requests with gaps <= 30 minutes (we have no session concept); top model
  // judged by tokens consumed over the trailing 7 days.
  const lifetime = {
    totalRequests: 0,
    totalTokens: 0,
    peakTokens: 0,
    peakDate: null,
    longestSessionMin: 0,
    currentStreak: 0,
    longestStreak: 0,
    topModel: null,
    cacheHitRate: null,
    cacheTokens: 0,
    cacheRequests: 0,
    cacheCreationTokens: 0,
  };
  {
    const allDays = db.all(`SELECT dateKey, data FROM usageDaily ORDER BY dateKey`);
    let streak = 0;
    let prevKey = null;
    const activeSet = new Set();
    for (const r of allDays) {
      const d = parseJson(r.data, {});
      const tokens = (d.promptTokens || 0) + (d.completionTokens || 0);
      const active = (d.requests || 0) > 0;
      lifetime.totalRequests += d.requests || 0;
      lifetime.totalTokens += tokens;
      if (tokens > lifetime.peakTokens) {
        lifetime.peakTokens = tokens;
        lifetime.peakDate = r.dateKey;
      }
      if (active) {
        activeSet.add(r.dateKey);
        const prev = prevKey ? new Date(`${prevKey}T00:00:00`) : null;
        const cur = new Date(`${r.dateKey}T00:00:00`);
        streak = prev && (cur - prev) === 86400000 ? streak + 1 : 1;
        lifetime.longestStreak = Math.max(lifetime.longestStreak, streak);
      } else {
        streak = 0;
      }
      prevKey = r.dateKey;
    }
    // Current streak counts back from today (or yesterday if today is still
    // empty — the day isn't over yet).
    const cursorDay = new Date(today);
    if (!activeSet.has(localDayKey(cursorDay))) cursorDay.setDate(cursorDay.getDate() - 1);
    while (activeSet.has(localDayKey(cursorDay))) {
      lifetime.currentStreak += 1;
      cursorDay.setDate(cursorDay.getDate() - 1);
    }

    const SESSION_GAP_MS = 30 * 60000;
    const tsRows = db.all(`SELECT timestamp FROM usageHistory ORDER BY timestamp`);
    let sessionStart = null;
    let prevTs = null;
    for (const r of tsRows) {
      const t = new Date(r.timestamp).getTime();
      if (Number.isNaN(t)) continue;
      if (prevTs != null && t - prevTs <= SESSION_GAP_MS) {
        lifetime.longestSessionMin = Math.max(lifetime.longestSessionMin, Math.round((t - sessionStart) / 60000));
      } else {
        sessionStart = t;
      }
      prevTs = t;
    }

    // Top model by tokens consumed over the trailing 7 days (imports included).
    const topRows = db.all(
      `SELECT provider, model, promptTokens, completionTokens FROM usageHistory
       WHERE timestamp >= ? AND timestamp < ?`,
      [new Date(today.getTime() - 6 * 86400000).toISOString(), new Date(today.getTime() + 86400000).toISOString()]
    );
    const modelTokens = {};
    for (const r of topRows) {
      const mk = `${r.model || "unknown"}|${r.provider || ""}`;
      modelTokens[mk] = (modelTokens[mk] || 0) + (r.promptTokens || 0) + (r.completionTokens || 0);
    }
    const top = Object.entries(modelTokens).sort((a, b) => b[1] - a[1])[0];
    if (top) {
      const sep = top[0].lastIndexOf("|");
      lifetime.topModel = {
        model: top[0].slice(0, sep),
        provider: top[0].slice(sep + 1) || null,
        tokens: top[1],
      };
    }

    // Cache hit rate over real cached requests: strictly excludes requests
    // with no cache. The denominator is the request's TOTAL input, which must
    // handle two storage shapes side by side (see usageDisplay.js):
    //   - canonical / mirasim-imported rows: promptTokens is cache-INCLUSIVE
    //     (fresh + cache_read + cache_creation) → total = promptTokens;
    //   - raw Claude-shape rows (prompt cache-EXCLUSIVE, e.g. prompt_tokens=8
    //     next to cache_read_input_tokens=263296) → total = cache_read +
    //     cache_creation.
    // max(prompt, cached + creation) resolves both without a shape flag: an
    // inclusive prompt always ≥ cached+creation, an exclusive prompt is
    // dwarfed by it. The old `cached >= prompt` skip silently dropped exactly
    // those cache-dense raw rows (near-100% hits) and biased the rate. The
    // distorted-import guard narrows to the case it was built for: input ==
    // cache with no writes.
    let cacheHitSum = 0;
    let cacheTotalSum = 0;
    let cacheRequestsCount = 0;
    let cacheCreationSum = 0;
    try {
      const cacheRows = db.all(
        `SELECT promptTokens, tokens FROM usageHistory WHERE tokens LIKE '%cache%'`
      );
      for (const r of cacheRows) {
        const t = parseJson(r.tokens, {});
        const cached = t.cached_tokens || t.cache_read_input_tokens || 0;
        const creation = t.cache_creation_input_tokens || 0;
        const prompt = r.promptTokens || t.prompt_tokens || 0;
        if (cached <= 0 || prompt <= 0) continue;
        if (cached === prompt && creation <= 0) continue;
        const total = Math.max(prompt, cached + creation);
        cacheHitSum += cached;
        cacheTotalSum += total;
        cacheCreationSum += creation;
        cacheRequestsCount += 1;
      }
      lifetime.cacheHitRate = cacheTotalSum > 0 ? round1((cacheHitSum / cacheTotalSum) * 100) : null;
      lifetime.cacheTokens = cacheHitSum;
      lifetime.cacheRequests = cacheRequestsCount;
      lifetime.cacheCreationTokens = cacheCreationSum;
    } catch {}
  }

  const groupStats = `
    COUNT(*) as requests,
    SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) as errors,
    SUM(promptTokens) as promptTokens,
    SUM(completionTokens) as completionTokens,
    SUM(cost) as cost,
    MAX(timestamp) as lastUsed
  `;
  const rangeFilter = `AND timestamp >= ? AND timestamp < ?`;

  // Node health always uses a fixed trailing-7d window, independent of the
  // page period selector — recent health is the actionable signal.
  const nodeTsGte = new Date(today.getTime() - 6 * 86400000).toISOString();
  const nodeTsLt = new Date(today.getTime() + 86400000).toISOString();
  const nodeRows = db.all(
    `SELECT provider, ${groupStats} FROM usageHistory WHERE ${notImported} ${rangeFilter} GROUP BY COALESCE(provider, '')`,
    [nodeTsGte, nodeTsLt]
  );
  const modelRows = db.all(
    `SELECT provider, model, ${groupStats} FROM usageHistory WHERE ${notImported} ${rangeFilter} GROUP BY COALESCE(provider, ''), COALESCE(model, '')`,
    [nodeTsGte, nodeTsLt]
  );

  // Perf stats (avg total latency / TTFT / output speed) aggregate BOTH
  // stores into one bucket per (scope, key), per-metric:
  //   • requestDetails — recent window only (~200 records, observability-capped);
  //   • usageHistory meta.latencyMs/ttftMs — long-lived, travels with sync.
  // The two stores record the SAME measurement for overlapping requests, so
  // merging never skews an average (sum and count scale together) — it only
  // fills gaps: a model whose meta rows all lack ttftMs (non-streaming
  // branch) still shows the TTFT history kept in requestDetails, and rows
  // missing one metric never drag the other metrics down (each metric counts
  // only its own valid samples — ttftCount vs count already encode that).
  const perfAgg = { node: {}, model: {} };
  try {
    const rdRows = db.all(`SELECT provider, model, connectionId, data FROM requestDetails`);
    for (const r of rdRows) {
      const d = parseJson(r.data, {}) || {};
      const total = d?.latency?.total;
      if (typeof total !== "number" || total <= 0) continue;
      const ttft = typeof d?.latency?.ttft === "number" && d.latency.ttft > 0 ? d.latency.ttft : null;
      const outTokens = d?.tokens?.completion_tokens || d?.tokens?.output_tokens || 0;
      let durationMs = null;
      if (outTokens > 0) {
        if (ttft != null && total > ttft && (total - ttft) >= 50) {
          durationMs = total - ttft;
        } else if (total >= 50) {
          durationMs = total;
        }
        // If instantaneous speed > 300 tok/s and total >= 50, this indicates
        // a buffered burst / chunk flush where ttft was held until nearly full
        // output was ready. Fall back to end-to-end total latency. (250 was
        // too strict — fast-but-honest streams got damped into false alerts.)
        if (durationMs != null && durationMs > 0 && (outTokens / (durationMs / 1000)) > 300 && total >= 50) {
          durationMs = total;
        }
      }
      const nodeKey = r.provider || "";
      const modelKey = `${r.provider || ""}|${r.model || ""}`;
      for (const [scope, key] of [["node", nodeKey], ["model", modelKey]]) {
        if (!perfAgg[scope][key]) perfAgg[scope][key] = { sum: 0, count: 0, ttftSum: 0, ttftCount: 0, tokensSum: 0, durMsSum: 0 };
        const agg = perfAgg[scope][key];
        agg.sum += total;
        agg.count += 1;
        if (ttft != null) { agg.ttftSum += ttft; agg.ttftCount += 1; }
        if (durationMs != null && durationMs > 0 && outTokens > 0) {
          agg.tokensSum += outTokens;
          agg.durMsSum += durationMs;
        }
      }
    }
  } catch {}

  // Second feed into the same buckets: latency observations carried on
  // usageHistory rows themselves (meta.latencyMs/ttftMs — stamped by executors
  // since 1.1.2 and travelling with gateway-synced imports). These rows
  // outlive the requestDetails ring, so a week-old deployment covers the
  // trailing-7d health window entirely — including synced models on a
  // sibling instance.
  try {
    const metaRows = db.all(
      `SELECT provider, model, meta, completionTokens FROM usageHistory
       WHERE ${notImported} ${rangeFilter} AND meta LIKE '%latencyMs%'`,
      [nodeTsGte, nodeTsLt]
    );
    for (const r of metaRows) {
      const m = parseJson(r.meta, {}) || {};
      const total = typeof m.latencyMs === "number" && m.latencyMs > 0 ? m.latencyMs : null;
      if (total == null) continue;
      const ttft = typeof m.ttftMs === "number" && m.ttftMs > 0 ? m.ttftMs : null;
      const outTokens = r.completionTokens || 0;
      // Same duration derivation as the requestDetails path (incl. the
      // buffered-burst dampening at >300 tok/s) so both sources agree.
      let durationMs = null;
      if (outTokens > 0) {
        if (ttft != null && total > ttft && (total - ttft) >= 50) {
          durationMs = total - ttft;
        } else if (total >= 50) {
          durationMs = total;
        }
        if (durationMs != null && durationMs > 0 && (outTokens / (durationMs / 1000)) > 300 && total >= 50) {
          durationMs = total;
        }
      }
      const nodeKey = r.provider || "";
      const modelKey = `${r.provider || ""}|${r.model || ""}`;
      for (const [scope, key] of [["node", nodeKey], ["model", modelKey]]) {
        if (!perfAgg[scope][key]) perfAgg[scope][key] = { sum: 0, count: 0, ttftSum: 0, ttftCount: 0, tokensSum: 0, durMsSum: 0 };
        const agg = perfAgg[scope][key];
        agg.sum += total;
        agg.count += 1;
        if (ttft != null) { agg.ttftSum += ttft; agg.ttftCount += 1; }
        if (durationMs != null && durationMs > 0 && outTokens > 0) {
          agg.tokensSum += outTokens;
          agg.durMsSum += durationMs;
        }
      }
    }
  } catch {}

  const perfOf = (scope, key) => {
    const agg = perfAgg[scope][key];
    if (!agg) return { avgLatencyMs: null, avgTtftMs: null, avgSpeed: null };
    return {
      avgLatencyMs: Math.round(agg.sum / agg.count),
      avgTtftMs: agg.ttftCount > 0 ? Math.round(agg.ttftSum / agg.ttftCount) : null,
      avgSpeed: (agg.durMsSum > 0 && agg.tokensSum > 0) ? round1(agg.tokensSum / (agg.durMsSum / 1000)) : null,
    };
  };

  const toEntry = (row, scope, key, extra) => {
    const requests = row.requests || 0;
    const errors = row.errors || 0;
    const successRate = requests > 0 ? round1(((requests - errors) / requests) * 100) : 0;
    const { avgLatencyMs, avgTtftMs, avgSpeed } = perfOf(scope, key);
    return {
      ...extra,
      requests,
      errors,
      successRate,
      avgLatencyMs,
      avgTtftMs,
      avgSpeed,
    // No latency sample → no health score: the row shows its traffic but
    // stays out of the ranking entirely (frontend renders "—").
    hasPerfData: avgLatencyMs != null,
    // Availability of each perf axis, so the UI can hide columns a whole
    // node has no samples for (a node can have TTFT without speed or any
    // other combination once the two data stores merge per-metric).
    hasTtft: avgTtftMs != null,
    hasSpeed: avgSpeed != null,
    score: avgLatencyMs == null
      ? null
      : computeScore(successRate, latencyScoreFromMs(avgLatencyMs), speedScoreFromTps(avgSpeed)),
      promptTokens: row.promptTokens || 0,
      completionTokens: row.completionTokens || 0,
      cost: row.cost || 0,
      lastUsed: row.lastUsed || null,
    };
  };

  const nodes = nodeRows
    .filter((r) => (r.requests || 0) >= minRequests)
    .map((r) => toEntry(r, "node", r.provider || "", {
      provider: r.provider || "unknown",
      name: r.provider || "unknown",
    }))
    .sort((a, b) => b.score - a.score);

  // Models feed the node-row drill-down (expand a node → per-model health),
  // so they keep a much lower bar than the top-level node list: a 40-request
  // model under an 800-request node is exactly what you want to see when
  // diagnosing which model drags the node down.
  const modelMinRequests = Math.min(minRequests, 10);
  const models = modelRows
    .filter((r) => (r.requests || 0) >= modelMinRequests)
    .map((r) => toEntry(r, "model", `${r.provider || ""}|${r.model || ""}`, {
      model: r.model || "unknown",
      provider: r.provider || "unknown",
    }))
    .sort((a, b) => b.score - a.score);

  return { daily, nodes, models, lifetime };
}

function formatLogDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// No-op: request log is now derived from usageHistory table on read.
export async function appendRequestLog() {}

export async function getRecentLogs(limit = 200) {
  try {
    const db = await getAdapter();
    const rows = db.all(
      `SELECT timestamp, provider, model, connectionId, promptTokens, completionTokens, status, tokens FROM usageHistory ORDER BY id DESC LIMIT ?`,
      [limit],
    );
    if (!rows.length) return [];

    const connMap = {};
    try {
      const { getProviderConnections } = await import("./connectionsRepo.js");
      const connections = await getProviderConnections();
      for (const c of connections) connMap[c.id] = c.name || c.email || "";
    } catch {}

    return rows.map((r) => {
      const ts = formatLogDate(new Date(r.timestamp));
      const p = r.provider?.toUpperCase() || "-";
      const m = r.model || "-";
      const account = connMap[r.connectionId] || (r.connectionId ? r.connectionId.slice(0, 8) : "-");
      const tk = r.tokens ? parseJson(r.tokens, {}) : {};
      const sent = r.promptTokens ?? tk.prompt_tokens ?? "-";
      const received = r.completionTokens ?? tk.completion_tokens ?? "-";
      return `${ts} | ${m} | ${p} | ${account} | ${sent} | ${received} | ${r.status || "-"}`;
    });
  } catch (e) {
    console.error("[usageRepo] getRecentLogs failed:", e.message);
    return [];
  }
}

// Import historical usage rows (e.g. from a 9router backup). Unlike
// saveRequestUsage, imported entries keep their original timestamp/cost and are
// deduped by exact content signature. Only the usageHistory/usageDaily tables
// are touched — no configuration is imported.
/**
 * Add `delta` cost to every aggregate bucket an existing row already feeds,
 * mirroring aggregateEntryToDay's key shapes. Buckets are only touched when
 * present — a patched day never fabricates counters.
 */
function applyDailyCostDelta(db, histRow, delta) {
  const dateKey = getLocalDateKey(histRow.timestamp);
  const row = db.get(`SELECT data FROM usageDaily WHERE dateKey = ?`, [dateKey]);
  if (!row) return;
  const day = parseJson(row.data, {});
  if (!day || typeof day !== "object") return;
  const model = histRow.model || "";
  const provider = histRow.provider || "";
  const bump = (group, key) => {
    const bucket = group && group[key];
    if (bucket) bucket.cost = (bucket.cost || 0) + delta;
  };
  day.cost = (day.cost || 0) + delta;
  if (provider) bump(day.byProvider, provider);
  bump(day.byModel, provider ? `${model}|${provider}` : model);
  if (histRow.connectionId) bump(day.byAccount, histRow.connectionId);
  bump(day.byApiKey, `${histRow.apiKeyHash || "local-no-key"}|${model}|${provider || "unknown"}`);
  bump(day.byEndpoint, `${histRow.endpoint || "Unknown"}|${model}|${provider || "unknown"}`);
  db.run(
    `INSERT INTO usageDaily(dateKey, data) VALUES(?, ?) ON CONFLICT(dateKey) DO UPDATE SET data = excluded.data`,
    [dateKey, stringifyJson(day)],
  );
}

export async function importUsageRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return { imported: 0, skipped: 0 };
  const db = await getAdapter();

  // Imported rows only carry the cost the SOURCE instance assigned them. A
  // client-side ledger (the zcode plugin's local DB, third-party exports) knows
  // nothing about 10Router pricing, so every such row used to land at cost 0
  // and the dashboard's estimated cost showed nothing forever. Estimate exactly
  // like live writes do — same pricing table, same math — but ONLY where the
  // source carried none; a source-computed cost is never overwritten.
  for (const entry of rows) {
    if (entry.cost) continue;
    const tokens = (entry.tokens && typeof entry.tokens === "object") ? entry.tokens : {};
    if (tokens.prompt_tokens == null && tokens.input_tokens == null && entry.promptTokens != null) {
      tokens.prompt_tokens = entry.promptTokens;
    }
    if (tokens.completion_tokens == null && tokens.output_tokens == null && entry.completionTokens != null) {
      tokens.completion_tokens = entry.completionTokens;
    }
    entry.tokens = tokens;
    entry.cost = await calculateCost(entry.provider, entry.model, tokens);
  }

  let imported = 0;
  let skipped = 0;
  let costRepaired = false;

  db.transaction(() => {
    for (const entry of rows) {
      const tokens = entry.tokens || {};
      const promptTokens = tokens.prompt_tokens || tokens.input_tokens || entry.promptTokens || 0;
      const completionTokens = tokens.completion_tokens || tokens.output_tokens || entry.completionTokens || 0;
      const ts = entry.timestamp || new Date().toISOString();

      // Dedup: same signature as live writes.
      // Imported backups may already carry a masked value (this build's export)
      // or a raw one (older exports); the identity is derived the same way either
      // way, so dedup stays consistent within the file being imported.
      const existing = db.get(
        `SELECT id, meta, cost, timestamp, provider, model, connectionId, apiKeyHash, endpoint FROM usageHistory
         WHERE timestamp = ?
           AND COALESCE(provider, '') = COALESCE(?, '')
           AND COALESCE(model, '') = COALESCE(?, '')
           AND COALESCE(connectionId, '') = COALESCE(?, '')
           AND COALESCE(apiKeyHash, '') = COALESCE(?, '')
           AND promptTokens = ?
           AND completionTokens = ?
         ORDER BY id DESC LIMIT 1`,
        [ts, entry.provider || null, entry.model || null, entry.connectionId || null, hashApiKey(entry.apiKey), promptTokens, completionTokens]
      );
      if (existing) {
        // A dedup hit during an import proves the row itself came from an
        // import — stamp it so getRequestDetails can surface it. This also
        // backfills rows imported before the marker existed (9r backups).
        const existingMeta = parseJson(existing.meta, {}) || {};
        if (existingMeta.imported !== true) {
          db.run(`UPDATE usageHistory SET meta = ? WHERE id = ?`, [stringifyJson({ imported: true, ...existingMeta }), existing.id]);
        }
        // Cost repair on re-import: rows that landed before imports estimated
        // cost sit at 0, and plain re-syncing used to dedup-skip them forever.
        // Re-importing the same export now fills the hole and patches that
        // day's aggregates by the delta (the row's own buckets, never new
        // ones) — so the plugin's normal daily sync heals historical days.
        if (!existing.cost && entry.cost > 0) {
          db.run(`UPDATE usageHistory SET cost = ? WHERE id = ?`, [entry.cost, existing.id]);
          applyDailyCostDelta(db, existing, entry.cost);
          costRepaired = true;
        }
        skipped++;
        continue;
      }

      db.run(
        `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, apiKeyHash, endpoint, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          ts, entry.provider || null, entry.model || null,
          entry.connectionId || null, maskApiKey(entry.apiKey), hashApiKey(entry.apiKey), entry.endpoint || null,
          promptTokens, completionTokens, entry.cost || 0, entry.status || "ok",
          stringifyJson(tokens), stringifyJson({ imported: true, ...(entry.meta || {}) }),
        ]
      );

      // Aggregate into daily stats.
      const dateKey = getLocalDateKey(ts);
      const row = db.get(`SELECT data FROM usageDaily WHERE dateKey = ?`, [dateKey]);
      const day = row ? parseJson(row.data, {}) : {
        requests: 0, promptTokens: 0, completionTokens: 0, cost: 0,
        byProvider: {}, byModel: {}, byAccount: {}, byApiKey: {}, byEndpoint: {},
      };
      aggregateEntryToDay(day, entry);
      db.run(`INSERT INTO usageDaily(dateKey, data) VALUES(?, ?) ON CONFLICT(dateKey) DO UPDATE SET data = excluded.data`, [dateKey, stringifyJson(day)]);

      const cur = db.get(`SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'`);
      const next = (cur ? parseInt(cur.value, 10) : 0) + 1;
      db.run(`INSERT INTO _meta(key, value) VALUES('totalRequestsLifetime', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(next)]);

      imported++;
    }
  });

  if (imported > 0 || costRepaired) {
    scheduleStatsEvent("update", 250);
  }
  return { imported, skipped };
}

/**
 * Cost repair for usage rows that landed with a zero cost: imports made before
 * the import path estimated anything (the sync plugin's exports never carried
 * 10Router pricing), and rows written straight into the database by the
 * plugin's offline `--import` — which bypasses every import function here.
 *
 * Only rows already stamped imported/gatewaySync with token counts are touched,
 * and the estimate is the same single pricing source live writes use.
 *
 * Progress is a watermark in _meta ({ version, lastId }), not "rows still at
 * zero": a row whose model has no price stays at zero forever, and a scan that
 * keyed on zero cost kept re-reading the same oldest unpriceable rows — once
 * `limit` of them piled up, newer priceable rows were never reached. Each run
 * now scans the next `limit` rows after the watermark along the primary key and
 * advances it past everything it looked at, priced or not. A new app version
 * resets the watermark once (price tables ship with releases), so rows that
 * became priceable are picked up; re-imports still reprice through the dedup
 * path in importUsageEntries.
 */
const COST_REPAIR_META_KEY = "usageCostRepair";

export async function repairImportedUsageCosts({ limit = 20000, version = APP_CONFIG.version } = {}) {
  const db = await getAdapter();
  const mark = parseJson(await getMeta(COST_REPAIR_META_KEY), null);
  const afterId = mark && mark.version === version ? Number(mark.lastId) || 0 : 0;

  const scanned = db.all(
    `SELECT id FROM usageHistory WHERE id > ? ORDER BY id ASC LIMIT ?`,
    [afterId, limit],
  );
  if (!scanned.length) {
    if (!mark || mark.version !== version) await setMeta(COST_REPAIR_META_KEY, stringifyJson({ version, lastId: afterId }));
    return { scanned: 0, repaired: 0 };
  }
  const lastId = scanned[scanned.length - 1].id;

  const candidates = db.all(
    `SELECT id, timestamp, provider, model, connectionId, apiKeyHash, endpoint, tokens,
            promptTokens, completionTokens
     FROM usageHistory
     WHERE id > ? AND id <= ?
       AND (cost IS NULL OR cost = 0)
       AND (meta LIKE '%"imported":true%' OR meta LIKE '%"gatewaySync":true%')
       AND (promptTokens + completionTokens) > 0
     ORDER BY id ASC`,
    [afterId, lastId],
  );

  const updates = [];
  for (const row of candidates) {
    const tokens = parseJson(row.tokens, {}) || {};
    const cost = await calculateCost(row.provider, row.model, {
      ...tokens,
      prompt_tokens: tokens.prompt_tokens ?? tokens.input_tokens ?? row.promptTokens ?? 0,
      completion_tokens: tokens.completion_tokens ?? tokens.output_tokens ?? row.completionTokens ?? 0,
    });
    if (cost > 0) updates.push({ row, cost });
  }

  if (updates.length) {
    db.transaction(() => {
      for (const { row, cost } of updates) {
        db.run(`UPDATE usageHistory SET cost = ? WHERE id = ?`, [cost, row.id]);
        applyDailyCostDelta(db, row, cost);
      }
    });
    scheduleStatsEvent("update", 250);
  }
  await setMeta(COST_REPAIR_META_KEY, stringifyJson({ version, lastId }));
  return { scanned: scanned.length, candidates: candidates.length, repaired: updates.length };
}

/**
 * Boot entry: run repairImportedUsageCosts batch after batch until the watermark
 * reaches the newest row, so a version reset covers a large history in one boot
 * instead of one batch per restart. Yields between batches; call it without
 * awaiting.
 */
export async function repairAllImportedUsageCosts({ limit = 20000, maxBatches = 100 } = {}) {
  let repaired = 0;
  for (let i = 0; i < maxBatches; i++) {
    const r = await repairImportedUsageCosts({ limit });
    repaired += r.repaired;
    if (r.scanned < limit) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { repaired };
}

/**
 * Per-key daily quota aggregation.
 *
 * The reset boundary is server-local midnight — the SAME cutoff the dashboard's
 * "today" stats use (`startOfDay.setHours(0,0,0,0)` above in getUsageStats /
 * getChartData), extracted here so the quota check and the UI numbers cannot
 * drift apart. usageHistory.timestamp is UTC ISO, and lexicographic >= works
 * on ISO strings, so the existing idx_uh_ts / idx_uh_apikey_hash indexes carry
 * the query.
 */
export function localStartOfDayIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export async function sumApiKeyTokensSince(apiKeyHash, sinceIso) {
  if (!apiKeyHash) return 0;
  const db = await getAdapter();
  const row = db.get(
    `SELECT COALESCE(SUM(promptTokens + completionTokens), 0) AS tokens
     FROM usageHistory WHERE apiKeyHash = ? AND timestamp >= ?`,
    [apiKeyHash, sinceIso]
  );
  return row?.tokens || 0;
}

export async function sumAllApiKeyTokensSince(sinceIso) {
  const db = await getAdapter();
  return db.all(
    `SELECT apiKeyHash, COALESCE(SUM(promptTokens + completionTokens), 0) AS tokens
     FROM usageHistory WHERE timestamp >= ? AND apiKeyHash IS NOT NULL
     GROUP BY apiKeyHash`,
    [sinceIso]
  );
}
