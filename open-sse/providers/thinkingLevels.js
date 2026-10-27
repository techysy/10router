// Resolve valid thinking levels per model — drives UI level picker (suffix "model(level)").
// Reuses capabilities.js (thinkingFormat/canDisable) so this file only maps format→levels (DRY).
import { getCapabilitiesForModel } from "./capabilities.js";
import { matchPattern } from "./pricing.js";
import { resolveKiroEffortPath } from "../config/kiroConstants.js";

// Shared level sets (deduped) — verified against provider docs + wire in thinkingUnified.applyFormat.
const L = {
  base: ["none", "low", "medium", "high"],                          // qwen, step, hunyuan, gemini-budget
  onOff: ["none", "thinking"],                                      // zai (binary), minimax (adaptive)
  openai: ["none", "minimal", "low", "medium", "high", "xhigh"],    // GPT-5.x / o-series (no "max")
  levelMax: ["none", "low", "medium", "high", "max"],               // kimi
  budgetX: ["none", "low", "medium", "high", "xhigh", "max"],       // claude-budget, claude-adaptive
  gemini: ["minimal", "low", "medium", "high"],                     // gemini-3 thinkingLevel (no disable)
  hiMax: ["none", "high", "max"],                                   // deepseek (low/med→high, xhigh→max)
};

// thinkingFormat → valid selectable levels (source of truth for UI options).
const FORMAT_LEVELS = {
  openai: L.openai,
  "claude-adaptive": L.budgetX,
  "claude-budget": L.budgetX,
  "gemini-level": L.gemini,
  "gemini-budget": L.base,
  zai: L.onOff,
  qwen: L.base,
  kimi: L.levelMax,
  deepseek: L.hiMax,
  minimax: L.onOff,
  hunyuan: L.base,
  step: L.base,
};

const CODEX_GPT_5_6_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

// Opus/Sonnet 4.6 没有 xhigh 档（Anthropic 与 Kiro 均拒绝）——保持 low..max 五档。
const CLAUDE_NO_XHIGH = ["none", "low", "medium", "high", "max"];

// Model-name pattern overrides (glob, first match wins) — more precise than format default.
const PATTERN_THINKING = [
  // Gemini 4 (Argon) rejects "minimal" with 400 — LOW is the floor; cannot disable thinking.
  { pattern: "*gemini-4*", levels: ["low", "medium", "high"] },
  { pattern: "*claude*4.6*", levels: CLAUDE_NO_XHIGH },
  { pattern: "*claude*4-6*", levels: CLAUDE_NO_XHIGH },
  // GPT-6 lite family (Sol/Luna/6.1) runs Responses Lite: no "none"/"minimal",
  // thinking always on; codex-only "ultra" normalizes to max downstream.
  // MUST sit above the broad *gpt-6* rule - first match wins.
  { provider: "codex", pattern: "*gpt-6.1-sol*", levels: ["low", "medium", "high", "xhigh", "max"] },
  { provider: "codex", pattern: "*gpt-6-sol*", levels: ["low", "medium", "high", "xhigh", "max"] },
  { provider: "codex", pattern: "*gpt-6-luna*", levels: ["low", "medium", "high", "xhigh", "max"] },
  { provider: "codex", pattern: "*gpt-6*", levels: CODEX_GPT_5_6_LEVELS },
  { provider: "codex", pattern: "*gpt-5.6-sol*", levels: [...CODEX_GPT_5_6_LEVELS, "ultra"] },
  { provider: "codex", pattern: "*gpt-5.6-terra*", levels: [...CODEX_GPT_5_6_LEVELS, "ultra"] },
  { provider: "codex", pattern: "*gpt-5.6-luna*", levels: CODEX_GPT_5_6_LEVELS },
  { pattern: "*codex*", levels: ["low", "medium", "high", "xhigh"] }, // codex cannot disable thinking
  { pattern: "*mimo*preview*", levels: ["none", "low", "medium", "high", "xhigh"] },
  // opencode-go 的 mimo-v2.5-pro 实测拒绝 reasoning_effort "max"（v2.5 接受）。
  // 本仓库的 deepseek 线上格式本就把 max 请求改写成 xhigh 发出，因此只需把
  // 选择器收敛到该模型真正接受的档位。
  { pattern: "*mimo*v2.5-pro*", levels: ["none", "low", "medium", "high", "xhigh"] },
  // AMD Token Factory per-model effort sets (AMD probed every value on the live
  // endpoint; its 2026-09-09 doc revision supersedes the earlier low/medium-only
  // reading). Both DeepSeek ids take all seven efforts and think only when asked;
  // Qwen3.8-Flash-Next thinks by default and takes none|low|medium|xhigh, so
  // `none` is the off switch. MiniCPM5-2B returns no reasoning, so it needs no
  // entry here (getThinkingLevels returns null on reasoning:false).
  { provider: "amd", pattern: "DeepSeek-V4-Flash*", levels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] },
  { provider: "amd", pattern: "Qwen3.8-Flash-Next", levels: ["none", "low", "medium", "xhigh"] },
  // codebuddy-cn per-model effort sets — the server's product-config payload
  // publishes `reasoning.supportedEfforts` per model. NOTE: the chat endpoint
  // accepts any level you send (probed none/minimal/low/medium/high/xhigh/max
  // → all 200), but values outside a model's supportedEfforts are silently
  // clamped, so the declared set stays authoritative for the picker. Models
  // that publish no supportedEfforts (glm-5.1 / glm-5v-turbo / kimi-k2.x /
  // kimi-k3 / minimax-m3) fall through to the openai format default.
  { provider: "codebuddy-cn", pattern: "glm-5.3*",     levels: ["low", "high", "max"] },
  { provider: "codebuddy-cn", pattern: "glm-5.2",      levels: ["high", "xhigh"] },
  { provider: "codebuddy-cn", pattern: "deepseek-v4*", levels: ["low", "high", "xhigh"] },
  { provider: "codebuddy-cn", pattern: "hy3*",         levels: ["low", "high"] },
  { provider: "codebuddy-cn", pattern: "hy4*",         levels: ["high"] },
];

// OpenAI documents reasoning.effort "max" for GPT-5.6 and GPT-6 (#5186). The codex rows
// above already carry it; an OpenAI Compatible node serving the same ids gets the same
// set, otherwise the "openai" format list (no max) clamps max to xhigh on the wire.
const OPENAI_MAX_EFFORT_MODEL = /(?:^|\/)gpt-(?:5\.6|6)(?:[.-]|$)/i;
const isOpenAICompatibleNode = (provider) => String(provider || "").startsWith("openai-compatible-");

// Returns valid thinking levels for a model, or null when the model has no reasoning.
export function getThinkingLevels(provider, model) {
  if (provider === "kiro" && resolveKiroEffortPath(model) === null) return null;
  const caps = getCapabilitiesForModel(provider, model);
  if (!caps.reasoning) return null;
  const baseId = String(model || "").split("/").pop();
  const hit = PATTERN_THINKING.find((entry) =>
    (!entry.provider || entry.provider === provider) && matchPattern(entry.pattern, model)
  );
  let levels = hit?.levels
    || (isOpenAICompatibleNode(provider) && OPENAI_MAX_EFFORT_MODEL.test(baseId) ? CODEX_GPT_5_6_LEVELS : null)
    || FORMAT_LEVELS[caps.thinkingFormat] || L.base;
  if (caps.thinkingCanDisable === false) levels = levels.filter((l) => l !== "none");
  return levels;
}
