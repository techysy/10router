/**
 * Credential-backed live model catalogues.
 *
 * The registry `models[]` arrays are an offline floor: they answer /v1/models
 * before any account is added and keep working when an upstream is unreachable.
 * They are NOT the contract. Several providers here add/retire models
 * server-side (Loomy, Raccoon, AtomCode, CodeArts, OfficeAce, Trae SOLO), and a
 * stale floor advertises names that 400 or, worse for strict providers, hides
 * names that work. This module fetches each account's real catalogue, caches it
 * briefly, and reports the capability bits the upstream actually declared.
 *
 * Contract with callers:
 *   • resolve*(connection, { forceRefresh, allowStale, proxyOptions })
 *       → { models, fetchedAt, source: "live", stale?: true, error?: string }
 *       → throws when the fetch fails and no usable cache exists (or when
 *         `allowStale === false`, which is what the Test button uses).
 *   • `models[]` entries are `{ id, name, capabilities? }`; absent capability
 *     bits are omitted, never invented as false/0 (the route merges them over
 *     the static table, where "absent" and "false" mean different things).
 *
 * Cache keying is per connection (id/email), NOT per provider: two accounts can
 * see different catalogues and a validation probe must reflect the account it
 * was run against. Failures never clear a previously good catalogue; the route
 * then keeps serving the last known-good list.
 */
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { LIVE_CATALOG_PROVIDER_IDS } from "../config/liveCatalogProviders.js";
import { rememberLiveModels } from "./model.js";
import {
  LOBSTERAI_API_BASE,
  LOBSTERAI_PATHS,
  LOBSTERAI_USER_AGENT,
  LOBSTERAI_CLIENT_CAPABILITIES,
  LOBSTERAI_REQUEST_TIMEOUT_MS,
} from "../shared/lobsterai/constants.js";
import { keyfromFields, resolveClientVersion, messageOf } from "../shared/lobsterai/client.js";
import { RACCOON_LLM_BASE_URL, RACCOON_REQUEST_TIMEOUT_MS } from "../config/raccoon.js";
import {
  ATOMCODE_ADAPTER_USER_AGENT,
  ATOMCODE_CODINGPLAN_MODELS_PATH,
  ATOMCODE_CODINGPLAN_STATUS_PATH,
  ATOMCODE_REQUEST_TIMEOUT_MS,
  atomcodeCodingPlanBase,
  atomcodeGatewayBase,
} from "../shared/atomcode/constants.js";
import {
  CODEARTS_BASE_URL,
  CODEARTS_BENEFIT_GATEWAY_URL,
  CODEARTS_CLIENT_HEADERS,
} from "../config/codearts.js";
import { codeArtsFetch, resolveCodeArtsCredential } from "../shared/codearts/client.js";
import {
  OFFICEACE_DEFAULT_GATEWAY_BASE,
  normalizeOfficeaceGatewayBase,
} from "../config/officeace.js";
import {
  TRAE_SOLO_AGENT_BASE_URL,
  buildTraeSoloHeaders,
} from "../executors/trae-solo.js";

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const CATALOG_TIMEOUT_MS = 20_000;
const CODEARTS_MAX_OUTPUT = 65_536; // measured platform wall, see config/codearts.js
// Agent detail is one signed GET per agent. The list page can hold many agents,
// so cap the fan-out and stop once the catalogue budget is spent: a picker that
// waits minutes for its 40th agent is worse than one that shows builtin and
// benefit models alongside the first slices.
const CODEARTS_AGENT_DETAIL_LIMIT = 50;
const CODEARTS_AGENT_CONCURRENCY = 5;
const CODEARTS_AGENT_BUDGET_MS = 20_000;

/** per-connection cache: `${provider}:${id|email|default}` */
const catalogCache = new Map();
const inflight = new Map();

/** Test helper: forget every cached catalogue / in-flight promise. */
export function resetLiveCatalogCache() {
  catalogCache.clear();
  inflight.clear();
}

function cacheKey(provider, connection) {
  const identity = connection?.id || connection?.email || connection?.providerSpecificData?.email || "default";
  return `${provider}:${identity}`;
}

