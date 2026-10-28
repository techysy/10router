// Unified thinking normalization: extract client intent → apply provider-native format.
// Config-driven: thinking format/limits come from capabilities.js + registry transport,
// never hardcoded per-model here. See .docs/thinking/plan.md MATRIX VI-A.

import { getCapabilitiesForModel } from "../../providers/capabilities.js";
import { getThinkingLevels } from "../../providers/thinkingLevels.js";
import { PROVIDERS } from "../../providers/index.js";
import { FORMATS } from "../formats.js";
import { LEVEL_TO_BUDGET, budgetToLevel, effortToBudget, effortToThinkingLevel } from "./thinking.js";

// Map a target wire-format to its native thinking format (when capability has none).
const FORMAT_TO_NATIVE = {
  [FORMATS.OPENAI]: "openai",
  [FORMATS.OPENAI_RESPONSES]: "openai",
  [FORMATS.OPENAI_RESPONSE]: "openai",
  [FORMATS.CODEX]: "openai",
  [FORMATS.CLAUDE]: "claude-budget",
  [FORMATS.GEMINI]: "gemini-budget",
  [FORMATS.GEMINI_CLI]: "gemini-budget",
  [FORMATS.VERTEX]: "gemini-budget",
  [FORMATS.ANTIGRAVITY]: "gemini-budget",
  [FORMATS.KIRO]: "kiro",
};

// Strip a trailing thinking suffix "model(value)" → "model" (no-op when absent).
export function stripThinkingSuffix(model) {
  if (typeof model !== "string") return model;
  const m = model.match(/^(.*)\([^()]+\)\s*$/);
  return m ? m[1].trim() : model;
}

// Parse model-name suffix "model(value)" → { cleanModel, override }.
// value: level name (high) | number (8192) | auto | none. null override when absent.
export function parseSuffix(model) {
  if (typeof model !== "string") return { cleanModel: model, override: null };
  const m = model.match(/^(.*)\(([^()]+)\)\s*$/);
  if (!m) return { cleanModel: model, override: null };
  const cleanModel = m[1].trim();
  const raw = m[2].trim().toLowerCase();
  if (raw === "none" || raw === "off") return { cleanModel, override: { mode: "none" } };
  if (raw === "auto") return { cleanModel, override: { mode: "auto" } };
  if (raw === "ultra") return { cleanModel, override: { mode: "level", level: raw } };
  if (/^\d+$/.test(raw)) return { cleanModel, override: { mode: "budget", budget: Number(raw) } };
  if (LEVEL_TO_BUDGET[raw] !== undefined) return { cleanModel, override: { mode: "level", level: raw } };
  return { cleanModel, override: null };
}

// Extract unified thinking intent from a request body (post-translation, mixed shapes).
// Returns { mode, budget?, level? } or null when no thinking intent present.
export function extractThinking(body) {
  if (!body || typeof body !== "object") return null;

  // Claude output_config.effort (explicit) — priority over adaptive thinking
  const oc = body.output_config?.effort;
  if (typeof oc === "string" && oc) {
    const e = oc.toLowerCase();
    if (e === "none" || e === "off") return { mode: "none" };
    if (e === "auto") return { mode: "auto" };
    return { mode: "level", level: e };
  }

  // Claude shape
  const t = body.thinking;
  if (t && typeof t === "object") {
    if (t.type === "disabled") return { mode: "none" };
    if (t.type === "adaptive" || t.type === "enabled") {
      const budget = Number(t.budget_tokens);
      if (Number.isFinite(budget) && budget > 0) return { mode: "budget", budget };
      return { mode: "auto" };
    }
  }

  // OpenAI chat / Responses shape
  const effort = body.reasoning_effort ?? (typeof body.reasoning === "object" ? body.reasoning?.effort : null);
  if (typeof effort === "string" && effort) {
    const e = effort.toLowerCase();
    if (e === "none" || e === "off") return { mode: "none" };
    if (e === "auto") return { mode: "auto" };
    return { mode: "level", level: e };
  }

  // Gemini shape (top-level, generationConfig, or request envelope)
  const tc = body.thinkingConfig || body.generationConfig?.thinkingConfig || body.request?.generationConfig?.thinkingConfig;
  if (tc && typeof tc === "object") {
    if (typeof tc.thinkingLevel === "string") return { mode: "level", level: tc.thinkingLevel.toLowerCase() };
    const tb = Number(tc.thinkingBudget);
    if (Number.isFinite(tb)) {
      if (tb === 0) return { mode: "none" };
      if (tb < 0) return { mode: "auto" };
      return { mode: "budget", budget: tb };
    }
  }

  // Qwen shape
  if (body.enable_thinking === false) return { mode: "none" };
  if (body.enable_thinking === true) {
    const tb = Number(body.thinking_budget);
    if (Number.isFinite(tb) && tb > 0) return { mode: "budget", budget: tb };
    return { mode: "auto" };
  }

  return null;
}

