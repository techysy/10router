/**
 * Browser persistence for the quota tracker — stale-while-revalidate.
 *
 * The page used to open on a wall of spinners every time: the quota cache was
 * written on every fetch but never read back, and all N upstream quota calls
 * fired at once. Now the last-known accounts + quotas paint immediately from
 * localStorage, and the network only REVALIDATES behind them (see index.js):
 * fresh entries are skipped, cards are refreshed as they scroll into view, and
 * at most QUOTA_FETCH_CONCURRENCY upstream calls run together.
 *
 * Nothing secret is persisted: the connection list is the /api/providers/client
 * whitelist minus `connectionProxyUrl` (it can carry proxy credentials), and a
 * quota entry keeps only what the card renders.
 */
import { QUOTA_CACHE_KEY } from "./utils";

export const CONNECTIONS_CACHE_KEY = "quotaConnectionsCache";

/** A cached quota younger than this is shown and NOT refetched on open. */
export const QUOTA_FRESH_MS = 60_000;
/** Entries older than this are dropped from storage on write. */
export const QUOTA_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Upstream quota calls in flight at once. */
export const QUOTA_FETCH_CONCURRENCY = 4;

function readJson(key) {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota exceeded / private mode: persistence is an optimisation only.
  }
}

/** The list query a cached page belongs to — a different filter is a miss. */
export function connectionsCacheKey({ page, pageSize, accountFilter, providerFilter, expiringFirst }) {
  // expiringFirst changes the server's row order, so it must be part of the
  // key — a cached page painted under the default order must not stand in for
  // the "Resets first" order (that was part of why the hourglass looked dead).
  // `=== true` keeps legacy boolean coercion at bay; absent/false share a key.
  return [page, pageSize, accountFilter, providerFilter, expiringFirst === true ? 1 : 0].join("|");
}

function stripSecrets(connection) {
  if (!connection?.providerSpecificData?.connectionProxyUrl) return connection;
  const psd = { ...connection.providerSpecificData };
  delete psd.connectionProxyUrl;
  return { ...connection, providerSpecificData: psd };
}

export function readConnectionsCache(key) {
  const cached = readJson(CONNECTIONS_CACHE_KEY);
  return cached && cached.key === key && Array.isArray(cached.connections) ? cached : null;
}

export function writeConnectionsCache(key, { connections, pagination, totals, providerOptions }) {
  writeJson(CONNECTIONS_CACHE_KEY, {
    key,
    connections: (connections || []).map(stripSecrets),
    pagination,
    totals,
    providerOptions,
    cachedAt: Date.now(),
  });
}

/**
 * What the card needs from a quota entry. `raw` is the whole upstream body
 * (CodeBuddy's is dozens of packs) and only Codex reads one field of it.
 */
export function compactQuotaEntry(entry) {
  if (!entry || typeof entry !== "object") return entry;
  const { raw, ...rest } = entry;
  return raw?.resetCredits ? { ...rest, raw: { resetCredits: raw.resetCredits } } : rest;
}

export function cachedAtMs(entry) {
  const t = entry?.cachedAt ? new Date(entry.cachedAt).getTime() : NaN;
  return Number.isFinite(t) ? t : 0;
}

export function isQuotaFresh(entry, now = Date.now(), freshMs = QUOTA_FRESH_MS) {
  const t = cachedAtMs(entry);
  return t > 0 && now - t < freshMs;
}

/** Cached quota entries for these connections, as the page's quotaData shape. */
export function readQuotaEntries(connections) {
  const cache = readJson(QUOTA_CACHE_KEY) || {};
  const out = {};
  for (const conn of connections || []) {
    if (cache[conn.id]) out[conn.id] = cache[conn.id];
  }
  return out;
}

/** Persist one entry (compacted) and drop anything past QUOTA_CACHE_MAX_AGE_MS. */
export function writeQuotaEntry(connectionId, entry, now = Date.now()) {
  const cache = readJson(QUOTA_CACHE_KEY) || {};
  cache[connectionId] = { ...compactQuotaEntry(entry), cachedAt: new Date(now).toISOString() };
  for (const [id, value] of Object.entries(cache)) {
    if (now - cachedAtMs(value) > QUOTA_CACHE_MAX_AGE_MS) delete cache[id];
  }
  writeJson(QUOTA_CACHE_KEY, cache);
}

/**
 * Run at most `limit` tasks at once; later ones wait their turn. Returns a
 * `run(fn)` that resolves with fn's result.
 */
export function createLimiter(limit = QUOTA_FETCH_CONCURRENCY) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || queue.length === 0) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}