function tokenOf(connection) {
  return String(connection?.accessToken || connection?.apiKey || "").trim();
}

function num(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function positive(value) {
  const parsed = num(value);
  return parsed !== null && parsed > 0 ? Math.floor(parsed) : null;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function capabilitiesOf({ tools, vision, reasoning, contextWindow, maxOutput } = {}) {
  const caps = {};
  if (typeof tools === "boolean") caps.tools = tools;
  if (typeof vision === "boolean") caps.vision = vision;
  if (typeof reasoning === "boolean") caps.reasoning = reasoning;
  if (positive(contextWindow) !== null) caps.contextWindow = positive(contextWindow);
  if (positive(maxOutput) !== null) caps.maxOutput = positive(maxOutput);
  return Object.keys(caps).length ? caps : undefined;
}

function catalogEntry(id, name, capsInput) {
  const trimmed = text(id);
  if (!trimmed) return null;
  const entry = { id: trimmed, name: text(name) || trimmed };
  const capabilities = capabilitiesOf(capsInput);
  if (capabilities) entry.capabilities = capabilities;
  return entry;
}

function dedupe(entries, { caseInsensitive = false } = {}) {
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    if (!entry) continue;
    const key = caseInsensitive ? entry.id.toLowerCase() : entry.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

async function fetchWithProxy(url, options, proxyOptions, timeoutMs = CATALOG_TIMEOUT_MS) {
  return proxyAwareFetch(
    url,
    {
      ...options,
      signal: options?.signal || AbortSignal.timeout(timeoutMs),
    },
    proxyOptions
  );
}

async function readJson(response, label) {
  const raw = await response.text().catch(() => "");
  if (!response.ok) {
    const snippet = raw.trim().slice(0, 240);
    throw new Error(`${label} 返回 HTTP ${response.status}${snippet ? `：${snippet}` : ""}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} 响应不是 JSON（HTTP ${response.status}）：${raw.trim().slice(0, 160)}`);
  }
}

/**
 * Cached fetch wrapper shared by every provider below.
 * `builder` resolves an array of `{id, name, capabilities?}`.
 */
async function cachedCatalog(provider, connection, options, builder) {
  const key = cacheKey(provider, connection);
  const cached = catalogCache.get(key);
  const ttlMs = options.ttlMs || DEFAULT_TTL_MS;

  if (!options.forceRefresh && cached?.models?.length && Date.now() - cached.fetchedAt < ttlMs) {
    return { ...cached, source: "live", stale: false };
  }

  const active = inflight.get(key);
  if (active) return active;

  const task = (async () => {
    try {
      const models = dedupe((await builder()) || [], {
        caseInsensitive: options.caseInsensitiveIds === true,
      });
      if (!models.length) throw new Error("上游未返回可用模型");
      const next = { models, fetchedAt: Date.now() };
      catalogCache.set(key, next);
      rememberLiveModels(provider, models.map((model) => model.id));
      return { ...next, source: "live", stale: false };
    } catch (error) {
      const message = error?.message || String(error);
      if (cached?.models?.length && options.allowStale !== false) {
        return { ...cached, source: "cache", stale: true, error: message };
      }
      throw error;
    }
  })();

  inflight.set(key, task);
  try {
    return await task;
  } finally {
    if (inflight.get(key) === task) inflight.delete(key);
  }
}

// ─── Loomy ────────────────────────────────────────────────────────────────

const LOOMY_MODELS_URL = "https://loomyad.xunfei.cn/api/v1/models";

/**
 * `{ data: [{ id, name, type, context_length, max_output_tokens,
 *   capabilities: { reasoning, vision, function_calling, input_modalities } }] }`
 * Image entries share the list (`type: "image"`); the LLM surface must not
 * advertise them, so they are filtered rather than mis-kinded.
 */
export function parseLoomyCatalog(payload) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  const entries = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const type = text(row.type).toLowerCase();
    if (type && type !== "chat") continue;
    const caps = row.capabilities && typeof row.capabilities === "object" ? row.capabilities : {};
    const modalities = Array.isArray(caps.input_modalities) ? caps.input_modalities : [];
    entries.push(
      catalogEntry(row.id, row.name, {
        tools: typeof caps.function_calling === "boolean" ? caps.function_calling : true,
        vision: Boolean(caps.vision) || modalities.some((m) => String(m).toLowerCase() === "image"),
        reasoning: Boolean(caps.reasoning),
        contextWindow: row.context_length,
        maxOutput: row.max_output_tokens,
      })
    );
  }
  return dedupe(entries);
}

export async function resolveLoomyCatalog(connection, options = {}) {
  const token = tokenOf(connection);
  if (!token) throw new Error("Loomy 连接缺少 session token");
  return cachedCatalog("loomy", connection, options, async () => {
    const response = await fetchWithProxy(
      LOOMY_MODELS_URL,
      {
        method: "GET",
        headers: {
          // Both planes are sent: chat reads Bearer, the business plane `token`.
          token,
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      },
      options.proxyOptions
    );
    return parseLoomyCatalog(await readJson(response, "Loomy 模型目录"));
  });
}

// ─── LobsterAI ────────────────────────────────────────────────────────────

function lobsterArrayOf(payload) {
  if (Array.isArray(payload)) return payload;
  const data = payload?.data;
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    for (const key of ["data", "models", "list"]) {
      if (Array.isArray(data[key])) return data[key];
    }
  }
  return [];
}

/**
 * `{ data: [{ modelId, modelName, contextWindow, maxTokens, supportsImage,
 *   supportsThinking, costMultiplier }] }`. The envelope's `data` is an ARRAY
 * (not the usual object), so a generic object-envelope parser must not be used.
 */
export function parseLobsterAiCatalog(payload) {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const code = Number(payload.code);
    if (Number.isFinite(code) && code !== 0) {
      throw new Error(messageOf(payload) || `LobsterAI 模型目录返回 code=${payload.code}`);
    }
  }
  const entries = [];
  for (const row of lobsterArrayOf(payload)) {
    if (!row || typeof row !== "object") continue;
    entries.push(
      catalogEntry(row.modelId, row.modelName, {
        tools: true,
        vision: typeof row.supportsImage === "boolean" ? row.supportsImage : undefined,
        reasoning: Boolean(row.supportsThinking) || Boolean(row.thinkingConfig),
        contextWindow: row.contextWindow,
        maxOutput: row.maxTokens,
      })
    );
  }
  return dedupe(entries);
}