// Capture thinking intent from a body before format translation strips it.
// Besides the effort, records whether an OpenAI-shaped client wants the thinking
// text itself: Claude only returns thinking when thinking.display is "summarized",
// a field OpenAI has no equivalent for, so the ask cannot survive translation.
export function captureThinking(body) {
  const cfg = extractThinking(body);
  if (!cfg || cfg.mode === "none") return cfg;
  const display = openAIThinkingDisplay(body);
  return display ? { ...cfg, display } : cfg;
}

// An OpenAI-shaped client can only *ask* for reasoning text, not set Claude's
// thinking.display: the Responses API's reasoning.summary is the explicit ask;
// Chat Completions has no summary knob — setting reasoning_effort is the ask.
function openAIThinkingDisplay(body) {
  if (body.reasoning && typeof body.reasoning === "object") {
    const summary = body.reasoning.summary;
    return typeof summary === "string" && summary && summary !== "none" ? "summarized" : undefined;
  }
  if (typeof body.reasoning_effort === "string") return "summarized";
  return undefined;
}

const NATIVE_ONLY_FORMATS = new Set(["gemini-level", "gemini-budget", "claude-budget", "claude-adaptive", "kiro"]);

// Resolve thinking format: provider override > capability > derive(targetFormat).
function resolveFormat(targetFormat, model, provider) {
  if (targetFormat === "commandcode") return "commandcode";
  const transportFmt = provider
    ? PROVIDERS[provider]?.transports?.find((t) => t.format === targetFormat)?.thinkingFormat
    : null;
  if (transportFmt) return transportFmt;
  const providerFmt = provider ? PROVIDERS[provider]?.thinkingFormat : null;
  if (providerFmt) return providerFmt;
  const caps = getCapabilitiesForModel(provider, model);
  const isOpenAIWire = targetFormat === "openai" || targetFormat === "responses" || targetFormat === "openai-responses";
  if (caps.thinkingFormat && !(isOpenAIWire && NATIVE_ONLY_FORMATS.has(caps.thinkingFormat))) {
    return caps.thinkingFormat;
  }
  return FORMAT_TO_NATIVE[targetFormat] || "openai";
}

// Convert unified config to a budget number (for budget-based formats).
function toBudget(cfg, range) {
  let budget;
  if (cfg.mode === "budget") budget = cfg.budget;
  else if (cfg.mode === "level") budget = effortToBudget(cfg.level);
  else if (cfg.mode === "auto") return -1;
  if (!Number.isFinite(budget)) return undefined;
  if (range) {
    if (range.min != null && budget < range.min) budget = range.min;
    if (range.max != null && budget > range.max) budget = range.max;
  }
  return budget;
}

// Convert unified config to a discrete level string.
function toLevel(cfg) {
  if (cfg.mode === "level") return cfg.level;
  if (cfg.mode === "budget") return budgetToLevel(cfg.budget) || "medium";
  if (cfg.mode === "auto") return "auto";
  return null;
}

