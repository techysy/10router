import REGISTRY from "../providers/registry/index.js";
import { isValidModel } from "../config/providerModels.js";

// Alias→id derived from registry single-source: id→id, alias→id, aliases[]→id.
// Media-only providers without a registry transport entry keep explicit aliases here.
const MEDIA_ONLY_ALIASES = {
  el: "elevenlabs",
  jina: "jina-ai",
  "jina-ai": "jina-ai",
  polly: "aws-polly",
  "aws-polly": "aws-polly",
};

const ALIAS_TO_PROVIDER_ID = { ...MEDIA_ONLY_ALIASES };
for (const entry of REGISTRY) {
  ALIAS_TO_PROVIDER_ID[entry.id] = entry.id;
  if (entry.alias) ALIAS_TO_PROVIDER_ID[entry.alias] = entry.id;
  for (const a of entry.aliases || []) ALIAS_TO_PROVIDER_ID[a] = entry.id;
}

const BUILTIN_MODEL_ALIASES = {
  "grok-build": "gcli/grok-build",
};

// Providers whose upstream silently substitutes a default model for an id it
// does not recognise. Registry `models[]` is normally a catalogue, not a
// request gate, so those providers opt into `strictModels` and the chat path
// rejects unknown ids with a 400 before any account is picked.
const STRICT_MODEL_PROVIDERS = new Set(
  REGISTRY.filter((entry) => entry.strictModels === true).map((entry) => entry.id)
);

// Model ids a provider advertised through an authenticated live catalogue
// (open-sse/services/liveCatalogs.js). A strict provider's registry list is an
// offline floor, not the upstream contract: Loomy / Raccoon add and retire
// models server-side, and rejecting a freshly advertised id would make the
// live sync useless. Only ids observed from THAT provider's catalogue are
// admitted; the static list stays authoritative when a fetch fails.
const LIVE_MODEL_IDS = new Map();

/** Record a successful live-catalogue fetch for `provider`. */
export function rememberLiveModels(provider, ids) {
  if (!provider || !Array.isArray(ids)) return;
  const next = new Set(
    ids
      .filter((id) => typeof id === "string" && id.trim())
      .map((id) => id.trim())
  );
  if (next.size === 0) return;
  LIVE_MODEL_IDS.set(provider, next);
}

/** Test/refresh helper: drop the live set for one provider. */
export function forgetLiveModels(provider) {
  LIVE_MODEL_IDS.delete(provider);
}

export function isStrictModelProvider(provider) {
  return !!provider && STRICT_MODEL_PROVIDERS.has(provider);
}

/**
 * Whether `provider` may receive `modelId`.
 *
 * Non-strict providers always return true (10router's default passthrough
 * posture). Strict providers compare against their registry `models[]`; a
 * thinking suffix such as "(high)" is stripped first because it is a client
 * decoration, not part of the upstream id (getModelUpstreamId does the same).
 */
export function isModelAllowedForProvider(provider, modelId) {
  if (!isStrictModelProvider(provider)) return true;
  if (typeof modelId !== "string" || !modelId.trim()) return false;
  const baseId = modelId.replace(/\([^()]+\)\s*$/, "").trim();
  if (isValidModel(provider, baseId)) return true;
  return LIVE_MODEL_IDS.get(provider)?.has(baseId) === true;
}

/**
 * Resolve provider alias to provider ID
 */
export function resolveProviderAlias(aliasOrId) {
  return ALIAS_TO_PROVIDER_ID[aliasOrId] || aliasOrId;
}

/**
 * Parse model string: "alias/model" or "provider/model" or just alias
 */
export function parseModel(modelStr) {
  if (!modelStr) {
    return { provider: null, model: null, isAlias: false, providerAlias: null };
  }

  // Check if standard format: provider/model or alias/model
  if (modelStr.includes("/")) {
    const firstSlash = modelStr.indexOf("/");
    const providerOrAlias = modelStr.slice(0, firstSlash);
    const model = modelStr.slice(firstSlash + 1);
    const provider = resolveProviderAlias(providerOrAlias);
    return { provider, model, isAlias: false, providerAlias: providerOrAlias };
  }

  // Alias format (model alias, not provider alias)
  return {
    provider: null,
    model: modelStr,
    isAlias: true,
    providerAlias: null,
  };
}