export async function resolveLobsterAiCatalog(connection, options = {}) {
  const token = tokenOf(connection);
  if (!token) throw new Error("LobsterAI 连接缺少 access token");
  return cachedCatalog("lobsterai", connection, options, async () => {
    const version = await resolveClientVersion();
    const psd = connection.providerSpecificData || {};
    const query = new URLSearchParams(keyfromFields(psd, version)).toString();
    const url = `${LOBSTERAI_API_BASE}${LOBSTERAI_PATHS.models}${query ? `?${query}` : ""}`;
    const response = await fetchWithProxy(
      url,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "X-LobsterAI-Client-Capabilities": LOBSTERAI_CLIENT_CAPABILITIES,
          "X-LobsterAI-Client-Version": version,
          "User-Agent": LOBSTERAI_USER_AGENT,
        },
      },
      options.proxyOptions,
      LOBSTERAI_REQUEST_TIMEOUT_MS
    );
    return parseLobsterAiCatalog(await readJson(response, "LobsterAI 模型目录"));
  });
}

// ─── AtomCode ─────────────────────────────────────────────────────────────

/** Tier name from `status-v2` (`codingplan_free.plan_name`, then `plan_type`). */
export function atomcodePlanTier(statusPayload) {
  const name =
    text(statusPayload?.codingplan_free?.plan_name) || text(statusPayload?.plan_type);
  const lower = name.toLowerCase();
  if (lower.includes("max")) return "Max";
  if (lower.includes("pro")) return "Pro";
  if (lower.includes("lite")) return "Lite";
  return null;
}

