/**
 * Meoo model catalog fetcher.
 *
 * The gateway (api.meoo.host/meoo-ai/compatible-mode/v1) is
 * OpenAI-compatible: GET /models with the project service AK as Bearer
 * returns the live catalog (bare ids — no context/output metadata), so
 * specs are merged in from the static table below. The table mirrors the
 * gateway ids attested by third-party clients against the official
 * pricing page (docs.meoo.com/coindesc, checked 2026-11); unknown ids
 * fall back to 200K context / 64K output, text-only.
 *
 * Cache shape and dedupe follow qoderModels.js: per-credential cache with
 * a 1h TTL and in-flight coalescing. When the gateway answers 401 the
 * stored AK is presumed stale: the catalog is invalidated and the AK is
 * re-resolved once via meooAk.resolveMeooCredentials (which refreshes
 * the OAuth token first when needed); callers that can persist pass
 * options.onCredentialsRefreshed so the fresh AK lands back on the
 * connection row.
 */

import { createHash } from "crypto";

import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { MEOO_GATEWAY_MODELS_URL } from "../shared/meoo/constants.js";
import { resolveMeooCredentials } from "./meooAk.js";

const FETCH_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h, same as the Qoder/Kiro catalogs

// Attested gateway ids + specs (context / max output / vision).
export const MEOO_STATIC_MODEL_SPECS = {
  "qwen3.8-flash": { name: "Qwen3.8-Flash", contextLength: 1_000_000, maxOutputTokens: 131_072, isVL: true },
  "qwen3.8-max": { name: "Qwen3.8-Max", contextLength: 1_000_000, maxOutputTokens: 131_072, isVL: true },
  "qwen3.7-max": { name: "Qwen3.7-Max", contextLength: 1_000_000, maxOutputTokens: 131_072, isVL: false },
  "qwen3.7-plus": { name: "Qwen3.7-Plus", contextLength: 1_000_000, maxOutputTokens: 131_072, isVL: true },
  // Listed on the official pricing page under this exact id; context/output
  // follow the Qwen-Max family pattern until the live catalog proves more.
  "Qwen4-Max-Preview": { name: "Qwen4-Max-Preview", contextLength: 1_000_000, maxOutputTokens: 131_072, isVL: true },
  "deepseek-v4.1-flash-1017": { name: "DeepSeek V4.1 Flash", contextLength: 1_000_000, maxOutputTokens: 393_216, isVL: true },
  "deepseek-v4-pro-0813": { name: "DeepSeek V4 Pro", contextLength: 1_000_000, maxOutputTokens: 393_216, isVL: false },
  "deepseek-v4-flash-0731": { name: "DeepSeek V4 Flash", contextLength: 1_000_000, maxOutputTokens: 393_216, isVL: false },
  "glm-5.2-fast-preview": { name: "GLM-5.2-Fast", contextLength: 1_000_000, maxOutputTokens: 131_072, isVL: false },
  "glm-5.2": { name: "GLM-5.2", contextLength: 1_000_000, maxOutputTokens: 131_072, isVL: false },
};

const UNKNOWN_MODEL_SPEC = { contextLength: 200_000, maxOutputTokens: 65_536, isVL: false };

/** @type {Map<string, { expiresAt: number, models: any[], fetched: boolean }>} */
const catalogCache = new Map();

/** @type {Map<string, Promise<object|null>>} */
const inflight = new Map();

function cacheKey(credentials) {
  const psd = credentials?.providerSpecificData || {};
  const seed =
    credentials?.connectionId ||
    credentials?.id ||
    psd.projectUrlId ||
    credentials?.refreshToken ||
    credentials?.apiKey ||
    "anonymous";
  return createHash("sha256").update(`meoo:${seed}`).digest("hex");
}

function projectAkFrom(credentials) {
  return credentials?.apiKey || credentials?.providerSpecificData?.projectApiKey || "";
}