function normalizeOpenAILevel(level, supportedLevels) {
  if (level !== "max" && level !== "ultra") return level;
  if (supportedLevels?.includes(level)) return level;
  if (level === "ultra" && supportedLevels?.includes("max")) return "max";
  return "xhigh";
}

function toGeminiThinkingLevel(cfg) {
  const raw = cfg.mode === "auto" ? "high" : (toLevel(cfg) || "high");
  return effortToThinkingLevel(raw);
}

function toKimiReasoningEffort(cfg) {
  const level = toLevel(cfg);
  if (level === "auto") return "high";
  if (level === "minimal") return "low";
  if (level === "xhigh") return "max";
  if (["low", "medium", "high", "max"].includes(level)) return level;
  return null;
}

const GEMINI_LEVEL_OUTPUT_FLOOR = {
  minimal: 4096,
  low: 8192,
  medium: 16384,
  high: 65535,
};

function geminiBudgetOutputFloor(budget) {
  if (budget === -1) return 32768;
  if (!Number.isFinite(budget)) return 32768;
  if (budget <= 1024) return 8192;
  if (budget <= 8192) return 16384;
  if (budget <= 24576) return 32768;
  return 65535;
}

function geminiLevelOutputFloor(level) {
  return GEMINI_LEVEL_OUTPUT_FLOOR[level] || GEMINI_LEVEL_OUTPUT_FLOOR.high;
}

// Gemini nests thinkingConfig under generationConfig. gemini-cli / antigravity wrap
// the whole request in a { request: { generationConfig } } envelope — target the
// envelope's generationConfig when present, else the top-level one.
function getGeminiGenerationConfig(body) {
  if (body.request && typeof body.request === "object") {
    if (!body.request.generationConfig || typeof body.request.generationConfig !== "object") {
      body.request.generationConfig = {};
    }
    return body.request.generationConfig;
  }
  if (!body.generationConfig || typeof body.generationConfig !== "object") {
    body.generationConfig = {};
  }
  return body.generationConfig;
}

function setGeminiThinking(body, tc) {
  const gc = getGeminiGenerationConfig(body);
  gc.thinkingConfig = tc;
}

function ensureGeminiOutputFloor(body, floor, caps) {
  const cap = Number.isFinite(caps?.maxOutput) ? caps.maxOutput : floor;
  const target = Math.min(floor, cap);
  const gc = getGeminiGenerationConfig(body);
  const current = Number(gc.maxOutputTokens);
  if (!Number.isFinite(current) || current < target) {
    gc.maxOutputTokens = target;
  }
}

// Strip every known thinking field from a body (used before re-applying / when unsupported).
function stripAll(body) {
  delete body.thinking;
  delete body.reasoning_effort;
  delete body.reasoning;
  delete body.thinkingConfig;
  delete body.enable_thinking;
  delete body.thinking_budget;
  delete body.output_config;
  if (body.generationConfig) delete body.generationConfig.thinkingConfig;
  if (body.request?.generationConfig) delete body.request.generationConfig.thinkingConfig;
}