/** CodingPlan rows: `display_model_name` is the wire id, `id` is numeric. */
export function parseAtomcodePlanCatalog(payload) {
  const rows = Array.isArray(payload?.models)
    ? payload.models
    : Array.isArray(payload)
      ? payload
      : [];
  const entries = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    if (row.plan_available !== true) continue;
    const id = text(row.display_model_name);
    if (!id) continue;
    const levels = Array.isArray(row.reasoning_effort_levels)
      ? row.reasoning_effort_levels.filter((level) => typeof level === "string" && level.trim())
      : [];
    entries.push(
      catalogEntry(id, id, {
        tools: true,
        vision: typeof row.supports_vision === "boolean" ? row.supports_vision : undefined,
        reasoning: levels.length > 0,
        contextWindow: row.context_window,
      })
    );
  }
  return dedupe(entries);
}

/** AI Hub `/v1/models` (OpenAI envelope) on the chat gateway. */
export function parseAtomcodeGatewayCatalog(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : [];
  const entries = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    entries.push(
      catalogEntry(row.id, row.name || row.display_name, {
        tools: true,
        vision: typeof row.supports_vision === "boolean" ? row.supports_vision : undefined,
        reasoning: Boolean(row.supports_reasoning),
        contextWindow: row.context_length || row.context_window,
        maxOutput: row.max_output_tokens || row.max_tokens,
      })
    );
  }
  return dedupe(entries);
}

async function atomcodeJson(url, token, options, label) {
  const response = await fetchWithProxy(
    url,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": ATOMCODE_ADAPTER_USER_AGENT,
      },
    },
    options.proxyOptions,
    ATOMCODE_REQUEST_TIMEOUT_MS
  );
  return readJson(response, label);
}

export async function resolveAtomcodeCatalog(connection, options = {}) {
  const token = tokenOf(connection);
  if (!token) throw new Error("AtomCode 连接缺少 OAuth bearer");
  return cachedCatalog("atomcode", connection, options, async () => {
    const base = atomcodeCodingPlanBase();
    let tier = null;
    try {
      const status = await atomcodeJson(
        `${base}${ATOMCODE_CODINGPLAN_STATUS_PATH}`,
        token,
        options,
        "AtomCode 套餐状态"
      );
      tier = atomcodePlanTier(status);
    } catch {
      // Status is only a tier hint; the catalogue is still worth trying.
    }

    const tiers = tier ? [tier] : ["Lite", "Pro", "Max"];
    let planModels = [];
    let lastError = null;
    for (const candidate of tiers) {
      try {
        const payload = await atomcodeJson(
          `${base}${ATOMCODE_CODINGPLAN_MODELS_PATH}?plan_type=${encodeURIComponent(candidate)}`,
          token,
          options,
          "AtomCode 模型目录"
        );
        const parsed = parseAtomcodePlanCatalog(payload);
        if (parsed.length) {
          planModels = parsed;
          break;
        }
      } catch (error) {
        lastError = error;
      }
    }

    // AI Hub is a separate pool on the same gateway. A catalogue-only plan
    // account may list nothing there; that is not a failure.
    let hubModels = [];
    try {
      const payload = await atomcodeJson(
        `${atomcodeGatewayBase()}/models`,
        token,
        options,
        "AtomCode AI Hub 目录"
      );
      hubModels = parseAtomcodeGatewayCatalog(payload);
    } catch {
      // Keep the plan pool; the static AI Hub entries remain as the offline floor.
    }

    const merged = dedupe([...planModels, ...hubModels], { caseInsensitive: true });
    if (!merged.length && lastError) throw lastError;
    return merged;
  });
}

// ─── Raccoon ──────────────────────────────────────────────────────────────

/**
 * `{ data: { categories: [{ models: [{ name, displayName, description,
 *   tags, params: { context_window, max_tokens }, supportImage,
 *   supportThinking }] }] } }`. `name` is the WIRE id; `displayName` is a
 * label only when short (longer strings are sentences).
 */
