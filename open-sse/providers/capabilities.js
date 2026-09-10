// Model capabilities — what each model can read/do beyond plain text.
//
// Fallback order (first match wins), result merged over DEFAULT_CAPABILITIES:
//   1. PROVIDER_CAPABILITIES[provider][model]  — provider-specific override
//   2. MODEL_CAPABILITIES[model]               — canonical exact id (handles exceptions)
//   3. PATTERN_CAPABILITIES                     — glob match, ordered specific -> generic
//   4. DEFAULT_CAPABILITIES                     — safe floor (always returned)
//
// ── HOW TO ADD / UPDATE A MODEL ──────────────────────────────────────
// Authoritative data source: https://models.dev/api.json (145 providers, 4000+
// models, MIT). Each model exposes the exact fields we map below:
//   modalities.input  ["text","image","pdf","audio","video"] -> vision / pdf / audioInput / videoInput
//   modalities.output ["text","image","audio"]               -> imageOutput / audioOutput
//   reasoning   -> reasoning      tool_call    -> tools
//   limit.context -> contextWindow   limit.output -> maxOutput
// Look up the model id, then:
//   • If a PATTERN below already covers it correctly -> nothing to do.
//   • If it is an exception (pattern would mis-match) -> add an exact entry to
//     MODEL_CAPABILITIES (only the fields that differ from DEFAULT).
//   • If a whole new family -> add an ordered PATTERN (specific before generic).
// NOTE: models.dev has NO "search" flag (web search is a runtime tool, not a
// model spec); set `search` from vendor docs (Claude 4.x+, GPT-5.x/4o, Gemini
// 2.0+, Grok, Perplexity). Verify with: curl -s https://models.dev/api.json

import { matchPattern } from "./pricing.js";

/**
 * Safe floor — every resolved result is merged over this so consumers
 * never need null-checks. Most modern LLMs meet these limits.
 */
export const DEFAULT_CAPABILITIES = {
  // input modalities
  vision: false,        // read images
  pdf: false,           // read PDF / documents
  audioInput: false,    // read audio
  videoInput: false,    // read video
  // output modalities
  imageOutput: false,   // generate images
  audioOutput: false,   // generate audio
  // features
  search: false,        // built-in web search tool / grounding
  tools: true,          // function / tool calling
  reasoning: false,     // thinking / reasoning
  // thinking wire format (only meaningful when reasoning:true). null → derive from transport.format.
  // enum: openai|claude-adaptive|claude-budget|gemini-level|gemini-budget|zai|qwen|deepseek|kimi|minimax|hunyuan|step
  thinkingFormat: null,
  thinkingCanDisable: true,  // false → model cannot turn thinking off (clamp to min instead of disable)
  thinkingRange: null,       // { min, max } for budget formats; null = no clamp
  // limits (tokens)
  contextWindow: 200000,
  maxOutput: 64000,
};

// User-added model metadata can carry dashboard service kinds instead of the
// runtime capability names used here. Map those typed model kinds into input /
// output capabilities so custom vision models are not treated as text-only.
const SERVICE_KIND_CAPABILITIES = {
  imageToText: { vision: true },
  image: { imageOutput: true },
  stt: { audioInput: true },
  tts: { audioOutput: true },
  embedding: { tools: false },
};

export function capabilitiesFromServiceKind(kind) {
  return SERVICE_KIND_CAPABILITIES[kind] || null;
}

/**
 * Canonical exact-id overrides — used for exceptions that patterns would
 * otherwise mis-match. Only declare deltas vs DEFAULT.
 */
