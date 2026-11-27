/**
 * QwenWork model catalog fetcher.
 *
 * Calls /algo/api/v2/model/list (COSY-signed) on the account's gateway host
 * to get the live catalog, then caches the per-model config blocks by key.
 * Chat requests look up the exact server-published metadata for the model
 * they want — the chat endpoint silently downgrades when the wrong
 * model_config is sent.
 *
 * The catalog response groups entries by scene; QwenWork's own scene is
 * `qwork` (the desktop client's modelSelector reads it). Entries carry the
 * same fields as Qoder's catalog (display_name, max_input_tokens, is_vl,
 * is_reasoning, price_factor, promotion, enable, ...).
 *
 * Auth is the OAuth device token directly — QwenWork has no PAT/job-token
 * layer. Cache/dedupe shape follows qoderModels.js.
 */

import { createHash } from "crypto";

import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { buildCosyHeaders } from "../shared/qoder/cosy.js";
import { QWENWORK_COSY_SITE, qwenworkClientHeaders, qwenworkSite } from "../shared/qwenwork/constants.js";

const FETCH_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h, same as the Qoder catalog

/** @type {Map<string, { expiresAt: number, models: any[], rawConfigs: Map<string, object>, fetched: boolean }>} */
const catalogCache = new Map();

/** @type {Map<string, Promise<object|null>>} */
const inflight = new Map();

function cacheKey(credentials) {
  const psd = credentials?.providerSpecificData || {};
  const seed = psd.userId || credentials?.refreshToken || credentials?.accessToken || "anonymous";
  const provider = credentials?.provider || "qwenwork";
  return createHash("sha256").update(`qwenwork:${provider}:${seed}`).digest("hex");
}

/**
 * Stable per-connection machine id. The OAuth framework does not hand
 * the device-flow machineId back to the token callback, so connections
 * are stored with an empty one and buildCosyHeaders would mint a fresh
 * random id per request — every catalog fetch then looks like a brand
 * new device. The desktop client persists ONE machine id per account;
 * derive the same stability here by hashing provider+userId into a
 * UUID-shaped value (the id is an opaque string to the server).
 */