export function parseRaccoonCatalog(payload) {
  const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  const categories = Array.isArray(data?.categories) ? data.categories : [];
  const entries = [];
  for (const category of categories) {
    const rows = Array.isArray(category?.models) ? category.models : [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const id = text(row.name) || text(row.model_name);
      if (!id) continue;
      const display = text(row.displayName);
      const name = display && display.length <= 64 ? display : id;
      const params = row.params && typeof row.params === "object" ? row.params : {};
      const tags = Array.isArray(row.tags)
        ? row.tags.map((tag) => String(tag).toLowerCase())
        : [];
      const imageByTag = tags.some((tag) =>
        ["vision", "image", "image-understanding", "multimodal"].includes(tag)
      );
      entries.push(
        catalogEntry(id, name, {
          tools: true,
          vision: row.supportImage === true || row.supportsImage === true || imageByTag,
          reasoning: row.supportThinking !== false,
          contextWindow: params.context_window ?? row.contextWindow ?? row.context_window,
          maxOutput: params.max_tokens ?? row.maxTokens ?? row.max_tokens,
        })
      );
    }
  }
  return dedupe(entries);
}

export async function resolveRaccoonCatalog(connection, options = {}) {
  const token = tokenOf(connection);
  return cachedCatalog("raccoon", connection, options, async () => {
    const headers = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetchWithProxy(
      `${RACCOON_LLM_BASE_URL}/model_catalog`,
      { method: "GET", headers },
      options.proxyOptions,
      RACCOON_REQUEST_TIMEOUT_MS
    );
    return parseRaccoonCatalog(await readJson(response, "Raccoon 模型目录"));
  });
}

// ─── CodeArts ─────────────────────────────────────────────────────────────

function codeartsBase(connection) {
  return text(connection?.providerSpecificData?.baseUrl) || CODEARTS_BASE_URL;
}

function codeartsBenefitGateway(connection) {
  return (
    text(connection?.providerSpecificData?.benefitGatewayUrl) || CODEARTS_BENEFIT_GATEWAY_URL
  );
}

function codeartsModelsFromParams(parameters, entry, id) {
  const name = text(entry?.model_name) || id;
  const maxOutput = positive(parameters?.max_tokens);
  return catalogEntry(id, name, {
    tools: true,
    vision:
      typeof parameters?.supports_images === "boolean" ? parameters.supports_images : undefined,
    contextWindow: parameters?.context_window,
    maxOutput: maxOutput === null ? undefined : Math.min(maxOutput, CODEARTS_MAX_OUTPUT),
  });
}

/** `/v1/model/builtin` → `{ builtinModels: [...] }`. */
export function parseCodeartsBuiltin(payload) {
  const rows = Array.isArray(payload?.builtinModels) ? payload.builtinModels : [];
  const entries = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    if (row.enable === false) continue;
    const id = text(row.model_id) || text(row.model_name);
    if (!id) continue;
    entries.push(
      catalogEntry(id, text(row.model_name) || id, {
        tools: true,
        vision: typeof row.supports_images === "boolean" ? row.supports_images : undefined,
        contextWindow: row.context_window,
        maxOutput:
          positive(row.max_tokens) === null
            ? undefined
            : Math.min(positive(row.max_tokens), CODEARTS_MAX_OUTPUT),
      })
    );
  }
  return dedupe(entries);
}

/** `/v1/agent-center/agents/detail` → `gpts.models` (display_enabled required). */
export function parseCodeartsAgentDetail(payload) {
  const rows = Array.isArray(payload?.gpts?.models) ? payload.gpts.models : [];
  const entries = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const parameters = row.model_parameters && typeof row.model_parameters === "object"
      ? row.model_parameters
      : {};
    if (parameters.enabled === false) continue;
    if (parameters.display_enabled !== true) continue;
    const id =
      text(parameters.model_id) || text(row.model_alias) || text(row.model_id);
    if (!id) continue;
    entries.push(codeartsModelsFromParams(parameters, row, id));
  }
  return dedupe(entries);
}

/** `/v1/benefit-gateway-config` → boolean switch. */
export function parseCodeartsBenefitGate(payload) {
  return payload?.enabled === true;
}