export const MODEL_CAPABILITIES = {
  // Claude Opus 5, 4.6/4.7/4.8, and Kiro Sonnet 5 have 1M context + adaptive thinking (override generic claude pattern)
  // Claude Fable 5.1 has 1M context + adaptive thinking (override generic claude pattern)
  "claude-fable-5-1":  { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-5":     { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-5-thinking": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-5-agentic": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },

  // OpenCode Free Muse Spark — multimodal (text+image per models.dev meta/muse-spark)
  // via OpenAI Responses input_image; reasoning supports up to xhigh.
  "muse-spark-1.2-contributor-free": { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1048576, maxOutput: 131072 },
  "muse-spark-1.3-contributor-free": { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1048576, maxOutput: 131072 },
  // OpenCode Free limited-time free catalog (opencode.ai/docs/zen). Metadata
  // is conservative: plain chat/completions, no advertised vision, moderate
  // context — the *gemini*/*-3* etc. patterns do NOT apply to these ids.
  "big-pickle":                { reasoning: true, thinkingFormat: "openai", contextWindow: 262144, maxOutput: 65536 },
  "mimo-v2.5-free":            { reasoning: true, thinkingFormat: "openai", contextWindow: 1048576, maxOutput: 65536 },
  "ling-3.0-flash-fin-free":   { reasoning: true, thinkingFormat: "openai", contextWindow: 131072, maxOutput: 32768 },
  "nemotron-3-ultra-free":     { reasoning: true, thinkingFormat: "openai", contextWindow: 262144, maxOutput: 65536 },
  "nemotron-3.5-lightning-free": { reasoning: true, thinkingFormat: "openai", contextWindow: 262144, maxOutput: 65536 },
  "claude-opus-5-thinking-agentic": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4.6":   { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4.7":   { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4-7":   { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4.8":   { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4-6":   { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4-8":   { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4.8-thinking": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4-8-thinking": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-4.6": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-4-6": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-5": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-5-thinking": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-5-agentic": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-5-thinking-agentic": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },

  // Gemini image-gen / OpenAI image / xai image variants
  "gpt-image-1":       { imageOutput: true, tools: false },

  // GLM vision variant (text GLM has no vision)
  "glm-4.6v":          { vision: true, reasoning: true, thinkingFormat: "zai", contextWindow: 128000 },
  "GLM-4.6V-Flash":    { vision: true, reasoning: true, thinkingFormat: "zai", contextWindow: 200000 },
  "glm-5.3-flash":     { vision: true, videoInput: true, pdf: true, reasoning: true, thinkingFormat: "zai", contextWindow: 1000000, maxOutput: 131072 },

  // Qwen plain coder/text (no vision) — registry "vision-model" / "coder-model" aliases
  "vision-model":      { vision: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000 },
  "coder-model":       { reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000 },

  // Kimi flagship + coding (platform + Kimi Code ids) — vision/video native
  "kimi-k3":           { vision: true, videoInput: true, reasoning: true, thinkingFormat: "kimi", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 131072 },
  "k3":                { vision: true, videoInput: true, reasoning: true, thinkingFormat: "kimi", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 131072 },
  "kimi-for-coding":   { vision: true, videoInput: true, reasoning: true, thinkingFormat: "kimi", thinkingCanDisable: false, contextWindow: 262144, maxOutput: 65536 },
  "kimi-for-coding-highspeed": { vision: true, videoInput: true, reasoning: true, thinkingFormat: "kimi", thinkingCanDisable: false, contextWindow: 262144, maxOutput: 65536 },
  "kimi-k2.7-code":    { vision: true, videoInput: true, reasoning: true, thinkingFormat: "kimi", thinkingCanDisable: false, contextWindow: 262144, maxOutput: 65536 },
  "kimi-k2.7-code-highspeed": { vision: true, videoInput: true, reasoning: true, thinkingFormat: "kimi", thinkingCanDisable: false, contextWindow: 262144, maxOutput: 65536 },

  // Agnes AI (agnes-ai / agnes-ai-cn) — OpenAI-compatible gateway; multimodal
  // (text+image input) + reasoning. Specs from official docs
  // agnes-ai.com/zh-Hans/docs/{agnes-25-flash,agnes-25-pro}. agnes-2.0-flash &
  // 2.5-pro-alpha are deprecated upstream — not registered here (migrate to
  // 2.5-flash / 2.5-pro).
  "agnes-2.5-flash":  { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 512000, maxOutput: 65536 },
  "agnes-2.5-pro":    { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 65536 },

  // DeepSeek V4 视觉实验版。写成 canonical（而非 provider 行）是因为同一个 id
  // 被四家同时上架——commandcode、deepseek、opencode-go 与 B.AI——而它们原本
  // 全部落到 `*deepseek-v4*` 通配，那条通配不声明 vision，于是这个名字里就写着
  // vision 的模型被判为纯文本、图片会在 modality 层被静默剥掉。
  // 值取自 19 条 models.dev 条目（nano-gpt / orcarouter / above / crossmodel /
  // huggingface `deepseek-ai/DeepSeek-V4-Flash-Vision-Exp` 等），一致报
  // text+image、1M 输入、384K 输出。thinkingFormat 沿用通配的 deepseek 形状，
  // 不改动这四家现有的请求报文。
  // ⚠️ 裸的 `deepseek-v4-flash` 不是这个模型——转售商端它是纯文本（Ark 第一方
  // `deepseek-v4-flash-ga-260731` 报 attach:false），因此刻意不给它写行，让它继续
  // 落通配的 vision:false。注意 DeepSeek 第一方自 2026-09-10 起把这个 id（连同
  // `deepseek-v4-pro`）临时路由到多模态的 V4.1 Flash，但转售商仍挂纯文本
  // V4-Flash，所以这里仍取保守值；需要视觉请走 `deepseek-flash`。
  "deepseek-v4-flash-vision-exp": { vision: true, reasoning: true, thinkingFormat: "deepseek", contextWindow: 1000000, maxOutput: 384000 },

  // DeepSeek-V4.1-Flash 有两个官方 id，各占一行，都写成 canonical（模型自身的名字，
  // 多家 reseller 会复用）：
  //   · `deepseek-flash` —— 第一方 2026-09-10 更新日志定的新名（「Change the model
  //     name to deepseek-flash to call the latest V4.1 Flash model」），opencode-go
  //     的 /models 目录里也挂着同名 id。
  //   · `deepseek-v4.1-flash` —— opencode-go 官方文档表主推的 id；codebuddy-cn 的同名
  //     模型走它自己的 provider 行（openai 思考格式，provider 行优先）。
  // 两行同源：更新日志写明是 native multimodal，同页 Models & Pricing 表逐项给出
  // 1M 输入 / MAX OUTPUT 384K / Vision ✓ / 思考默认开且可切非思考；models.dev 上
  // `deepseek-v4.1-flash` 的 24 条条目一致报 text+image 1M/384000。
  // 不写的话：`deepseek-flash` 落到 `*deepseek*` 通配（V3 时代的 128K / 64000 /
  // vision:false），`deepseek-v4.1-flash` 落到 `*deepseek-v4*` 通配（1M/384000 但
  // vision:false）——两者都会把图片在 modality 层静默剥掉。
  "deepseek-flash": { vision: true, reasoning: true, thinkingFormat: "deepseek", contextWindow: 1000000, maxOutput: 384000 },
  "deepseek-v4.1-flash": { vision: true, reasoning: true, thinkingFormat: "deepseek", contextWindow: 1000000, maxOutput: 384000 },

  // ── models.dev 补齐（此前这些 id 全部落 DEFAULT_CAPABILITIES：vision 被剥、
  // contextWindow 200000、maxOutput 64000）──
  // 写 canonical 而非 provider 行的理由：这些 id 是模型自身的名字，reseller
  // （commandcode / tokenrouter / kilo / cline …）随时可能挂同一个 id，一行即可
  // 覆盖；带 vendor 前缀的写法（sakana/fugu-ultra、meta/muse-spark-1.1）按
  // baseModel 也能命中。thinkingFormat 一律 openai——这些上游都是 OpenAI 兼容
  // 网关，与本文件 big-pickle / agnes-2.5-* 等既有行同一口径；非 OpenAI 兼容的
  // 上游（DeepSeek 官方、Kimi、GLM）各走已有的 provider 行或专用 pattern。
  // 来源：models.dev 快照，逐条注明条目；多家冲突时取保守值并说明。
  "muse-spark-1.1":            { vision: true, videoInput: true, pdf: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1048576, maxOutput: 131072 }, // meta/muse-spark-1.1；与既有-1.2-contributor-free(-1.3) 行同值
  "muse-spark-1.2":            { vision: true, videoInput: true, pdf: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1048576, maxOutput: 131072 }, // meta/muse-spark-1.2
  "muse-spark-1.2-contributor":{ vision: true, videoInput: true, pdf: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1048576, maxOutput: 131072 }, // meta/muse-spark-1.2-contributor
  // Sakana Fugu Ultra：各家都报 text+image、1M 输入；输出上限有两派——第一方
  // sakana 报 1000000（等于“无上限”），pioneer/requesty/empiriolabs 一致报 131072，
  // 取后者作保守上限（maxOutput 是 claude.js adjustMaxTokens 的硬夹子）。
  "fugu-ultra":                 { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 131072 },
  // （曾为 stealth/ox-alpha 写过一行：该 id 已下架，实为 glm-5.3-flash 的测试马甲——
  // 同一家的 z-ai/glm-5.3-flash 才是正式 id。已知马甲不再声明，否则将来它作为
  // “私有代号”重新出现在某家 reseller 列表里会被误当成独立模型。）
  // 腾讯混元 Hy4 Preview：9 处条目（含第一方 tencent-tokenhub）全部 in:text——
  // “预览版”名字里没有多模态线索，早先按视觉模型写过 vision:true 是错的。
  // 此处覆盖 commandcode / codebuddy-intl；codebuddy-cn 另有 provider 行
  // （thinkingCanDisable:false 是服务端口径，保留）。
  "hy4-preview":                { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 64000 },
  // OpenAI gpt-audio：输入 text+audio(+pdf)、输出 text+audio，无视觉。
  "gpt-audio":                  { audioInput: true, audioOutput: true, contextWindow: 128000, maxOutput: 16384 },
  "gpt-audio-mini":             { audioInput: true, audioOutput: true, contextWindow: 128000, maxOutput: 16384 },
  "LongCat-2.0":                { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 131072 }, // longcat/LongCat-2.0（第一方）；纯文本
  "sensenova-6.8-flash-lite":   { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 262144, maxOutput: 65536 }, // sensenova（第一方）
  "venice-uncensored-1-2":      { vision: true, contextWindow: 128000, maxOutput: 8192 }, // venice（第一方）；无 reasoning
  // Morph：第一方明说纯文本且 **不支持工具调用**（tools:false 必须显式写，
  // DEFAULT_CAPABILITIES 里 tools 默认为 true）。
  "morph-v3-large":             { tools: false, contextWindow: 32000, maxOutput: 32000 }, // morph（第一方）
  "morph-v3-fast":              { tools: false, contextWindow: 16000, maxOutput: 16000 }, // morph（第一方）
};

const KIRO_GPT_5_6_CAPABILITIES = { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 272000, maxOutput: 128000 };

// Codex OAuth (ChatGPT backend) — per-model context window reported by upstream
// (lower than OpenAI API's 1.05M). Sol differs from Terra/Luna. #2720
const CODEX_GPT_56_SOL_CAPS  = { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 372000, maxOutput: 128000 };
const CODEX_GPT_56_DEFAULT_CAPS = { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 272000, maxOutput: 128000 };

/**
 * Provider-specific capability overrides. Keyed by provider alias/id.
 */
export const PROVIDER_CAPABILITIES = {
  // Antigravity's display id is a legacy alias for Gemini 3.1 Pro High. It
  // does not contain the `gemini-3` substring, so the generic Gemini pattern
  // cannot identify its thinking support. Keep this provider-specific entry
  // aligned with the Antigravity/CLIProxyAPI model catalog.
  "antigravity": {
    "gemini-pro-agent": {
      vision: true,
      audioInput: true,
      videoInput: true,
      reasoning: true,
      search: true,
      thinkingFormat: "gemini-level",
      thinkingCanDisable: false,
      contextWindow: 1048576,
      maxOutput: 65535,
    },
  },
  // NVIDIA NIM is OpenAI-compatible → rejects MiniMax/GLM native `thinking` field.
  // Force openai reasoning_effort format for its reasoning models. #issue
  "nvidia": {
    "minimaxai/minimax-m2.7": { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 131072 },
    "minimaxai/minimax-m3": { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 512000, maxOutput: 131072 },
    "z-ai/glm-5.2": { reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 128000 },
    "deepseek-ai/deepseek-v4-pro": { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 65536 },
    "deepseek-ai/deepseek-v4-flash": { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 65536 },
  },
  // AMD Token Factory (Radeon Cloud) free shared endpoints — OpenAI protocol,
  // text-only (image_url → 400), reasoning via reasoning_effort only (native
  // `thinking` field → 400). DeepSeek defaults to no thinking; Qwen thinks by
  // default (internal xhigh) and only accepts low/medium, so it cannot disable.
  // maxOutput: upstream publishes no output cap (max_tokens counts the total
  // budget) — values here are conservative UI hints, not wire limits.
  "amd": {
    "DeepSeek-V4-Flash":  { reasoning: true, thinkingFormat: "openai", contextWindow: 1048576, maxOutput: 65536 },
    "Qwen3.8-Flash-Next": { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 262144, maxOutput: 32768 },
  },
  "codex": {
    "gpt-6-astra":               { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 272000, maxOutput: 128000 },
    "gpt-5.6-sol":               CODEX_GPT_56_SOL_CAPS,
    "gpt-5.6-sol-review":        CODEX_GPT_56_SOL_CAPS,
    "gpt-5.6-terra":             CODEX_GPT_56_DEFAULT_CAPS,
    "gpt-5.6-terra-review":      CODEX_GPT_56_DEFAULT_CAPS,
    "gpt-5.6-luna":              CODEX_GPT_56_DEFAULT_CAPS,
    "gpt-5.6-luna-review":       CODEX_GPT_56_DEFAULT_CAPS,
  },
  "kiro": {
    "gpt-5.6-sol": KIRO_GPT_5_6_CAPABILITIES,
    "gpt-5.6-terra": KIRO_GPT_5_6_CAPABILITIES,
    "gpt-5.6-luna": KIRO_GPT_5_6_CAPABILITIES,
    "gpt-5.6-sol-thinking": KIRO_GPT_5_6_CAPABILITIES,
    "gpt-5.6-terra-thinking": KIRO_GPT_5_6_CAPABILITIES,
    "gpt-5.6-luna-thinking": KIRO_GPT_5_6_CAPABILITIES,
    "gpt-5.6-sol-agentic": KIRO_GPT_5_6_CAPABILITIES,
    "gpt-5.6-terra-agentic": KIRO_GPT_5_6_CAPABILITIES,
    "gpt-5.6-luna-agentic": KIRO_GPT_5_6_CAPABILITIES,
    "gpt-5.6-sol-thinking-agentic": KIRO_GPT_5_6_CAPABILITIES,
    "gpt-5.6-terra-thinking-agentic": KIRO_GPT_5_6_CAPABILITIES,
    "gpt-5.6-luna-thinking-agentic": KIRO_GPT_5_6_CAPABILITIES,
  },
  // CodeBuddy.cn — authoritative per-model metadata from the gateway's model
  // config (contextWindow=maxInputTokens, maxOutput=maxOutputTokens, vision=
  // supportsImages). Every model reasons via OpenAI-style reasoning_effort
  // (see registry thinkingFormat). For thinkingCanDisable use the server's
  // reasoning.canDisableThinking flag — see the note in the codebuddy-cn block
  // below; it is NOT the inverse of onlyReasoning.
  "codebuddy-cn": {
    "glm-5.2":            { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true, contextWindow: 1000000, maxOutput: 48000 },
    "glm-5.1":            { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 48000 },
    // maxOutput 64000 per both the plugin-baked fallback and the live server
    // table (the old 38000 had no source and truncated output).
    "glm-5v-turbo":       { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 64000 },
    "minimax-m3":         { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 512000, maxOutput: 128000 },
    "kimi-k2.7":          { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 256000, maxOutput: 32000 },
    "kimi-k2.6":          { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 256000, maxOutput: 32000 },
    // Per-model values mirror the server's product-config payload (fetched
    // from copilot.tencent.com; the `models[]` entries carry
    // maxInputTokens/maxOutputTokens/supportsImages). contextWindow =
    // maxInputTokens, maxOutput = maxOutputTokens. Where the server and the
    // plugin-baked fallback disagree, the server table wins.
    // ⚠️ thinkingCanDisable maps to the server's reasoning.canDisableThinking —
    // it is NOT the inverse of onlyReasoning. onlyReasoning means "thinking is
    // on by default"; canDisableThinking means "it CAN be turned off". glm-5.3
    // and glm-5.3-flash are onlyReasoning:true BUT canDisableThinking:true, so
    // their thinking is switchable; the hy* models are forced always-on.
    "hy3":                { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 192000, maxOutput: 64000 },
    "hy4-preview":        { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 64000 },
    "glm-5.3":            { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true, contextWindow: 1000000, maxOutput: 48000 },
    "glm-5.3-flash":      { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true, contextWindow: 1000000, maxOutput: 32000 },
    "kimi-k3":            { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 32000 },
    // DeepSeek-V4-Pro：纯文本（模型卡 text→text；models.dev 124 条命中一致报
    // attach:false，火山方舟第一方 deepseek-v4-pro-ga-260813 亦然）。1M 输入 /
    // 384K 输出。此前误标 vision:true 会让图片绕过 modality 剥离直接打到上游，
    // 而 50000 是改名前的旧值，会把 max_tokens 夹小 7 倍（claude.js adjustMaxTokens）。
    "deepseek-v4-pro":    { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true, contextWindow: 1000000, maxOutput: 384000 },
    // DeepSeek-V4.1-Flash：1M 输入 / 384K 输出，文本+图像进，思考默认开但可关
    // （模型卡：思考水平 High 默认，另有常规模式 / Low / Max）。384000 与
    // *deepseek-v4* 通配、B.AI 的 V4 行一致；改名前的 50000 会把 max_tokens
    // 夹小 7 倍（claude.js adjustMaxTokens）。
    // 模型卡把 deepseek-flash / deepseek-v4-flash 列为“别名”：deepseek-flash 正是
    // V4.1-Flash 的官方 id（第一方 2026-09-10 起），canonical 行在
    // MODEL_CAPABILITIES；裸的 deepseek-v4-flash 在转售商端仍是纯文本，落到通配
    // 即可，本表不留行。deepseek-v4-flash-vision-exp 是另一个多模态 id，走
    // MODEL_CAPABILITIES 的 canonical 行（四家共用：commandcode / deepseek /
    // opencode-go / B.AI，写这里只覆盖 CN 一家）。
    // 下面这行同样是 CAN 侧的 provider 行覆盖：canonical 行已给出同一套数值，这里是
    // 因为 CN 网关走 openai 思考格式且允许关闭思考（provider 行优先于 canonical）。
    "deepseek-v4.1-flash": { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true, contextWindow: 1000000, maxOutput: 384000 },
  },
  // Qoder — upstream exposes opaque internal ids (dfmodel, kmodel, …); the
  // registry `name` is display-only and capability lookup matches on the raw
  // id, so every qoder model would fall through to DEFAULT_CAPABILITIES
  // (200K) without this map. contextWindow follows the real model family's
  // spec: the /algo/api/v2/model/list max_input_tokens under-reports some
  // windows (GLM-5.3 / Kimi-K3 / Qwen3.8-Max claim 180K but accept more).
  // max_output_tokens arrives as 0 for every model, so outputs are
  // best-guess from the real model family. Vision tags below follow the
  // upstream is_vl flag per explicit request, even though the executor
  // currently sends image_urls:null (image pass-through over the agent_chat
  // SSE protocol is unverified). reasoning:true on all of them — every model can
  // reason; the upstream is_reasoning flag only drives model_config selection.
  // thinkingFormat keeps the true-model family for documentation/UI, but
  // thinkingCanDisable:false everywhere: the executor only forwards
  // messages/tools/max_tokens, and thinking is fixed upstream via
  // modelConfig.is_reasoning — client thinking intent is dropped, so "none"
  // must never be offered as an option.
  "qoder": {
    "ultimate":       { vision: true, reasoning: true, thinkingFormat: "claude-adaptive", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 128000 }, // Claude Opus 5
    "performance":    { vision: true, reasoning: true, thinkingFormat: "claude-adaptive", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 128000 }, // Claude Sonnet 5
    "dmodel":         { reasoning: true, thinkingFormat: "deepseek", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 65536 },  // DeepSeek-V4-Pro
    "dfmodel":        { reasoning: true, thinkingFormat: "deepseek", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 65536 },  // DeepSeek-V4-Flash
    "gmodel":         { reasoning: true, thinkingFormat: "zai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 128000 },      // GLM-5.3
    "gfmodel":        { vision: true, reasoning: true, thinkingFormat: "zai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 128000 }, // GLM-5.3-Flash
    "kmodel_latest":  { vision: true, reasoning: true, thinkingFormat: "kimi", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 65536 },      // Kimi-K3
    "kmodel":         { vision: true, reasoning: true, thinkingFormat: "kimi", thinkingCanDisable: false, contextWindow: 256000, maxOutput: 65536 },  // Kimi-K2.7-Code
    "mmodel":         { reasoning: true, thinkingFormat: "minimax", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 512000 }, // MiniMax-M3
    "qmodel_latest":  { vision: true, reasoning: true, thinkingFormat: "qwen", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 65536 },  // Qwen3.7-Max
    "qmodel":         { vision: true, reasoning: true, thinkingFormat: "qwen", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 65536 },  // Qwen3.7-Plus
    "qfmodel":        { vision: true, reasoning: true, thinkingFormat: "qwen", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 65536 },  // Qwen3.8-Flash
    "qmodel_38max":   { vision: true, reasoning: true, thinkingFormat: "qwen", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 65536 },      // Qwen3.8-Max
  },
  // Poolside Laguna — OpenAI-compatible, all reasoning-capable (32K max output).
  "poolside": {
    "laguna-s-2.1":  { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 32000 },
    "laguna-xs-2.1": { reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 32000 },
  },
  // APInex — vendor-prefixed upstream ids, keys are the FULL ids (the generic
  // base-model strip would mangle "glm/5.3-flash" → "5.3-flash"). Context
  // windows from the upstream catalog (grok 500K, gpt/5.6-luna 1.05M, rest
  // 1M). All families reason; gateway exposes thinking inline (verified live
  // on the free/* models). Vision unverified — not claimed.
  "apinex": {
    "grok/4.6":                    { reasoning: true, thinkingFormat: "openai", contextWindow: 500000 },
    "claude/opus-5":               { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000 },
    "claude/sonnet-5":             { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000 },
    "gpt/5.6-sol":                 { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000 },
    "gpt/5.6-terra":               { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000 },
    "gpt/5.6-luna":                { reasoning: true, thinkingFormat: "openai", contextWindow: 1050000 },
    "gemini/3.1-pro":              { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000 },
    "gemini/3.8-flash":            { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000 },
    "deepseek/v4-flash-0731":      { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000 },
    "deepseek/v4-pro-0813":        { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000 },
    "glm/5.3-flash":               { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000 },
    "glm/5.3":                     { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000 },
    "kimi/k3":                     { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000 },
    "free/glm-5.3-flash":          { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000 },
    "free/deepseek-v4-flash-0731": { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000 },
    "free/deepseek-v4-pro-0813":   { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000 },
    "free/gpt-5.6-luna":           { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000 },
    "free/qwen-3.8-max":           { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000 },
  },
};

/**
 * Pattern fallback — glob (* = wildcard), matched case-insensitively and
 * anchored (^...$) so a pattern must match the full model id. ORDER MATTERS:
 * vision/specific variants first, text-only/generic families last, to avoid
 * a broad family pattern swallowing an exception (e.g. glm-4.6v vs glm-5).
 */
export const PATTERN_CAPABILITIES = [
  // ── Claude (4.6+ = adaptive thinking; older/haiku = budget) ──────
  { pattern: "*claude*opus-5*",     caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*claude*opus-4.6*",   caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive" } },
  { pattern: "*claude*opus-4.7*",   caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive" } },
  { pattern: "*claude*opus-4.8*",   caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive" } },
  { pattern: "*claude*sonnet-4.6*", caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive" } },
  { pattern: "*claude*sonnet-4.7*", caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive" } },
  { pattern: "*claude*haiku*",  caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-budget" } },
  { pattern: "*claude*opus*",   caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-budget" } },
  { pattern: "*claude*sonnet*", caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-budget" } },
  { pattern: "*claude*fable*",  caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-budget", contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*claude*mythos*", caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-budget", contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*claude-3*",      caps: { vision: true } },
  { pattern: "*claude*",        caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-budget" } },

  // ── Gemini (all 2.0+ multimodal + google_search grounding, 1M ctx) ─
  { pattern: "*gemini*image*",  caps: { vision: true, imageOutput: true, contextWindow: 1048576 } },
  { pattern: "*gemini-3.8*",    caps: { vision: true, audioInput: true, videoInput: true, reasoning: true, search: true, thinkingFormat: "gemini-level", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 65536 } },
  { pattern: "*gemini-3.7*",    caps: { vision: true, audioInput: true, videoInput: true, reasoning: true, search: true, thinkingFormat: "gemini-level", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 65536 } },
  { pattern: "*gemini-3*pro*",  caps: { vision: true, audioInput: true, videoInput: true, reasoning: true, search: true, thinkingFormat: "gemini-level", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 65535 } },
  { pattern: "*gemini-3*",      caps: { vision: true, audioInput: true, videoInput: true, reasoning: true, search: true, thinkingFormat: "gemini-level", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 65536 } },
  { pattern: "*gemini-2.5*",    caps: { vision: true, audioInput: true, videoInput: true, reasoning: true, search: true, thinkingFormat: "gemini-budget", thinkingRange: { min: 0, max: 24576 }, contextWindow: 1048576, maxOutput: 65536 } },
  { pattern: "*gemini-2*",      caps: { vision: true, audioInput: true, videoInput: true, search: true, contextWindow: 1048576, maxOutput: 65536 } },
  { pattern: "*gemini*",        caps: { vision: true, search: true, contextWindow: 1048576 } },
  { pattern: "*gemma*",         caps: { vision: true, contextWindow: 128000 } },
  { pattern: "*nanobanana*",    caps: { vision: true, imageOutput: true } },

  // ── OpenAI GPT-6.x (vision + thinking + web search) ──────────────
  { pattern: "*gpt-6*",         caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 272000, maxOutput: 128000 } },

  // ── OpenAI GPT-5.x (vision + thinking + web search) ──────────────
  { pattern: "*gpt-5*image*",   caps: { imageOutput: true } },
  { pattern: "*gpt-5*codex*",   caps: { reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 400000, maxOutput: 128000 } },
  { pattern: "*gpt-5*",         caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 400000, maxOutput: 128000 } },
  { pattern: "*gpt-4o*",        caps: { vision: true, search: true, contextWindow: 128000, maxOutput: 16384 } },
  { pattern: "*gpt-4.1*",       caps: { vision: true, contextWindow: 1000000, maxOutput: 32768 } },
  { pattern: "*gpt-4-turbo*",   caps: { vision: true, contextWindow: 128000 } },
  { pattern: "*gpt-4*",         caps: { contextWindow: 128000 } },
  { pattern: "*gpt-3.5*",       caps: { contextWindow: 16385, maxOutput: 4096 } },
  { pattern: "*gpt-oss*",       caps: { reasoning: true, thinkingFormat: "openai", contextWindow: 128000 } },

  // ── OpenAI o-series (reasoning, vision) ──────────────────────────
  { pattern: "*o1-mini*",       caps: { reasoning: true, thinkingFormat: "openai", contextWindow: 128000 } },
  { pattern: "*o1*",            caps: { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 100000 } },
  { pattern: "*o3*",            caps: { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 100000 } },
  { pattern: "*o4*",            caps: { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 100000 } },

  // ── Grok (vision + Live Search) ──────────────────────────────────
  { pattern: "*grok*image*",    caps: { imageOutput: true } },
  { pattern: "*grok-code*",     caps: { reasoning: true, thinkingFormat: "openai", contextWindow: 256000 } },
  // Grok 4.5 (Grok CLI / Grok Build): 500k context per cli-chat-proxy /v1/models
  // Grok 4.6: 500k context, no text output limit (docs.x.ai/developers/grok-4-6)
  { pattern: "*grok-4.6*",      caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 500000, maxOutput: 500000 } },
  { pattern: "*grok-4.5*",      caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 500000, maxOutput: 64000 } },
  { pattern: "*grok-4*",        caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 256000 } },
  { pattern: "*grok-3*",        caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 131072 } },
  { pattern: "*grok*",          caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 256000 } },

  // ── Qwen (3.5+ = native vision/video; coder & max = text-only; QwQ = thinking-only) ─
  { pattern: "*qwen*vl*",       caps: { vision: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 262144 } },
  { pattern: "*qwen*omni*",     caps: { vision: true, audioInput: true, videoInput: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 262144, maxOutput: 65536 } },
  { pattern: "*qwen*coder*",    caps: { reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000 } },
  { pattern: "*qwen*max*",      caps: { reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen3.5*",       caps: { vision: true, videoInput: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen3.6*",       caps: { vision: true, videoInput: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen3.7*",       caps: { vision: true, videoInput: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen*plus*",     caps: { vision: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen*235b*",     caps: { reasoning: true, thinkingFormat: "qwen", contextWindow: 262144 } },
  { pattern: "*qwq*",           caps: { reasoning: true, thinkingFormat: "qwen", thinkingCanDisable: false, contextWindow: 131072 } },
  { pattern: "*qwen*",          caps: { reasoning: true, thinkingFormat: "qwen", contextWindow: 262144 } },

  // ── Kimi (enabled→reasoning_effort; K2.7-code cannot disable) ─────
  { pattern: "*kimi*k3*",       caps: { vision: true, videoInput: true, reasoning: true, thinkingFormat: "kimi", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 131072 } },
  { pattern: "*kimi*for-coding*", caps: { vision: true, videoInput: true, reasoning: true, thinkingFormat: "kimi", thinkingCanDisable: false, contextWindow: 262144, maxOutput: 65536 } },
  { pattern: "*kimi*k2.7*code*", caps: { vision: true, videoInput: true, reasoning: true, thinkingFormat: "kimi", thinkingCanDisable: false, contextWindow: 262144, maxOutput: 65536 } },
  { pattern: "*kimi*k2*",       caps: { vision: true, reasoning: true, thinkingFormat: "kimi", contextWindow: 262144, maxOutput: 262144 } },
  { pattern: "*kimi*",          caps: { reasoning: true, thinkingFormat: "kimi", contextWindow: 262144 } },

  // ── GLM / Z.ai (thinking.enabled; disable via enable_thinking:false) ─
  { pattern: "*glm-5*",         caps: { reasoning: true, thinkingFormat: "zai", contextWindow: 200000, maxOutput: 128000 } },
  { pattern: "*glm-4.7*",       caps: { reasoning: true, thinkingFormat: "zai", contextWindow: 200000, maxOutput: 128000 } },
  { pattern: "*glm-4*",         caps: { reasoning: true, thinkingFormat: "zai", contextWindow: 200000 } },
  { pattern: "*glm*",           caps: { reasoning: true, thinkingFormat: "zai", contextWindow: 200000 } },

  // ── DeepSeek (thinking.enabled + reasoning_effort; r1 = thinking-only) ─
  { pattern: "*deepseek-v4*",   caps: { reasoning: true, thinkingFormat: "deepseek", contextWindow: 1000000, maxOutput: 384000 } },
  { pattern: "*reasoner*",      caps: { reasoning: true, thinkingFormat: "deepseek", thinkingCanDisable: false, contextWindow: 128000 } },
  { pattern: "*deepseek-r*",    caps: { reasoning: true, thinkingFormat: "deepseek", thinkingCanDisable: false, contextWindow: 128000 } },
  { pattern: "*deepseek-chat*", caps: { contextWindow: 128000 } },
  { pattern: "*deepseek*",      caps: { reasoning: true, thinkingFormat: "deepseek", contextWindow: 128000 } },

  // ── MiniMax (M3 = adaptive; M2.x cannot disable) ─────────────────
  { pattern: "*minimax*image*", caps: { imageOutput: true } },
  { pattern: "*minimax-m3*",    caps: { vision: true, reasoning: true, thinkingFormat: "minimax", contextWindow: 1048576, maxOutput: 512000 } },
  { pattern: "*minimax-m2.7*",  caps: { reasoning: true, thinkingFormat: "minimax", thinkingCanDisable: false, contextWindow: 204800, maxOutput: 131072 } },
  { pattern: "*minimax*",       caps: { reasoning: true, thinkingFormat: "minimax", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 131072 } },

  // ── Xiaomi MiMo (vision, 1M / 262K ctx) ──────────────────────────
  { pattern: "*mimo*v2.5*",     caps: { vision: true, audioInput: true, videoInput: true, contextWindow: 1048576, maxOutput: 131072 } },
  { pattern: "*mimo*omni*",     caps: { vision: true, audioInput: true, contextWindow: 262144, maxOutput: 131072 } },
  { pattern: "*mimo*",          caps: { vision: true, contextWindow: 262144, maxOutput: 131072 } },

  // ── Llama (4 = vision/1M; 3.x = text-only/128K) ──────────────────
  { pattern: "*llama-4*",       caps: { vision: true, contextWindow: 1000000 } },
  { pattern: "*llama*",         caps: { contextWindow: 128000 } },

  // ── Mistral (Large 3 = vision/256K; codestral text) ──────────────
  { pattern: "*codestral*",     caps: { contextWindow: 256000 } },
  { pattern: "*mistral-large*", caps: { vision: true, contextWindow: 256000 } },
  { pattern: "*mistral*",       caps: { contextWindow: 128000 } },

  // ── Cohere (Command A Vision = vision; others text) ──────────────
  { pattern: "*command-a-vision*", caps: { vision: true, contextWindow: 128000 } },
  { pattern: "*command*",       caps: { contextWindow: 128000 } },

  // ── Perplexity (web search native) ───────────────────────────────
  { pattern: "*sonar*",         caps: { search: true, contextWindow: 128000 } },
  { pattern: "*pplx*",          caps: { search: true, contextWindow: 128000 } },
  { pattern: "*perplexity*",    caps: { search: true, contextWindow: 128000 } },

  // ── Poolside Laguna (resellers: openrouter/nvidia/kilocode/vercel/...) ──
  // Free tiers cap S 2.1 well below the paid 1M window → match the free suffix
  // (":free" or "-free", depending on reseller) before the plain id.
  { pattern: "*laguna-s-2.1*free*", caps: { reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 32000 } },
  { pattern: "*laguna-s-2.1*",  caps: { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 32000 } },
  { pattern: "*laguna*",        caps: { reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 32000 } },

  // ── ByteDance Doubao-Seed 2.0 ─────────────────────────────────────────
// 第一方是火山方舟（Ark 模型列表 / models.dev volcengine）；reseller 有 byteplus /
// tokenrouter / kilo / qiniu-ai…，同一个模型在不同家写作 seed-2-0-*（带快照日期）或
// Doubao-Seed-2.0-*（Ark 控制台显示名）。历史上一律落兜底。
// 按“族”归并以避免每来一个新快照日期就补一行；值取第一方：Ark 模型列表写
// 「上下文窗口 256k / 最大输入 224k / 最大回答 128k / 最大思维链 128k」，
// models.dev 第一方 volcengine 同条目给 262144 / 131072（reseller 报的
// 32000 / 128000 一律不取）。
// Ark 模型列表里 Seed-2.0 系列共 4 款：pro / lite / mini / code，
// code 即 `doubao-seed-2-0-code-preview-260215`（能力：深度思考 / 多模态理解 /
// GUI 任务处理 / 工具调用 / 结构化输出）。
// ⚠️ `Doubao-Seed-Code`（不带 2.0）是**另一支**旧模型 `doubao-seed-code`
// （`doubao-seed-code-preview-251028`，Ark 已标「即将下线」）：上下文同为 256k，
// 但最大回答只有 32k，不要与 2.0 的 code 互相套用（见下方 *seed-code*）。
{ pattern: "*seed-2-0-pro*",   caps: { vision: true, videoInput: true, reasoning: true, thinkingFormat: "openai", contextWindow: 256000, maxOutput: 128000 } },
{ pattern: "*seed-2.0-pro*",   caps: { vision: true, videoInput: true, reasoning: true, thinkingFormat: "openai", contextWindow: 256000, maxOutput: 128000 } },
{ pattern: "*seed-2-0-code*",  caps: { vision: true, videoInput: true, reasoning: true, thinkingFormat: "openai", contextWindow: 262144, maxOutput: 131072 } },
{ pattern: "*seed-2.0-code*",  caps: { vision: true, videoInput: true, reasoning: true, thinkingFormat: "openai", contextWindow: 262144, maxOutput: 131072 } },
{ pattern: "*seed-2-0-mini*",  caps: { vision: true, videoInput: true, reasoning: true, thinkingFormat: "openai", contextWindow: 256000, maxOutput: 131072 } },
{ pattern: "*seed-2.0-mini*",  caps: { vision: true, videoInput: true, reasoning: true, thinkingFormat: "openai", contextWindow: 256000, maxOutput: 131072 } },
{ pattern: "*seed-2-0-lite*",  caps: { vision: true, videoInput: true, reasoning: true, thinkingFormat: "openai", contextWindow: 256000, maxOutput: 131072 } },
{ pattern: "*seed-2.0-lite*",  caps: { vision: true, videoInput: true, reasoning: true, thinkingFormat: "openai", contextWindow: 256000, maxOutput: 131072 } },

// 旧支 seed-code（Ark 模型列表标「即将下线」）：256k 上下文 / 224k 最大输入 /
// 32k 最大回答 / 32k 最大思维链；能力 深度思考 / 多模态理解 / 视觉定位 / 工具调用。
// output 取第一方 32k（reseller zenmux 报 64000，偏大不取）；文档未提视频，故不给
// videoInput。`*seed-code*` 与 `*seed-2-0-code*` 无公共子串，不会互相命中。
{ pattern: "*seed-code*",      caps: { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 256000, maxOutput: 32768 } },

// ── Others ───────────────────────────────────────────────────────
  { pattern: "*hunyuan*",       caps: { reasoning: true, thinkingFormat: "hunyuan", contextWindow: 262144, maxOutput: 262144 } },
  { pattern: "hy3*",            caps: { reasoning: true, thinkingFormat: "hunyuan", contextWindow: 262144, maxOutput: 262144 } },
  { pattern: "*step-*",         caps: { reasoning: true, thinkingFormat: "step", contextWindow: 128000 } },
  { pattern: "*nemotron*",      caps: { reasoning: true, contextWindow: 128000 } },
  { pattern: "*ling-*",         caps: { reasoning: true, contextWindow: 128000 } },
];

/**
 * Resolve capabilities for a model using the 4-step fallback chain,
 * merged over DEFAULT_CAPABILITIES so the result is always complete.
 *
 * @param {string} provider
 * @param {string} model
 * @returns {object} full capabilities object
 */
export function getCapabilitiesForModel(provider, model) {
  if (!model) return { ...DEFAULT_CAPABILITIES };

  // Canonical exact lookup strips vendor prefix: "anthropic/claude-opus-4.7" -> "claude-opus-4.7".
  const baseModel = model.includes("/") ? model.split("/").pop() : model;

  // 1. Provider-specific override
  if (provider) {
    const providerCaps = PROVIDER_CAPABILITIES[provider];
    if (providerCaps?.[model]) return { ...DEFAULT_CAPABILITIES, ...providerCaps[model] };
    if (providerCaps?.[baseModel]) return { ...DEFAULT_CAPABILITIES, ...providerCaps[baseModel] };
  }

  // 2. Canonical exact
  if (MODEL_CAPABILITIES[baseModel]) return { ...DEFAULT_CAPABILITIES, ...MODEL_CAPABILITIES[baseModel] };
  if (MODEL_CAPABILITIES[model]) return { ...DEFAULT_CAPABILITIES, ...MODEL_CAPABILITIES[model] };

  // 3. Pattern match (first match wins)
  for (const { pattern, caps } of PATTERN_CAPABILITIES) {
    if (matchPattern(pattern, baseModel) || matchPattern(pattern, model)) {
      return { ...DEFAULT_CAPABILITIES, ...caps };
    }
  }

  // 4. Floor
  return { ...DEFAULT_CAPABILITIES };
}
