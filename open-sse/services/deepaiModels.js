/**
 * DeepAI Code model catalog fetcher.
 *
 * GET https://api.deepai.org/deepai_code/models with the desktop account
 * API key (`Api-Key` header + Theos lane header) returns the live
 * catalog in a `{ models: [...], default }` envelope — unlike Meoo, the
 * rows carry their own specs (contextWindow / maxTokens / input
 * modalities / theosPerRequest), so the static table below is only a
 * fallback for ids the live rows somehow omit fields for. The key is a
 * long-lived credential issued once at desktop sign-in: there is no
 * refresh or re-resolution path — a 401/403 means the user signed out
 * or the key was rotated in the app, and callers fall back to the
 * static registry list.
 *
 * Cache shape and dedupe follow meooModels.js: per-credential cache
 * with a 1h TTL and in-flight coalescing.
 */

import { createHash } from "crypto";

import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { DEEPAI_MODELS_URL, buildDeepaiHeaders } from "../shared/deepai/constants.js";

const FETCH_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h, same as the Meoo/Qoder catalogs

// Live-attested catalog (GET /deepai_code/models, 2026-11-16). theos is
// the per-request price from the account's daily Theos grant; 0 = the
// unmetered free tier.
export const DEEPAI_STATIC_MODEL_SPECS = {
  "glm-5.3-flash": { name: "GLM 5.3 Flash", contextLength: 1048576, maxOutputTokens: 131072, isVL: true, theosPerRequest: 0 },
  "deepseek-v4.1-flash": { name: "DeepSeek V4.1 Flash 1017", contextLength: 1048576, maxOutputTokens: 131072, isVL: true, theosPerRequest: 0 },
  "mimo-2.6-flash": { name: "MiMo 2.6 Flash", contextLength: 1048576, maxOutputTokens: 131072, isVL: true, theosPerRequest: 0 },
  "qwen-3.8-flash": { name: "Qwen 3.8 Flash", contextLength: 991000, maxOutputTokens: 128000, isVL: true, theosPerRequest: 0 },
  "minimax-m3.1-flash": { name: "MiniMax M3.1 Flash", contextLength: 1048576, maxOutputTokens: 131072, isVL: true, theosPerRequest: 0 },
  "muse-ember": { name: "Muse Ember", contextLength: 1048576, maxOutputTokens: 131072, isVL: true, theosPerRequest: 0 },
  "solar-mini-4": { name: "Solar Mini 4", contextLength: 524288, maxOutputTokens: 131072, isVL: false, theosPerRequest: 0 },
  "gpt-6-luna": { name: "GPT-6 Luna", contextLength: 1048576, maxOutputTokens: 128000, isVL: true, theosPerRequest: 0 },
  "mimo-2.6-pro": { name: "MiMo 2.6 Pro", contextLength: 1048576, maxOutputTokens: 131072, isVL: true, theosPerRequest: 0 },
  "glyph-cluster": { name: "Glyph Cluster", contextLength: 256000, maxOutputTokens: 131072, isVL: false, theosPerRequest: 0 },
  "deepai-cyber": { name: "DeepAI Cyber", contextLength: 1048576, maxOutputTokens: 131072, isVL: false, theosPerRequest: 0 },
  "minimax-m3": { name: "MiniMax M3", contextLength: 512000, maxOutputTokens: 131000, isVL: false, theosPerRequest: 2 },
  "gpt-6.1-sol": { name: "GPT-6.1 Sol", contextLength: 1048576, maxOutputTokens: 128000, isVL: true, theosPerRequest: 10 },
  "gemini-4-argon": { name: "Gemini 4 Argon", contextLength: 1048576, maxOutputTokens: 131072, isVL: true, theosPerRequest: 10 },
  "glm-5.3": { name: "GLM 5.3", contextLength: 1048576, maxOutputTokens: 131072, isVL: false, theosPerRequest: 3 },
  "kimi-k3": { name: "Kimi K3", contextLength: 1048576, maxOutputTokens: 131072, isVL: true, theosPerRequest: 3 },
  "kimi-k3.1-pro": { name: "Kimi K3.1 Pro", contextLength: 1000000, maxOutputTokens: 131072, isVL: true, theosPerRequest: 3 },
  "gpt-6.1-terra": { name: "GPT-6.1 Terra", contextLength: 1048576, maxOutputTokens: 128000, isVL: true, theosPerRequest: 5 },
  "muse-spark-1.3": { name: "Muse Spark 1.3", contextLength: 1048576, maxOutputTokens: 131072, isVL: true, theosPerRequest: 6 },
  "gemini-4-hydrogen": { name: "Gemini 4 Hydrogen", contextLength: 1000000, maxOutputTokens: 131072, isVL: true, theosPerRequest: 8 },
  "gemini-4-carbon": { name: "Gemini 4 Carbon", contextLength: 1000000, maxOutputTokens: 131072, isVL: true, theosPerRequest: 10 },
  "claude-sonnet-5-5": { name: "Claude Sonnet 5.5", contextLength: 1000000, maxOutputTokens: 64000, isVL: true, theosPerRequest: 10 },
  "claude-opus-5-5": { name: "Claude Opus 5.5", contextLength: 1000000, maxOutputTokens: 64000, isVL: true, theosPerRequest: 15 },
  "muse-wonder": { name: "Muse Wonder", contextLength: 1048576, maxOutputTokens: 131072, isVL: true, theosPerRequest: 15 },
  "qwen-3.8-max-prime": { name: "Qwen 3.8 Max Prime", contextLength: 1000000, maxOutputTokens: 131072, isVL: true, theosPerRequest: 15 },
  "claude-fable-5-2": { name: "Claude Fable 5.2", contextLength: 1000000, maxOutputTokens: 64000, isVL: true, theosPerRequest: 20 },
  "gpt-6-astra": { name: "GPT-6 Astra", contextLength: 1048576, maxOutputTokens: 128000, isVL: true, theosPerRequest: 50 }
};