function deriveMachineId(provider, userId) {
  const hex = createHash("sha256").update(`qwenwork-machine:${provider}:${userId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function cosyCredsFromConnection(credentials) {
  const psd = credentials?.providerSpecificData || {};
  return {
    userId: psd.userId,
    authToken: credentials.accessToken,
    name: credentials.displayName || "",
    email: credentials.email || "",
    machineId: psd.machineId || deriveMachineId(credentials?.provider || "qwenwork", psd.userId || ""),
  };
}

/**
 * Fetch the live model list for this credential. Returns
 *   { models: [...], rawConfigs: Map<modelKey, rawEntry> }
 * or `null` on any error.
 */
async function fetchQwenWorkCatalogRaw(credentials, signal, proxyOptions = null) {
  const creds = cosyCredsFromConnection(credentials);
  if (!creds.userId || !creds.authToken) return null;

  const site = qwenworkSite(credentials?.provider);
  const headers = {
    Accept: "application/json",
    "Accept-Encoding": "identity",
    ...buildCosyHeaders(Buffer.alloc(0), site.modelListUrl, creds, QWENWORK_COSY_SITE),
    // Desktop-client identity headers — without them the server does
    // not recognize an official client and the international gateway
    // serves a reduced catalog (tiers only, no direct model keys).
    ...qwenworkClientHeaders(),
  };

  const controller = new AbortController();
  let timer = null;
  let abortListener = null;
  let response;
  try {
    timer = setTimeout(() => controller.abort("timeout"), FETCH_TIMEOUT_MS);
    if (signal && typeof signal.addEventListener === "function") {
      if (signal.aborted) {
        controller.abort(signal.reason);
      } else {
        abortListener = () => controller.abort(signal.reason);
        signal.addEventListener("abort", abortListener);
      }
    }
    response = await proxyAwareFetch(
      site.modelListUrl,
      { method: "GET", headers, signal: controller.signal },
      proxyOptions,
    );
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
  }

  if (!response.ok) {
    console.warn(`[QwenWorkModels] catalog fetch failed: HTTP ${response.status} (${site.modelListUrl})`);
    return null;
  }

  const body = await response.json().catch(() => null);
  if (!body || typeof body !== "object") return null;

  // Live-observed 2026-11-21: the account's full catalog rides in the
  // `qwork` scene (CN: 13 entries; chat empty, no app scene). Merge the
  // scene arrays anyway — first scene wins per key — so a deployment
  // that does split scenes cannot silently lose models; the merge is
  // defensive, the per-scene counts are logged for diagnosis.
  const sceneNames = ["qwork", "chat", "app"];
  const entries = [];
  const seen = new Set();
  for (const scene of sceneNames) {
    const list = body[scene];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const key = entry && typeof entry === "object" ? entry.key : null;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
    }
  }
  console.log(
    `[QwenWorkModels] catalog scenes: ${sceneNames.map((s) => `${s}=${Array.isArray(body[s]) ? body[s].length : "-"}`).join(" ")} merged=${entries.length} keys=${entries.map((e) => e.key).join(",")}`,
  );
  if (!entries.length) {
    console.warn(`[QwenWorkModels] catalog empty in all scenes; top-level keys: ${Object.keys(body).join(",")}`);
    return null;
  }

  const rawConfigs = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const key = entry.key;
    if (!key) continue;

    // Always cache the config — chat needs it even for UI-hidden models
    // (enable:false). Upstream still accepts chat for these keys.
    rawConfigs.set(key, entry);
  }

  // chat-modes-v2 (GET /api/desktop/chat-modes) — the desktop client's own
  // catalog strategy. /algo/api/v2/model/list serves the tier modes only on
  // the international gateway (3 entries, 2026-11-22 live probe) while the
  // desktop picker lists the direct models from THIS endpoint (qwen4-max,
  // qwen3.8-max, deepseek-flash=DeepSeek-V4.1-Flash, kimi-k3.1-pro, ...).
  // Merge per key: chat-modes fields win (fresher client-attested config),
  // model/list-only fields (max_output_tokens, promotion) survive; keys that
  // only chat-modes carries are new rows. Best-effort: a chat-modes failure
  // keeps the model/list catalog intact.
  const chatModes = await fetchQwenWorkChatModesRaw(credentials, signal, proxyOptions).catch((e) => {
    console.warn(`[QwenWorkModels] chat-modes fetch failed: ${e?.message || e}`);
    return null;
  });
  if (chatModes?.length) {
    let added = 0;
    for (const cm of chatModes) {
      if (!cm || !cm.key) continue;
      const prev = rawConfigs.get(cm.key);
      rawConfigs.set(cm.key, prev ? { ...prev, ...cm, key: cm.key } : cm);
      if (!prev) added++;
    }
    console.log(`[QwenWorkModels] chat-modes: ${chatModes.length} entries merged (+${added} new keys)`);
  } else {
    console.warn("[QwenWorkModels] chat-modes unavailable — catalog is model/list only");
  }

  const models = [];
  for (const entry of rawConfigs.values()) {
    const key = entry.key;
    const display = entry.display_name || key;
    const ctx = Number(entry.max_input_tokens) || 131_072;
    // price_factor 0 is NOT "free" by itself: intl tier models publish 0 yet
    // bill from the plan's credit pool (live 2026-11-22 — a 2,136-token chat
    // on qwork-auto drew ~0.52 credits). Only an active promotion makes zero
    // actually free (CN 标准「会员限免」, ling-3.1「限时1折」) — otherwise the
    // multiplier stays unpublished so ModelRow renders no misleading badge.
    //
    // `promotion` is the authoritative promo source, NOT chat-modes' `badges[]`
    // (which the shape comment below mentions without any code reading it —
    // that is deliberate, not a gap). Live 2026-11-27, four real accounts:
    // every CN row carrying badges ALSO carries an identical promotion (8/8,
    // wording byte-equal), no row has badges alone, and model/list publishes
    // promotion on 8 rows with badges on ZERO — the 标准 tier row's free state
    // is reachable only through promotion. So badges is a client-side mirror:
    // consuming it would be redundant at best and would go silent on a
    // model/list-only deployment. `badges` still survives untouched in
    // rawConfigs for anything that ever needs the client's exact payload.
    const promoActive = !!(entry.promotion && entry.promotion.active !== false);
    const priceRaw = typeof entry.price_factor === "number" ? entry.price_factor : null;
    models.push({
      id: key,
      name: `${display}`,
      contextLength: ctx,
      isVL: !!entry.is_vl,
      isReasoning: !!entry.is_reasoning,
      maxOutputTokens: Number(entry.max_output_tokens) || 0,
      description: entry.description || "",
      rateMultiplier: priceRaw === 0 && !promoActive ? null : priceRaw,
      originalRateMultiplier: typeof entry.original_price_factor === "number" ? entry.original_price_factor : null,
      promotion: entry.promotion && typeof entry.promotion === "object" ? entry.promotion : null,
      enabled: entry.enable !== false,
    });
  }

  return { models, rawConfigs };
}

/**
 * chat-modes-v2 catalog (GET /api/desktop/chat-modes) — the desktop client's
 * own model-list strategy (DesktopChatModesV2CatalogProvider, bundle id
 * "chat-modes-v2"): plain Bearer access token + client identity headers,
 * no COSY signing. Response (live 2026-11-22, intl):
 *   { schema_version: 2, catalog: [ { key, i18n: { display_name: {en, zh},
 *     description: {…} }, enable, format, harness, is_reasoning, is_vl,
 *     max_input_tokens, price_factor, frontier, context_config,
 *     model_params, thinking_config, badges[] } ], subtask_routing: {…} }
 * Tier modes and direct models can share a key (qwen3.8-flash is both the
 * 标准 tier and a direct model) — later entries win on key collision, which
 * keeps the direct entry's model-shaped display name over the tier label.
 * Returns adapted entries (display_name/description lifted from i18n) or
 * null on any failure.
 */
async function fetchQwenWorkChatModesRaw(credentials, signal, proxyOptions = null) {
  if (!credentials?.accessToken) return null;
  const site = qwenworkSite(credentials?.provider);
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${credentials.accessToken}`,
    ...qwenworkClientHeaders(),
  };
  const controller = new AbortController();
  let timer = null;
  let abortListener = null;
  let response;
  try {
    timer = setTimeout(() => controller.abort("timeout"), FETCH_TIMEOUT_MS);
    if (signal && typeof signal.addEventListener === "function") {
      if (signal.aborted) {
        controller.abort(signal.reason);
      } else {
        abortListener = () => controller.abort(signal.reason);
        signal.addEventListener("abort", abortListener);
      }
    }
    response = await proxyAwareFetch(
      site.chatModesUrl,
      { method: "GET", headers, signal: controller.signal },
      proxyOptions,
    );
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
  }

  if (!response.ok) {
    console.warn(`[QwenWorkModels] chat-modes fetch failed: HTTP ${response.status} (${site.chatModesUrl})`);
    return null;
  }
  const body = await response.json().catch(() => null);
  const catalog = Array.isArray(body?.catalog) ? body.catalog : null;
  if (!catalog) {
    console.warn(`[QwenWorkModels] chat-modes response missing catalog array; top-level keys: ${body && typeof body === "object" ? Object.keys(body).join(",") : typeof body}`);
    return null;
  }

  // Tier modes (frontier:false — 标准/高级/旗舰) are selected through the
  // tier dropdown, never listed as models; a direct entry sharing a tier
  // key is hidden by the client too (intl live: 11 modes = 3 tiers + 8
  // direct, the picker lists only the 6 direct whose keys don't collide).
  const tierKeys = new Set(
    catalog
      .filter((e) => e && typeof e === "object" && e.frontier === false && typeof e.key === "string")
      .map((e) => e.key),
  );
  const entries = [];
  const seen = new Set();
  for (const entry of catalog) {
    if (!entry || typeof entry !== "object") continue;
    const key = typeof entry.key === "string" && entry.key ? entry.key : null;
    if (!key || tierKeys.has(key)) continue;
    const i18n = entry.i18n && typeof entry.i18n === "object" ? entry.i18n : {};
    const displayName = i18n.display_name && typeof i18n.display_name === "object" ? i18n.display_name : {};
    const description = i18n.description && typeof i18n.description === "object" ? i18n.description : {};
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      ...entry,
      display_name: displayName.zh || displayName.en || key,
      description: description.zh || description.en || "",
    });
  }
  return entries;
}