/** Benefit gateway `/api/v1/gateway/config` → `result.models[]`. */
export function parseCodeartsBenefit(payload) {
  if (text(payload?.error_code) !== "0000") {
    throw new Error(
      `CodeArts 福利目录未成功（error_code=${text(payload?.error_code) || "?"}）`
    );
  }
  const rows = Array.isArray(payload?.result?.models) ? payload.result.models : [];
  const sorted = [...rows].sort((a, b) => (num(a?.sort) ?? 0) - (num(b?.sort) ?? 0));
  const entries = [];
  for (const row of sorted) {
    if (!row || typeof row !== "object") continue;
    const id = text(row.model_id);
    if (!id) continue;
    entries.push(
      catalogEntry(id, text(row.model_name) || id, {
        tools: true,
        contextWindow: row.context_window,
        maxOutput:
          positive(row.max_tokens) === null
            ? undefined
            : Math.min(positive(row.max_tokens), CODEARTS_MAX_OUTPUT),
      })
    );
  }
  return dedupe(entries);
}

async function codeartsJson(url, { credential, agentType, includeHost, domainless, language, version, proxyOptions }) {
  const signingCredential = domainless ? { ...credential, domainId: "" } : credential;
  const headers = {
    Accept: "application/json",
    ...CODEARTS_CLIENT_HEADERS,
    "X-Language": language,
    "plugin-name": "snap_vscode",
    "plugin-version": version,
    client_version: `Vscode_${version}`,
    is_confidential: "false",
  };
  if (agentType) headers["Agent-Type"] = agentType;
  const response = await codeArtsFetch(url, {
    method: "GET",
    headers,
    credential: signingCredential,
    includeHost,
    proxyOptions,
    timeoutMs: 30_000,
  });
  return readJson(response, "CodeArts 模型目录");
}

export async function resolveCodeartsCatalog(connection, options = {}) {
  const credential = resolveCodeArtsCredential(connection);
  if (!credential) throw new Error("CodeArts 连接缺少可签名的 AK/SK");
  return cachedCatalog("codearts", connection, options, async () => {
    const base = codeartsBase(connection).replace(/\/+$/, "");
    const benefitGateway = codeartsBenefitGateway(connection).replace(/\/+$/, "");
    const version = text(connection?.providerSpecificData?.pluginVersion) || "1.0.0";
    const language = text(connection?.providerSpecificData?.language) || "en-us";
    const shared = {
      credential,
      language,
      version,
      proxyOptions: options.proxyOptions,
    };

    let firstError = null;
    const keepError = (error) => {
      if (!firstError) firstError = error;
    };

    let agentModels = [];
    try {
      const query = new URLSearchParams({
        offset: "0",
        limit: "100",
        is_primary_agent: "true",
        supported_client: "VSCODE",
        min_compatible_plugin_version: version,
      }).toString();
      const listing = await codeartsJson(
        `${base}/v1/agent-center/agents/useragents?${query}`,
        { ...shared, agentType: "AgentCenter" }
      );
      const ids = [];
      for (const agent of Array.isArray(listing?.agents) ? listing.agents : []) {
        const id = text(agent?.agent_id) || text(agent?.original_id);
        if (id && !ids.includes(id)) ids.push(id);
      }
      const wanted = ids.slice(0, CODEARTS_AGENT_DETAIL_LIMIT);
      const deadline = Date.now() + CODEARTS_AGENT_BUDGET_MS;
      for (let index = 0; index < wanted.length; index += CODEARTS_AGENT_CONCURRENCY) {
        if (Date.now() >= deadline) break;
        const batch = wanted.slice(index, index + CODEARTS_AGENT_CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map((id) =>
            codeartsJson(
              `${base}/v1/agent-center/agents/detail?agent_id=${encodeURIComponent(id)}`,
              { ...shared, agentType: "AgentCenter" }
            )
          )
        );
        for (const result of results) {
          if (result.status === "fulfilled") {
            agentModels.push(...parseCodeartsAgentDetail(result.value));
          } else {
            keepError(result.reason);
          }
        }
      }
      agentModels = dedupe(agentModels);
    } catch (error) {
      // Builtin is independent; one agent-centre failure must not blank the list.
      keepError(error);
    }

    let builtinModels = [];
    try {
      builtinModels = parseCodeartsBuiltin(
        await codeartsJson(`${base}/v1/model/builtin`, {
          ...shared,
          agentType: "PromptCenter",
        })
      );
    } catch (error) {
      // Keep agent models / benefit models.
      keepError(error);
    }

    let benefitModels = [];
    try {
      const gate = await codeartsJson(`${base}/v1/benefit-gateway-config`, {
        ...shared,
        agentType: "PromptCenter",
      });
      if (parseCodeartsBenefitGate(gate)) {
        benefitModels = parseCodeartsBenefit(
          await codeartsJson(`${benefitGateway}/api/v1/gateway/config`, {
            ...shared,
            agentType: "",
            includeHost: true,
            domainless: true,
          })
        );
      }
    } catch (error) {
      // Benefit is optional and account-dependent.
      keepError(error);
    }

    const merged = dedupe([...agentModels, ...builtinModels, ...benefitModels]);
    if (!merged.length && firstError) throw firstError;
    return merged;
  });
}