const UNKNOWN_MODEL_SPEC = { contextLength: 1_048_576, maxOutputTokens: 131_072, isVL: false };

/** @type {Map<string, { expiresAt: number, models: any[], fetched: boolean }>} */
const catalogCache = new Map();

/** @type {Map<string, Promise<object|null>>} */
const inflight = new Map();

function cacheKey(credentials) {
  const seed =
    credentials?.connectionId ||
    credentials?.id ||
    credentials?.apiKey ||
    "anonymous";
  return createHash("sha256").update(`deepai:${seed}`).digest("hex");
}

export function normalizeDeepaiModels(body) {
  const rows = Array.isArray(body?.models)
    ? body.models
    : Array.isArray(body?.data)
      ? body.data
      : Array.isArray(body)
        ? body
        : [];
  const models = [];
  const seen = new Set();
  for (const row of rows) {
    const id = typeof row === "string" ? row : row?.id;
    if (!id || typeof id !== "string" || seen.has(id)) continue;
    seen.add(id);
    const spec = DEEPAI_STATIC_MODEL_SPECS[id] || UNKNOWN_MODEL_SPEC;
    const input = Array.isArray(row?.input) ? row.input : null;
    models.push({
      id,
      name: row?.name || spec.name || id,
      contextLength: row?.contextWindow || spec.contextLength,
      maxOutputTokens: row?.maxTokens || spec.maxOutputTokens,
      isVL: input ? input.includes("image") : spec.isVL,
      // The live API reports theosPerRequest as a string ("0"); the
      // static table keeps numbers — normalize to a number either way.
      theosPerRequest:
        row?.theosPerRequest !== undefined
          ? Number(row.theosPerRequest)
          : spec.theosPerRequest,
    });
  }
  return models;
}

async function fetchCatalogRaw(apiKey, proxyOptions = null, signal = null) {
  const response = await proxyAwareFetch(
    DEEPAI_MODELS_URL,
    {
      method: "GET",
      headers: buildDeepaiHeaders(apiKey),
      signal: signal || AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
    proxyOptions,
  );
  if (response.status === 401 || response.status === 403) {
    const err = new Error(`DeepAI rejected the account API key (${response.status})`);
    err.status = response.status;
    throw err;
  }
  if (!response.ok) return null;
  const body = await response.json().catch(() => null);
  if (!body) return null;
  const models = normalizeDeepaiModels(body);
  return models.length ? models : null;
}

/**
 * Resolve the live model catalog for a DeepAI credential. Returns
 * { models, fetched: true, expiresAt } or null when the catalog can't
 * be fetched (callers fall back to the static registry list).
 */
export async function resolveDeepaiModels(credentials, options = {}) {
  const key = cacheKey(credentials);
  const now = Date.now();
  if (!options.forceRefresh) {
    const cached = catalogCache.get(key);
    if (cached && cached.expiresAt > now) return cached;
    const existing = inflight.get(key);
    if (existing) return existing;
  }

  const fetchPromise = (async () => {
    const apiKey = credentials?.apiKey || "";
    if (!apiKey) return null;
    const models = await fetchCatalogRaw(apiKey, options.proxyOptions, options.signal);
    if (!models) return null;
    const entry = { expiresAt: Date.now() + CACHE_TTL_MS, models, fetched: true };
    catalogCache.set(key, entry);
    return entry;
  })();

  inflight.set(key, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    if (inflight.get(key) === fetchPromise) inflight.delete(key);
  }
}

export function invalidateDeepaiCatalog(credentials) {
  if (!credentials) return;
  catalogCache.delete(cacheKey(credentials));
}

export function clearDeepaiCatalog() {
  catalogCache.clear();
}