// Apply unified thinking config to body in the resolved provider-native format.
function applyFormat(fmt, body, cfg, caps, supportedLevels, targetFormat = null, provider = null, display = null, model = "") {
  const none = cfg.mode === "none";
  const canDisable = caps.thinkingCanDisable !== false;
  // Model cannot disable thinking → clamp "none" to minimal effort instead.
  const eff = none && !canDisable ? { mode: "level", level: "minimal" } : cfg;

  switch (fmt) {
    case "openai": {
      // Responses wire format carries the effort on `reasoning.effort`;
      // `reasoning_effort` is Chat-Completions-only and Responses upstreams
      // reject it with 400 unsupported_parameter ("moved to 'reasoning.effort'").
      // applyThinking runs AFTER the openai→responses translator, so the field
      // must be written in the target's native shape here — EXCEPT for the
      // codex provider: its executor owns the final conversion
      // (normalizeReasoningEffort + reasoning.summary re-attachment) and feeds
      // on reasoning_effort.
      const responsesFamily = (targetFormat === FORMATS.OPENAI_RESPONSES ||
        targetFormat === FORMATS.OPENAI_RESPONSE) && provider !== "codex";
      const setEffort = (v) => {
        if (responsesFamily) body.reasoning = { ...(body.reasoning || {}), effort: v };
        else body.reasoning_effort = v;
      };
      if (none && canDisable) { setEffort("none"); break; }
      const level = toLevel(eff);
      if (level) setEffort(normalizeOpenAILevel(level, supportedLevels));
      break;
    }
    case "claude-adaptive": {
      if (none && canDisable) {
        body.thinking = { type: caps.thinkingOffType || "disabled" };
        break;
      }
      const level = toLevel(eff);
      // output_config.effort alone does NOT turn thinking on: Anthropic requires
      // an explicit thinking:{type:"adaptive"} on Opus 4.6/4.7/4.8 and Sonnet 4.6
      // ("thinking is off unless you explicitly set it"), and Anthropic-compatible
      // shims (e.g. GitHub Copilot /v1/messages) default thinking off even for
      // Sonnet 5. Send both fields — the documented adaptive shape. Permanently
      // adaptive models (thinkingCanDisable:false, e.g. Fable 5.1 / Opus 5.5) accept
      // effort directly; but when a display mode is requested (e.g. "summarized"),
      // sending thinking:{type:"adaptive", display} is required or thinking is omitted.
      if (canDisable) {
        body.thinking = { type: "adaptive", ...(display ? { display } : {}) };
      } else if (display && level !== "minimal" && /claude/i.test(model)) {
        body.thinking = { type: "adaptive", display };
      } else {
        delete body.thinking;
      }
      // "auto" is not a value Anthropic accepts in output_config.effort — map it to high.
      // xhigh 按模型分档（Opus/Sonnet 4.6 拒绝该值）——模型未声明支持时钳回 high。
      // Claude effort has no "minimal" (always-on models clamp "none" to it).
      body.output_config = { effort: level === "auto" ? "high"
        : level === "xhigh" && !supportedLevels?.includes("xhigh") ? "high"
        : level === "minimal" ? "low" : level };
      break;
    }
    case "claude-budget": {
      if (none && canDisable) { body.thinking = { type: "disabled" }; break; }
      const budget = toBudget(eff, caps.thinkingRange);
      body.thinking = budget === -1
        ? { type: "enabled", ...(display ? { display } : {}) }
        : { type: "enabled", budget_tokens: budget || 8192, ...(display ? { display } : {}) };
      break;
    }
    case "gemini-level": {
      let level = none ? "minimal" : toGeminiThinkingLevel(eff);
      // Models without a "minimal" tier (Gemini 4) reject it with 400 — clamp to the lowest supported level.
      const lowest = supportedLevels?.find((l) => l !== "none");
      if (supportedLevels?.length && lowest && !supportedLevels.includes(level)) level = lowest;
      setGeminiThinking(body, { thinkingLevel: level, includeThoughts: level !== "minimal" });
      ensureGeminiOutputFloor(body, geminiLevelOutputFloor(level), caps);
      break;
    }
    case "gemini-budget": {
      if (none && canDisable) { setGeminiThinking(body, { thinkingBudget: 0, includeThoughts: false }); break; }
      const budget = toBudget(eff, caps.thinkingRange);
      setGeminiThinking(body, { thinkingBudget: budget ?? -1, includeThoughts: true });
      ensureGeminiOutputFloor(body, geminiBudgetOutputFloor(budget ?? -1), caps);
      break;
    }
    case "zai": {
      // Z.ai ignores thinking.disabled → must use enable_thinking:false to turn off.
      if (none && canDisable) { body.enable_thinking = false; delete body.thinking; break; }
      body.thinking = { type: "enabled" };
      break;
    }
    case "qwen": {
      if (none && canDisable) { body.enable_thinking = false; break; }
      body.enable_thinking = true;
      const budget = toBudget(eff, caps.thinkingRange);
      if (Number.isFinite(budget) && budget > 0) body.thinking_budget = budget;
      break;
    }
    case "deepseek": {
      if (none && canDisable) { body.thinking = { type: "disabled" }; break; }
      body.thinking = { type: "enabled" };
      // DeepSeek: low/medium→high, xhigh/max→xhigh (SenseNova rejects "max").
      const level = toLevel(eff);
      body.reasoning_effort = level === "xhigh" || level === "max" ? "xhigh" : "high";
      break;
    }
    case "kimi": {
      if (none && canDisable) { body.thinking = { type: "disabled" }; break; }
      const effort = toKimiReasoningEffort(eff);
      if (effort) body.reasoning_effort = effort;
      break;
    }
    case "minimax": {
      // M3 adaptive; M2.x cannot disable (handled via canDisable clamp).
      body.thinking = { type: none && canDisable ? "disabled" : "adaptive" };
      // M3.1 系列（M3.1-Flash 与 -Preview）支持可调思考深度（官方客户端档位 default/low/medium/
      // high/xhigh/max）: effort 附加在 adaptive 形态里透传——CreditDaddy 网关实测
      // 200 接受（不认识该字段的旧上游会静默忽略,无害）。default 省略字段走上游
      // 默认;minimal 是 none 被 canDisable 钳制出来的档,MiniMax 无此档,同样省略。
      // 透传门控在 !canDisable 上:M3.1（不可关 → 档位模型）才带 effort,M3（开关
      // 模型）与 M2.x 只发 adaptive/disabled——官方客户端给它们的设置面板无档位。
      if (!none && !canDisable) {
        const lvl = toLevel(eff);
        if (lvl && lvl !== "auto" && lvl !== "minimal") body.thinking.effort = lvl;
      }
      break;
    }
    case "hunyuan": {
      if (none && canDisable) { body.thinking = { type: "disabled" }; break; }
      const budget = toBudget(eff, caps.thinkingRange);
      body.thinking = budget === -1 ? { type: "enabled" } : { type: "enabled", budget_tokens: budget || 8192 };
      break;
    }
    case "step": {
      if (none && canDisable) break;
      const level = toLevel(eff);
      if (level) body.reasoning_effort = level === "xhigh" || level === "max" ? "high" : level;
      break;
    }
    case "tokenrouter": {
      // TokenRouter's reasoning_effort enum is low/medium/high/xhigh/max — it rejects
      // "none"/"auto" with a 400 and supports "max" natively (no clamp like openai).
      // "none" → omit the field so the upstream default applies; pass levels through.
      if (none || eff.mode === "auto") break;
      const level = toLevel(eff);
      if (level) body.reasoning_effort = level;
      break;
    }
    case "kiro":
      // Kiro thinking handled via system-tag injection in openai-to-kiro.js; no body field here.
      break;
    default:
      break;
  }
}

// Public entry: normalize thinking for the resolved target format.
// Mutates and returns body. No-op when model has no reasoning capability.
// `intent` is a pre-captured config (from captureThinking on the original body);
// falls back to extracting from the current body when omitted.
export function applyThinking(targetFormat, model, body, provider = null, intent = undefined) {
  if (!body || typeof body !== "object") return body;

  const { cleanModel, override } = parseSuffix(model);
  const cfg = override || intent || extractThinking(body);
  const caps = getCapabilitiesForModel(provider, cleanModel);

  // Model cannot reason → strip any stray thinking fields.
  if (!caps.reasoning) {
    stripAll(body);
    return body;
  }
  if (!cfg) return body;

  const fmt = resolveFormat(targetFormat, cleanModel, provider);
  const supportedLevels = getThinkingLevels(provider, cleanModel);
  // An OpenAI-shaped client's display ask arrives via the captured intent instead;
  // a Claude-format client's own body.thinking.display (read before stripAll) wins.
  const display = typeof body.thinking?.display === "string" ? body.thinking.display : intent?.display;
  stripAll(body);
  applyFormat(fmt, body, cfg, caps, supportedLevels, targetFormat, provider, display, cleanModel);
  return body;
}