// ─── OfficeAce ────────────────────────────────────────────────────────────

function officeaceBase(connection) {
  const psd = connection?.providerSpecificData || {};
  const raw = text(psd.baseUrl) || text(psd.apiBase) || OFFICEACE_DEFAULT_GATEWAY_BASE;
  return normalizeOfficeaceGatewayBase(raw);
}

function officeaceBasicHeader(connection) {
  const psd = connection?.providerSpecificData || {};
  const fromFields =
    psd.modelAppKey && psd.modelAppSecret ? `${psd.modelAppKey}:${psd.modelAppSecret}` : "";
  const raw = String(connection?.apiKey || connection?.accessToken || fromFields).trim();
  if (!raw) return "";
  const pair = raw.replace(/^Basic\s+/i, "");
  if (pair.includes(":")) return `Basic ${Buffer.from(pair, "utf8").toString("base64")}`;
  return fromFields ? `Basic ${Buffer.from(fromFields, "utf8").toString("base64")}` : "";
}

/** `{ data: [{ id, display_name, context_window, max_output_tokens }] }` or bare array. */
export function parseOfficeaceCatalog(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : [];
  const entries = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const id = text(row.id) || text(row.model_name);
    if (!id) continue;
    entries.push(
      catalogEntry(id, text(row.display_name) || text(row.model_name) || id, {
        tools: true,
        vision: typeof row.supports_images === "boolean" ? row.supports_images : undefined,
        contextWindow: row.context_length || row.context_window,
        maxOutput: row.max_output_tokens || row.max_tokens,
      })
    );
  }
  return dedupe(entries);
}

export async function resolveOfficeaceCatalog(connection, options = {}) {
  const auth = officeaceBasicHeader(connection);
  if (!auth) throw new Error("OfficeAce 连接缺少网关 Basic 凭据");
  return cachedCatalog("officeace", connection, options, async () => {
    const response = await fetchWithProxy(
      `${officeaceBase(connection)}/models`,
      {
        method: "GET",
        headers: { Authorization: auth, Accept: "application/json" },
      },
      options.proxyOptions
    );
    return parseOfficeaceCatalog(await readJson(response, "OfficeAce 模型目录"));
  });
}

// ─── Trae SOLO ────────────────────────────────────────────────────────────

const TRAE_SOLO_CATALOG_PATH = "/api/ide/v1/get_detail_param";
const TRAE_SOLO_DEAD_CONFIGS = new Set([
  "agnes-2.0-flash",
  "agnes-agent-x",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
]);