function normalizeModels(body) {
  const rows = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
  const models = [];
  const seen = new Set();
  for (const row of rows) {
    const id = typeof row === "string" ? row : row?.id;
    if (!id || typeof id !== "string" || seen.has(id)) continue;
    seen.add(id);
    const spec = MEOO_STATIC_MODEL_SPECS[id] || UNKNOWN_MODEL_SPEC;
    models.push({
      id,
      name: spec.name || id,
      contextLength: spec.contextLength,
      maxOutputTokens: spec.maxOutputTokens,
      isVL: spec.isVL,
    });
  }
  return models;
}

async function fetchCatalogRaw(projectAk, proxyOptions = null, signal = null) {
  const response = await proxyAwareFetch(
    MEOO_GATEWAY_MODELS_URL,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${projectAk}`,
      },
      signal: signal || AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
    proxyOptions,
  );
  if (response.status === 401 || response.status === 403) {
    const err = new Error(`Meoo gateway rejected the project AK (${response.status})`);
    err.status = response.status;
    throw err;
  }
  if (!response.ok) return null;
  const body = await response.json().catch(() => null);
  if (!body) return null;
  const models = normalizeModels(body);
  return models.length ? models : null;
}

/**
 * Resolve the live model catalog for a Meoo credential. Returns
 * { models, fetched: true, expiresAt } or null when the catalog can't be
 * fetched (callers fall back to the static registry list).
 *
 * On a gateway 401/403 the stored AK is re-resolved once (OAuth refresh
 * included) and the fetch retried; options.onCredentialsRefreshed is
 * invoked with the refreshed credential set so the caller can persist it.
 */
export async function resolveMeooModels(credentials, options = {}) {
  const key = cacheKey(credentials);
  const now = Date.now();
  if (!options.forceRefresh) {
    const cached = catalogCache.get(key);
    if (cached && cached.expiresAt > now) return cached;
    const existing = inflight.get(key);
    if (existing) return existing;
  }

  const fetchPromise = (async () => {
    let projectAk = projectAkFrom(credentials);
    if (!projectAk) return null;

    let models = null;
    try {
      models = await fetchCatalogRaw(projectAk, options.proxyOptions, options.signal);
    } catch (err) {
      if (err?.status !== 401 && err?.status !== 403) throw err;
      // Stale AK: re-resolve through the control plane and retry once.
      options.log?.warn?.("MEOO", `Gateway rejected project AK (${err.status}); re-resolving`);
      catalogCache.delete(key);
      if (!credentials?.refreshToken && !credentials?.accessToken) return null;
      let refreshed;
      try {
        refreshed = await resolveMeooCredentials(credentials, {
          proxyOptions: options.proxyOptions,
          log: options.log,
          forceRefresh: false,
        });
      } catch (resolveErr) {
        options.log?.warn?.("MEOO", `AK re-resolution failed: ${resolveErr.message}`);
        // The token leg may have rotated the pair before AK resolution
        // failed — hand it to the persisting caller so it isn't lost.
        if (resolveErr?.refreshed && options.onCredentialsRefreshed) {
          try {
            await options.onCredentialsRefreshed(resolveErr.refreshed);
          } catch { /* best effort */ }
        }
        return null;
      }
      if (options.onCredentialsRefreshed && refreshed) {
        try {
          await options.onCredentialsRefreshed(refreshed);
        } catch (persistErr) {
          options.log?.warn?.("MEOO", `Persisting refreshed AK failed: ${persistErr.message}`);
        }
      }
      projectAk = refreshed?.apiKey || "";
      if (!projectAk) return null;
      models = await fetchCatalogRaw(projectAk, options.proxyOptions, options.signal).catch(() => null);
    }

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

export function invalidateMeooCatalog(credentials) {
  if (!credentials) return;
  catalogCache.delete(cacheKey(credentials));
}

export function clearMeooCatalog() {
  catalogCache.clear();
}