/**
 * Resolve model alias from aliases object
 * Format: { "alias": "provider/model" }
 */
export function resolveModelAliasFromMap(alias, aliases) {
  if (!aliases) return null;

  // Check if alias exists
  const resolved = aliases[alias];
  if (!resolved) return null;

  // Resolved value is "provider/model" format
  if (typeof resolved === "string" && resolved.includes("/")) {
    const firstSlash = resolved.indexOf("/");
    const providerOrAlias = resolved.slice(0, firstSlash);
    return {
      provider: resolveProviderAlias(providerOrAlias),
      model: resolved.slice(firstSlash + 1),
    };
  }

  // Or object { provider, model }
  if (typeof resolved === "object" && resolved.provider && resolved.model) {
    return {
      provider: resolveProviderAlias(resolved.provider),
      model: resolved.model,
    };
  }

  return null;
}

/**
 * Get full model info (parse or resolve)
 * @param {string} modelStr - Model string
 * @param {object|function} aliasesOrGetter - Aliases object or async function to get aliases
 */
/**
 * Resolve a BARE model string through the alias maps (user aliases, then
 * built-ins). Returns the resolved {provider, model}, or null when nothing
 * matched — deliberately NO prefix inference, so callers decide what an
 * unmatched bare name means for their surface.
 */
export async function resolveModelAliasCore(modelStr, aliasesOrGetter) {
  const parsed = parseModel(modelStr);
  if (!parsed.isAlias) return null;

  // Get aliases (from object or function)
  const aliases =
    typeof aliasesOrGetter === "function"
      ? await aliasesOrGetter()
      : aliasesOrGetter;

  return (
    resolveModelAliasFromMap(parsed.model, aliases) ||
    resolveModelAliasFromMap(parsed.model, BUILTIN_MODEL_ALIASES) ||
    null
  );
}

export async function getModelInfoCore(modelStr, aliasesOrGetter) {
  const parsed = parseModel(modelStr);

  if (!parsed.isAlias) {
    return {
      provider: parsed.provider,
      model: parsed.model,
    };
  }

  const resolved = await resolveModelAliasCore(modelStr, aliasesOrGetter);
  if (resolved) {
    return resolved;
  }

  // Fallback: infer provider from model name prefix
  return {
    provider: inferProviderFromModelName(parsed.model),
    model: parsed.model,
  };
}

// Codex 后端的专属 GPT slug：存在于 backend-api/codex/models，但 OpenAI API 没有。
// 没有这些规则，Codex CLI 发的裸模型名（如 /model 选择器的 "gpt-5.6-terra"）会被
// 推断到 openai，只有 Codex OAuth 账号的用户拿到的是 404（上游 #4405, 8f9ff44f）。
// 覆盖范围：gpt-5.x、gpt-6.x、gpt-daybreak-*、gpt-reserve*；
// 普通 gpt-4* / gpt-3.5* / gpt-4o* 仍走下面的通用 gpt-* → openai 规则。
const CODEX_BARE_SLUG_PATTERNS = [
  /^gpt-[56]\./,
  /^gpt-6-/,
  /^gpt-daybreak-/,
  /^gpt-reserve/,
];

// 裸 slug 是否属于 Codex 后端专属 id —— src 侧在 alias/combo 解析之后复用此判断。
export function isCodexBareSlug(modelName) {
  if (!modelName) return false;
  const m = modelName.toLowerCase();
  return CODEX_BARE_SLUG_PATTERNS.some((re) => re.test(m));
}

// Config-driven prefix → provider inference (first match wins, fallback "openai").
const MODEL_PREFIX_PROVIDERS = [
  // codex 专属 slug 必须在通用 gpt-* → openai 之前命中
  ...CODEX_BARE_SLUG_PATTERNS.map((re) => [re, "codex"]),
  [/^claude-/, "anthropic"],
  [/^gemini-/, "gemini"],
  [/^gpt-/, "openai"],
  [/^o[134]/, "openai"],
  [/^deepseek-/, "openrouter"],
];

/**
 * Infer provider from model name prefix
 * Used as fallback when no provider prefix or alias is given
 */
function inferProviderFromModelName(modelName) {
  if (!modelName) return "openai";
  const m = modelName.toLowerCase();
  return MODEL_PREFIX_PROVIDERS.find(([re]) => re.test(m))?.[1] || "openai";
}