/**
 * Get the cached model config block for a given model key, fetching the
 * catalog first if needed. Returns null when the catalog can't be fetched.
 * The QwenWork chat codec sends a SLIM model_config (see executors/qwenwork),
 * so callers get the raw catalog entry and pick the fields they need.
 */
export async function getQwenWorkModelConfig(credentials, modelKey, options = {}) {
  const cached = await resolveQwenWorkModels(credentials, options);
  if (!cached) return null;
  const config = cached.rawConfigs.get(modelKey);
  if (!config) return null;
  return { ...config, key: modelKey };
}

/**
 * Resolve the live model catalog + raw configs for a credential. Caches
 * results for CACHE_TTL_MS and deduplicates concurrent misses.
 */
export async function resolveQwenWorkModels(credentials, options = {}) {
  if (!credentials?.accessToken || !(credentials.providerSpecificData || {}).userId) return null;

  const key = cacheKey(credentials);
  const now = Date.now();
  if (!options.forceRefresh) {
    const cached = catalogCache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached;
    }
  }

  const existing = inflight.get(key);
  if (existing && !options.forceRefresh) {
    return existing;
  }

  const fetchPromise = (async () => {
    const fetched = await fetchQwenWorkCatalogRaw(credentials, options.signal, options.proxyOptions);
    if (!fetched) return null;
    const entry = {
      expiresAt: Date.now() + CACHE_TTL_MS,
      models: fetched.models,
      rawConfigs: fetched.rawConfigs,
      fetched: true,
    };
    catalogCache.set(key, entry);
    return entry;
  })();

  inflight.set(key, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    if (inflight.get(key) === fetchPromise) {
      inflight.delete(key);
    }
  }
}

export function invalidateQwenWorkCatalog(credentials) {
  if (!credentials) return;
  catalogCache.delete(cacheKey(credentials));
}

export function clearQwenWorkCatalog() {
  catalogCache.clear();
}