/** `/api/ide/v1/get_detail_param` → `config_info_list[]`. */
export function parseTraeSoloCatalog(payload) {
  const rows = Array.isArray(payload?.config_info_list) ? payload.config_info_list : [];
  const entries = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const configName = text(row.config_name);
    if (!configName) continue;
    const key = configName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (row.config_switch === false) continue;
    if (row.is_invisible_to_user === true) continue;
    if (TRAE_SOLO_DEAD_CONFIGS.has(key)) continue;
    const displayConfig = row.display_config && typeof row.display_config === "object"
      ? row.display_config
      : {};
    const displayName = text(displayConfig.display_name);
    if (!displayName) continue;

    const details = Array.isArray(row.model_detail_list) ? row.model_detail_list : [];
    const outputs = details
      .map((detail) => positive(detail?.max_tokens))
      .filter((value) => value !== null);
    const context = positive(row?.context_window_tokens?.dev);
    const capability = text(displayConfig.model_capability);
    entries.push(
      catalogEntry(`${configName}-solo`, displayName, {
        tools: true,
        vision:
          typeof displayConfig.multimodal === "boolean" ? displayConfig.multimodal : undefined,
        reasoning:
          capability === "reasoning_model"
            ? true
            : capability === "chat_model"
              ? false
              : undefined,
        contextWindow: context,
        maxOutput: outputs.length ? Math.min(...outputs) : undefined,
      })
    );
  }
  return dedupe(entries, { caseInsensitive: true });
}

export async function resolveTraeSoloCatalog(connection, options = {}) {
  const token = tokenOf(connection);
  if (!token) throw new Error("Trae SOLO 连接缺少 access token");
  return cachedCatalog("trae-solo", connection, options, async () => {
    const body = {
      function: "solo_work_lite",
      config_names: null,
      need_prompt: false,
      current_config_info: null,
      poly_prompt: true,
      mode_type: null,
      agent_type: null,
    };
    const response = await fetchWithProxy(
      `${TRAE_SOLO_AGENT_BASE_URL}${TRAE_SOLO_CATALOG_PATH}`,
      {
        method: "POST",
        headers: buildTraeSoloHeaders(connection, { accept: "application/json" }),
        body: JSON.stringify(body),
      },
      options.proxyOptions
    );
    return parseTraeSoloCatalog(await readJson(response, "Trae SOLO 模型目录"));
  });
}

// ─── shared validation helper ─────────────────────────────────────────────

/**
 * Does a live catalogue contain the model the Test picker selected?
 *
 * `clientModel` may carry the provider alias (`loomy/DeepSeek...`), a SOLO
 * suffix, or AtomCode's display spelling. Callers normalise provider-specific
 * spellings first; this helper only removes ONE `alias/` prefix and compares
 * case-insensitively when asked.
 */
export function catalogHasModel(models, clientModel, { caseInsensitive = false, aliases = [] } = {}) {
  const raw = text(clientModel);
  if (!raw) return false;
  const variants = new Set([raw, ...aliases.map((alias) => text(alias)).filter(Boolean)]);
  const slash = raw.indexOf("/");
  if (slash > 0) variants.add(raw.slice(slash + 1));
  for (const value of [...variants]) {
    if (value.endsWith("-solo")) variants.add(value.slice(0, -5));
    else variants.add(`${value}-solo`);
  }
  const wanted = [...variants].map((value) => (caseInsensitive ? value.toLowerCase() : value));
  return (models || []).some((model) => {
    if (!model?.id) return false;
    const id = caseInsensitive ? model.id.toLowerCase() : model.id;
    return wanted.includes(id);
  });
}

const RESOLVERS = {
  loomy: resolveLoomyCatalog,
  lobsterai: resolveLobsterAiCatalog,
  atomcode: resolveAtomcodeCatalog,
  raccoon: resolveRaccoonCatalog,
  codearts: resolveCodeartsCatalog,
  officeace: resolveOfficeaceCatalog,
  "trae-solo": resolveTraeSoloCatalog,
};

// The id list is also imported by routes that only need the membership check;
// building the public map from it keeps the two from drifting. A missing
// resolver is a module-load failure, not a silent "provider unsupported".
export const LIVE_CATALOG_PROVIDERS = Object.freeze(
  Object.fromEntries(
    LIVE_CATALOG_PROVIDER_IDS.map((id) => {
      const resolver = RESOLVERS[id];
      if (typeof resolver !== "function") {
        throw new Error(`live catalog provider "${id}" has no resolver`);
      }
      return [id, resolver];
    })
  )
);
