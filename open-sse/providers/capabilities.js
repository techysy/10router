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
  // opus-5.5 (upstream 2026-09-23): family envelope carried over from opus-5 —
  // the *claude*opus* pattern would under-declare it as 200K/claude-budget.
  "claude-opus-5-5":   { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  // opus-5.5 点号 id 变体（Kiro，上游 e78b766a）：`*claude*opus-5*` pattern
  // 已命中同值，写精确键是为了不依赖 pattern 顺序并标明这些 id 真实存在。
  "claude-opus-5.5":   { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-5.5-thinking": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-5.5-agentic": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-5.5-thinking-agentic": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },

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
  // 3.1 窗口翻倍到 256K（models.dev opencode 262144/32768），仍纯文本进。
  "ling-3.1-flash-free":       { reasoning: true, thinkingFormat: "openai", contextWindow: 262144, maxOutput: 32768 },
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
  // 4.6 的 thinking 变体必须显式列出（2026-09-26）：antigravity 的 id 是横杠形态
  // `claude-opus-4-6-thinking`，点号 pattern `*claude*opus-4.6*` 匹配不上，会落到
  // `*claude*opus*` → DEFAULT 200000/64000。第一方 1M/128000 三处一致（anthropic、
  // google-vertex claude-opus-4-6@default、bedrock anthropic.claude-opus-4-6-v1）；
  // antigravity 正是 vertex 中转（上游 400 报文里 req_vrtx 佐证）。
  "claude-opus-4.6-thinking": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4-6-thinking": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-4.6": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-4-6": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-5": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  // sonnet-5-5 注册到 claude registry（翻译器归一化另行处理）；精确键与
  // `*claude*sonnet-5*` pattern 同值，锁死解析结果不受 pattern 顺序调整影响。
  "claude-sonnet-5-5": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-5-thinking": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-5-agentic": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-5-thinking-agentic": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  // Haiku 5.5 与 Opus 5.x / Sonnet 5.x 同为 1M/128000 adaptive 第一方规格
  // （models.dev anthropic/claude-haiku-5-5）。必须落到本键而不是下方
  // `*claude*haiku*` 的 claude-budget 200K/64K——见上一条 sonnet-5 的说明。
  "claude-haiku-5-5": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },

  // Gemini image-gen / OpenAI image / xai image variants
  "gpt-image-1":       { imageOutput: true, tools: false },

  // GLM vision variant (text GLM has no vision)
  "glm-4.6v":          { vision: true, reasoning: true, thinkingFormat: "zai", contextWindow: 128000 },
  "GLM-4.6V-Flash":    { vision: true, reasoning: true, thinkingFormat: "zai", contextWindow: 200000 },
  "glm-5.3-flash":     { vision: true, videoInput: true, pdf: true, reasoning: true, thinkingFormat: "zai", contextWindow: 1000000, maxOutput: 131072 },
  // x 变体与基础版同规格（models.dev zai 与 zhipuai 两条都报 text+image+video+pdf、
  // 1M/131072）。不加这行会落到 `*glm-5*` 兜底：200K 窗口、无多模态。
  "glm-5.3-flashx":    { vision: true, videoInput: true, pdf: true, reasoning: true, thinkingFormat: "zai", contextWindow: 1000000, maxOutput: 131072 },

  // Qwen plain coder/text (no vision) — registry "vision-model" / "coder-model" aliases
  "vision-model":      { vision: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000 },
  "coder-model":       { reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000 },

  // opencode-go 公开目录里这批 id 都是「模型自己的名字」（换一家转售商也是同一个
  // 模型），所以写 canonical 而不是 provider 行。通配 `*glm-5*` / `*qwen*max*` /
  // `*qwen*` / `*mimo*` / `hy3*` / `*grok-4.5*` / `*gpt-5*` 都是跨供应商共享的兜底，
  // 改它们会波及别人，因此只加精确行。来源都是第一方 models.dev 条目；与转售商冲突时
  // 取第一方。
  "glm-5.3":        { reasoning: true, thinkingFormat: "zai", contextWindow: 1000000, maxOutput: 131072 }, // zai + zhipuai 一致；`*glm-5*` 给的 200000/128000 是 GLM-4.x 时代的旧值
  "glm-5.2":        { reasoning: true, thinkingFormat: "zai", contextWindow: 1000000, maxOutput: 131072 }, // zhipuai：窗口 1M
  "glm-5.1":        { reasoning: true, thinkingFormat: "zai", contextWindow: 200000, maxOutput: 131072 }, // zhipuai：窗口与兜底同值，只有输出上限要改
  "glm-5":          { reasoning: true, thinkingFormat: "zai", contextWindow: 204800, maxOutput: 131072 }, // zai + zhipuai（models.dev 已标 deprecated）
  "qwen3.8-max":    { vision: true, videoInput: true, pdf: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 131072 }, // alibaba：text+image+video+pdf
  "qwen3.8-flash":  { vision: true, videoInput: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 131072 }, // alibaba：text+image+video
  "mimo-v2-pro":    { contextWindow: 1048576, maxOutput: 131072 }, // xiaomi：纯文本；`*mimo*` 既误标 vision 又把窗口写成 262144
  "mimo-v2.5-pro":  { contextWindow: 1048576, maxOutput: 131072 }, // xiaomi：纯文本；`*mimo*v2.5*` 误标 vision+audioInput+videoInput（同族非 pro 才是多模态）
  // V2.6（mimo.mi.com 模型列表，页面更新 2026-09-21）：pro 与 flash **都**标「全模态理解」
  // ——与纯文本的 v2.5-pro 不同；窗口 1M、最大输出 128K。必须显式列出：两者都不匹配
  // `*mimo*v2.5*`，只会落到最泛的 `*mimo*`，那条兜底把窗口写成 262144 且只给 vision，
  // headroom/上下文压缩就会按真实窗口的 1/4 计算。未标 pdf：官方只列图片/音频/视频理解。
  // 也**未**标 reasoning：上游用非标准的 `thinking:{type:"enabled"|"disabled"}`（文档明说
  // 「不是标准 OpenAI 参数」），本仓库没有 thinkingFormat 能发出这个形状，而 `"openai"` 会发
  // `reasoning_effort`——小米文档未收录，贸然发送有 400 风险。深度思考上游默认开启，故当前
  // 表现为「有思考、无档位控制」；要补档位需新增 mimo 专用 thinkingFormat（见提交说明）。
  "mimo-v2.6-pro":   { vision: true, audioInput: true, videoInput: true, contextWindow: 1048576, maxOutput: 131072 },
  "mimo-v2.6-flash": { vision: true, audioInput: true, videoInput: true, contextWindow: 1048576, maxOutput: 131072 },
  // OpenCode zen 免费档的 v2.6 flash（官方 /zen/v1/models 2026-09-30 在列）：
  // 与付费 mimo-v2.6-flash 同一族全模态规格；不显式声明会落 *mimo* 兜底被压成
  // vision-only / 262144 窗口。
  "mimo-v2.6-flash-free": { vision: true, audioInput: true, videoInput: true, contextWindow: 1048576, maxOutput: 131072 },
  // UltraSpeed 是 pro 的加速档，模态/窗口相同；显式列出，否则同样只落到 `*mimo*` 兜底。
  "mimo-v2.6-pro-ultraspeed": { vision: true, audioInput: true, videoInput: true, contextWindow: 1048576, maxOutput: 131072 },
  // Token Plan 的 Claude 原生变体：upstreamModelId 就是 mimo-v2.6-pro，能力相同。必须显式
  // 列出，否则 id 里的 "claude" 会命中 `*claude*` 兜底（200K/64K），headroom 按真实窗口 1/5 计。
  "mimo-v2.6-pro-claude": { vision: true, audioInput: true, videoInput: true, contextWindow: 1048576, maxOutput: 131072 },
  "mimo-v2-omni":   { vision: true, audioInput: true, videoInput: true, pdf: true, contextWindow: 262144, maxOutput: 131072 }, // xiaomi：text+image+audio+video+pdf
  "hy3":            { reasoning: true, thinkingFormat: "hunyuan", contextWindow: 256000, maxOutput: 128000 }, // tencent-tokenhub；`hy3*` 的 262144/262144（输出=窗口）无来源
  "hy3-preview":    { reasoning: true, thinkingFormat: "hunyuan", contextWindow: 256000, maxOutput: 64000 }, // tencent-tokenhub：预览版输出（64000）比正式版（128000）更小
  // StepFun 第一方（platform.stepfun.com，2026-09 文档）：兜底模式 `*step-*` 是 128K 旧值；
  // 这里按官方页标注修正窗口并补视觉/视频输入。maxOutput 官方未给确定值（step-5-preview
  // 明说 max_tokens 默认不限）→ 省略，走 DEFAULT 兜底。转售行（tokenrouter/commandcode 的
  // stepfun/step-*）经 baseModel 同键命中，取第一方与旧惯例一致。
  "step-5-preview":     { vision: true, videoInput: true, reasoning: true, thinkingFormat: "step", contextWindow: 1000000 },
  "step-3.7-flash":     { vision: true, videoInput: true, reasoning: true, thinkingFormat: "step", contextWindow: 256000 },
  "step-3.5-flash":     { reasoning: true, thinkingFormat: "step", contextWindow: 256000 }, // 仅文本（官方：不支持图片输入）
  "step-3.5-flash-2603": { reasoning: true, thinkingFormat: "step", contextWindow: 256000 },
  "step-1o-turbo-vision": { vision: true, contextWindow: 32000 },
  "step-router-v1":     { reasoning: true, thinkingFormat: "step", contextWindow: 256000 }, // Step Plan 专属智能路由模型；官方未标注窗口，与 step-3.x 同档（否则 `*step-*` 兜底给 128K）
  "grok-4.5":       { vision: true, pdf: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 500000, maxOutput: 500000 }, // xai：输出上限等于窗口，与 `*grok-4.6*` 同值
  "grok-4.6":       { vision: true, pdf: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 500000, maxOutput: 500000 }, // xai：与 `*grok-4.6*` 同值，仅补 pdf
  "grok-4.7":       { vision: true, pdf: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 500000, maxOutput: 500000 }, // xai 第一方（2026-09-26）：与 grok-4.6 同规格（500000/500000，text+image+pdf）；opencode-go 端点表将其列入 /responses
  "gpt-5.6-luna":   { vision: true, pdf: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 1050000, maxOutput: 128000 }, // openai（第一方）；`*gpt-5*` 给的 400000 是 codex 系列的保守值
  "gpt-6-luna":     { vision: true, pdf: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 1050000, maxOutput: 128000 }, // openai（2026-09-26）：与 gpt-5.6-luna 同规格（azure/aihubmix/opencode-go 条目一致，1050000/128000，text+image+pdf）
  "kimi-k2.6":      { vision: true, videoInput: true, reasoning: true, thinkingFormat: "kimi", contextWindow: 262144, maxOutput: 262144 }, // moonshotai：与 `*kimi*k2*` 同值，仅补 videoInput

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
  // 横杠形态别名：部分转售商以 `deepseek-v4-1-flash`（点号换成横杠）暴露同一模型；
  // 裸配会落 `*deepseek-v4*` 通配（vision:false），图片在 modality 层被静默剥掉。
  "deepseek-v4-1-flash": { vision: true, reasoning: true, thinkingFormat: "deepseek", contextWindow: 1000000, maxOutput: 384000 },

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
  "muse-spark-1.3":            { vision: true, videoInput: true, pdf: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1048576, maxOutput: 131072 }, // meta/muse-spark-1.3（付费档，opencode-zen /zen/v1 在列）
  "muse-spark-1.2-contributor":{ vision: true, videoInput: true, pdf: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1048576, maxOutput: 131072 }, // meta/muse-spark-1.2-contributor
  "muse-spark-1.3-contributor":{ vision: true, videoInput: true, pdf: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1048576, maxOutput: 131072 }, // meta/muse-spark-1.3-contributor（第一方）；与 -1.2-contributor 同值（另有 -free 变体行）
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
  // LongCat-2.5-Preview（2026-09-25 上线，第一方）：快速开始限流规则 1M/128K；
  // 视觉理解文档确认图片（image_url 块）+ 视频（video_url 块）输入；chat 文档
  // 确认 thinking {type:enabled|disabled} 开关与 reasoning_content 响应。
  "LongCat-2.5-Preview":        { vision: true, videoInput: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 131072 },
  // opencode-go 的目录用小写 longcat-2.0，而 canonical 查表区分大小写 → 必须单独一行
  // （同值，来源同上；models.dev 的 opencode-go 条目 1000000/131072 与第一方一致）。
  "longcat-2.0":                { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 131072 }, // 同上，小写 id
  // LongCat 2.5 Preview 免费档（2026-09-26）：models.dev 的 opencode-go/opencode 条目
  // 一致报 text+image、1M/131072 —— 比 2.0 多了图像输入。
  "longcat-2.5-preview-free":   { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 131072 },
  // opencode-go 的免费 id：models.dev（opencode-go/opencode 两处条目一致）报
  // text+image+video、1048576 窗口、输入/输出各 524288。名字读不出多模态，
  // 必须显式声明，否则 vision 落 false 图片被剥。
  "space-bunny-free":           { vision: true, videoInput: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1048576, maxOutput: 524288 },
  // 付费版 Space-Bunny（opencode-go 目录；models.dev opencode-go 1048576/524288，
  // text+image+video 进）。codebuddy-cn 的同名条目在 provider 层优先，不受影响。
  "space-bunny":               { vision: true, videoInput: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1048576, maxOutput: 524288 },
  // MiniMax Code（CreditDaddy MiniMax 线实测 + 官方客户端设置面板 2026-10-03）：
  //   - M3.1-Flash-Preview：思考深度五档（default/low/medium/high/xhigh/max，
  //     无 off → canDisable:false），thinking.effort 由 minimax 形态透传；
  //   - M3：思考是开/关切换（客户端有「思考」开关、无档位）→ canDisable:true,
  //     显式成行修正 *minimax-m3* pattern 的 canDisable:false（该行写于 M3 无
  //     开关的旧认知）；上下文 512K/1M 两档是 MiniMax 侧的用量分档（1M 用量
  //     较高），能力表按上限声明。
  "MiniMax-M3.1-Flash-Preview": { vision: true, videoInput: true, reasoning: true, thinkingFormat: "minimax", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 512000 },
  "MiniMax-M3":                 { vision: true, videoInput: true, reasoning: true, thinkingFormat: "minimax", thinkingCanDisable: true, contextWindow: 1000000, maxOutput: 131072 },
  // Fledge Alpha Free（opencode zen 目录；models.dev opencode 条目 2026-10-02）：
  // text+image 进、1M/131072、reasoning/tool_call 均 true——与 space-bunny-free
  // 同形（openai 转发，thinkingFormat: openai）。
  "fledge-alpha-free":          { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1048576, maxOutput: 131072 },
  // Exo Free（opencode zen 目录；models.dev opencode 条目）：与 fledge-alpha-free
  // 同形——text+image 进、1M/131072、reasoning/tool_call 均 true。
  "exo-free":                   { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1048576, maxOutput: 131072 },
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
// [1m] 长上下文变体（上游 9f41ee75）：同一上游模型，窗口放宽到 872k。
const CODEX_EXTENDED_CAPS = { ...CODEX_GPT_56_DEFAULT_CAPS, contextWindow: 872000 };

// Devin CLI 的 registry 给这批 GPT 档位模型标了 200k 窗口（registry/devin-cli.js）。
// provider 行是短路语义（不与 pattern 合并），所以 GPT 的特性/输出字段要带全，
// 否则回落到 `*gpt-5*` 通配时 vision/search 字段会丢（上游 89ffac5a）。
const DEVIN_CLI_GPT_CAPS = { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 128000 };

// Qoder 的客户端还可以按 registry 的显示名寻址（如 "qoder/Qwen3.8-Max"）。没有
// 别名时这些名字会绕过 provider 行，落进通用族 pattern（*qwen*max* 等）或地板，
// 拿到的是「思考可关」的通用语义——与 qoder 执行器丢弃客户端 thinking 意图、
// 上游 modelConfig 固定的事实冲突。
//
// aliased(map, aliasOf)：map 是 literal 单行真源（内部 id → 能力）；aliasOf 是
// 显示名 → 内部 id。返回真源 + 程序化派生的别名列（别名与真源指向同一对象，改
// 真源即同步全部别名）。
function aliased(map, aliasOf) {
  const out = { ...map };
  for (const [alias, id] of Object.entries(aliasOf)) out[alias] = map[id];
  return out;
}

// Qoder INTL 与 CN 共有的显示名 → 内部 id（以两份 registry 的 `name` 字段为准逐
// 个核对）。CN 另多 Qwen3.7-Flash / GLM-5.2 两款，见 QODER_CN_NAME_ALIASES。
const QODER_NAME_ALIASES = {
  "Qwen3.8-Max": "qmodel_38max",
  "Qwen3.7-Max": "qmodel_latest",
  "Qwen3.7-Plus": "qmodel",
  "Qwen3.8-Flash": "qfmodel",
  "Kimi-K3": "kmodel_latest",
  "Kimi-K2.7-Code": "kmodel",
  "GLM-5.3": "gmodel",
  "GLM-5.3-Flash": "gfmodel",
  "DeepSeek-V4-Pro": "dmodel",
  "DeepSeek-V4-Flash": "dfmodel",
  "MiniMax-M3": "mmodel",
};
const QODER_CN_NAME_ALIASES = {
  ...QODER_NAME_ALIASES,
  "Qwen3.7-Flash": "q37fmodel",
  "GLM-5.2": "gm51model",
};

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
  // reasoning via reasoning_effort only (native `thinking` field → 400). Every
  // value below is from AMD's own per-model pages (「本端点上的行为」, 实测，
  // 2026-09-09 修订) cross-checked against GET /v1/models; the two vision rows
  // were additionally re-verified live (prompt_tokens_details.image_tokens > 0).
  //   · DeepSeek-V4-Flash / -Vision-Exp — 1M ctx; thinking OFF unless asked;
  //     reasoning_effort takes none|minimal|low|medium|high|xhigh|max.
  //   · Qwen3.8-Flash-Next — 256K ctx, takes images, thinking ON by default and
  //     switchable off via `none` (accepts none|low|medium|xhigh).
  //   · MiniCPM5-2B — 128K ctx, text-only, returns no separate reasoning at all.
  // The id casing is upstream's (TitleCase); canonical/pattern tables are
  // case-sensitive, so the Vision-Exp row is what keeps this from falling to the
  // lowercase `*deepseek-v4*` pattern and silently stripping images.
  // maxOutput: upstream publishes no output cap (max_tokens counts the total
  // prompt+output budget) — values here are conservative UI hints, not wire limits.
  "amd": {
    "DeepSeek-V4-Flash":            { reasoning: true, thinkingFormat: "openai", contextWindow: 1048576, maxOutput: 65536 },
    "DeepSeek-V4-Flash-Vision-Exp": { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1048576, maxOutput: 65536 },
    "Qwen3.8-Flash-Next":           { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true, contextWindow: 262144, maxOutput: 32768 },
    "MiniCPM5-2B":                 { reasoning: false, contextWindow: 131072, maxOutput: 32768 },
  },
  // Atria Dawn 研究预览：单一文本模型，上游用 hook 直接拒绝图片/PDF 输入。
  // 无公开的上下文规格 —— 走显式默认行，避免落进 floor。
  "atria": {
    "Atria-Dawn-Preview": { vision: false, reasoning: false },
  },
  // Token Harbor 原样转发请求，思考格式由各模型经 capabilities 解析。
  // 显式行只列 pattern 兜底会明显低报的 id（其余种子 id 命中各自家族 pattern）。
  // `:free` 后缀使 exact/canonical 键全部失配，落到泛化 pattern 就是旧窗口 +
  // 丢模态——免费档三件套各占一行，模态/窗口取官网 Models 页（2026-10-02）与
  // 各自 canonical 同族行同值。
  "tokenharbor": {
    "deepseek-v4.1-flash:free": { vision: true, reasoning: true, thinkingFormat: "deepseek", contextWindow: 1000000, maxOutput: 384000 },
    "qwen3.8-flash:free":       { vision: true, videoInput: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 131072 },
    // MiMo V2.6 全模态（text+image+audio+video）且与 canonical mimo-v2.6 系一致地
    // 不声明 reasoning（上游用非标准 thinking 字段，无法安全发档位）。
    "mimo-v2.6-flash:free":     { vision: true, audioInput: true, videoInput: true, contextWindow: 1048576, maxOutput: 131072 },
    // tokenharbor 的 Haiku 5.5 id 为点号写法(claude-haiku-5.5:free),不命中全局 claude-haiku-5-5 键,
    // 会落进 *claude*haiku* 兜底拿到 200K/claude-budget,导致 combo 被 min 拉成 200K。此处精确锁定 1M/adaptive。
    "claude-haiku-5.5:free":    { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  },
  "codex": {
    "gpt-6-astra":               { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 272000, maxOutput: 128000 },
    // codex OAuth 后端把 gpt-6 家族截到 272k（不同于 OpenAI API 的 1.05M 窗口，
    // 后者由 `*gpt-6*` pattern 承担），所以 Sol/Luna 必须显式列出（上游 92c7bdd5）。
    "gpt-6-sol":                 { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 272000, maxOutput: 128000 },
    "gpt-6-luna":                { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 272000, maxOutput: 128000 },
    "gpt-6-astra[1m]":           CODEX_EXTENDED_CAPS,
    "gpt-6-sol[1m]":             CODEX_EXTENDED_CAPS,
    "gpt-6-luna[1m]":            CODEX_EXTENDED_CAPS,
    "gpt-5.6-sol[1m]":           CODEX_EXTENDED_CAPS,
    "gpt-5.6-terra[1m]":         CODEX_EXTENDED_CAPS,
    "gpt-5.6-luna[1m]":          CODEX_EXTENDED_CAPS,
    "gpt-5.6-sol":               CODEX_GPT_56_SOL_CAPS,
    "gpt-5.6-sol-review":        CODEX_GPT_56_SOL_CAPS,
    "gpt-5.6-terra":             CODEX_GPT_56_DEFAULT_CAPS,
    "gpt-5.6-terra-review":      CODEX_GPT_56_DEFAULT_CAPS,
    "gpt-5.6-luna":              CODEX_GPT_56_DEFAULT_CAPS,
    "gpt-5.6-luna-review":       CODEX_GPT_56_DEFAULT_CAPS,
    // daybreak-blue / reserve：codex 模型目录确认在线，规格未公开——按 codex 家族保守值声明，
    // 避免静默落到 DEFAULT_CAPABILITIES 地板（capability-floor 审计以此为准）。
    "gpt-daybreak-blue-latest":  CODEX_GPT_56_DEFAULT_CAPS,
    "gpt-reserve":               CODEX_GPT_56_DEFAULT_CAPS,
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
  // Devin CLI 把 GPT 5.4/5.5 档位截到 200k（registry/devin-cli.js 的
  // contextLength=200000，上游 89ffac5a）。provider 行短路优先于 `*gpt-5.4*`
  // 等新窗口 pattern（1.05M），避免出现「发布窗口比实际大 5 倍」的卡片。
  "devin-cli": {
    "gpt-5.4-high": DEVIN_CLI_GPT_CAPS,
    "gpt-5.4-medium": DEVIN_CLI_GPT_CAPS,
    "gpt-5.4-low": DEVIN_CLI_GPT_CAPS,
    "gpt-5.5-xhigh": DEVIN_CLI_GPT_CAPS,
    "gpt-5.5-high": DEVIN_CLI_GPT_CAPS,
    "gpt-5.5-medium": DEVIN_CLI_GPT_CAPS,
    "gpt-5.5-low": DEVIN_CLI_GPT_CAPS,
  },
  // APInex — ids are BARE (the 2026-09 vendor-prefix scheme was dropped
  // upstream); the free/* tier keeps its slash prefix. thinkingFormat stays
  // "openai" for the whole gateway (it forwards reasoning_effort verbatim —
  // historical live-proven shape, d603aa89). Catalog refreshed 2026-10-02.
  "apinex": {
    "claude-fable-5.1":            { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 128000 },
    "claude-opus-5":               { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 128000 },
    "claude-opus-5.5":             { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 128000 },
    "claude-sonnet-5":             { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 128000 },
    "claude-sonnet-5.5":           { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 128000 },
    "deepseek-v4-flash":           { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 65536 },
    "deepseek-v4-pro":             { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 65536 },
    "deepseek-v4.1-flash":         { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 128000 },
    "gemini-3.1-pro":              { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 128000 },
    "gemini-3.8-flash":            { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 128000 },
    "glm-5.3":                     { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 128000 },
    "glm-5.3-flash":               { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 128000 },
    "gpt-5.6-terra":               { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 128000 },
    "gpt-6-astra":                 { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 128000 },
    "gpt-6-luna":                  { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1050000, maxOutput: 128000 },
    "gpt-6.1-sol":                 { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 128000 },
    "grok-4.7":                    { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 500000, maxOutput: 128000 },
    "kimi-k3":                     { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 65536 },
    "free/claude-opus-4.6":        { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 128000 },
    "free/claude-sonnet-4.6":      { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 128000 },
    "free/deepseek-v4-flash-0731": { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 65536 },
    "free/deepseek-v4-pro-0813":   { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 65536 },
    "free/deepseek-v4.1-flash":    { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 128000 },
    "free/gemini-3.1-pro":         { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 128000 },
    "free/gemini-3.8-flash":       { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 128000 },
    "free/glm-5.3-flash":          { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 128000 },
    "free/gpt-6-luna":             { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1050000, maxOutput: 128000 },
    "free/hy4":                    { reasoning: true, thinkingFormat: "openai", contextWindow: 256000, maxOutput: 65536 },
    "free/kimi-k2.8":              { reasoning: true, thinkingFormat: "openai", contextWindow: 256000, maxOutput: 65536 },
    "free/kimi-k3":                { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 65536 },
    "free/mimo-v2.6-flash":        { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 65536 },
    "free/mimo-v2.6-pro":          { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 65536 },
    "free/minimax-m3":             { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 512000 },
    "free/minimax-m3.1":           { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 512000 },
    "free/muse-spark-1.3":         { reasoning: true, thinkingFormat: "openai", contextWindow: 256000, maxOutput: 65536 },
    "free/qwen-3.8-max":           { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 65536 },
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
    // K2.8 预览版：models.dev 尚无条目，形态暂取 k2.7 同档（256000/32000 同 hy3、
    // glm-5.3-flashx 的既有做法），等 CN 网关 product-config 的 maxOutputTokens 回来校准。
    "kimi-k2.8-preview":  { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 256000, maxOutput: 32000 },
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
    // Space-Bunny（官方应用 2026-10-02 上架）：原生多模态输入 → vision:true；
    // 思考"极致"档与 Hy 系同族（强制常开，canDisable:false 待服务端
    // product-config 回来后校准）；1M 输入，输出上限暂取 Hy 同档 64000。
    "space-bunny":        { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 64000 },
    "glm-5.3":            { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true, contextWindow: 1000000, maxOutput: 48000 },
    "glm-5.3-flash":      { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true, contextWindow: 1000000, maxOutput: 32000 },
    // x 变体同基础版形态；32000 是暂取（同 hy3「输出上限暂取同档」的既有做法）——
    // CN 网关的 product-config 需要鉴权取不到，等它回来再校准。
    "glm-5.3-flashx":     { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true, contextWindow: 1000000, maxOutput: 32000 },
    "kimi-k3":            { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 32000 },
    // DeepSeek-V4-Pro：纯文本（模型卡 text→text；models.dev 124 条命中一致报
    // attach:false，火山方舟第一方 deepseek-v4-pro-ga-260813 亦然）。1M 输入 /
    // 384K 输出。此前误标 vision:true 会让图片绕过 modality 剥离直接打到上游，
    // 而 50000 是改名前的旧值，会把 max_tokens 夹小 7 倍（claude.js adjustMaxTokens）。
    "deepseek-v4-pro":    { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true, contextWindow: 1000000, maxOutput: 384000 },
    // DeepSeek-V4.1-Flash：1M 输入 / 128K 输出，文本+图像进，思考默认开但可关
    // （模型卡：思考水平 High 默认，另有常规模式 / Low / Max）。输出上限取
    // **服务端 product-config 的 maxOutputTokens=128000**，而不是模型卡的 384K：
    // 这条通道的实际合同是 CN 网关公布的配额，与同段 glm-5.3 48000 /
    // minimax-m3 128000 的取法一致。给 384000 会让 claude.js adjustMaxTokens
    // 不夹取，把超过服务端上限的 max_tokens 原样放行（canonical 行仍是 384K，
    // 供直连第一方/别家转售的 id 使用）。
    // 模型卡把 deepseek-flash / deepseek-v4-flash 列为“别名”：deepseek-flash 正是
    // V4.1-Flash 的官方 id（第一方 2026-09-10 起），canonical 行在
    // MODEL_CAPABILITIES；裸的 deepseek-v4-flash 在转售商端仍是纯文本，落到通配
    // 即可，本表不留行。deepseek-v4-flash-vision-exp 是另一个多模态 id，走
    // MODEL_CAPABILITIES 的 canonical 行（四家共用：commandcode / deepseek /
    // opencode-go / B.AI，写这里只覆盖 CN 一家）。
    // 下面这行同样是 CAN 侧的 provider 行覆盖：canonical 行已给出同一套数值，这里是
    // 因为 CN 网关走 openai 思考格式且允许关闭思考（provider 行优先于 canonical）。
    "deepseek-v4.1-flash": { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true, contextWindow: 1000000, maxOutput: 128000 },
  },
  // codebuddy-intl 只在 canonical 行与 CN 行都不适用时才需要条目。Space-Bunny 就是
  // 这种情况：canonical 行写的是 opencode 那份部署（1M/524288），CodeBuddy 自家
  // 的服务是 1M/64000（同 codebuddy-cn 行），差 8 倍，输出夹子不能共用。
  //
  // ⚠️ 本块目前只有 1 行，其余 intl 模型都落到 canonical / 通配行，而那些行是按
  // 各家第一方部署写的：intl 的 glm-5.2 因此报 vision:false / 200000 / 131072，
  // CN 的同一模型是 vision:true / 1M / 48000。thinkingFormat 不受影响——registry
  // transport 与 PROVIDERS 两处都写死 openai，而 resolveFormat 让 provider 覆盖
  // 优先于 capability（translator/concerns/thinkingUnified.js:130），所以那些
  // 落到 canonical 的 zai/kimi 是死值。
  // 现状是有意为之（用户决定 2026-10-09）：不要拿 CN 那张表镜像过来补全。
  // maxOutput 是真夹子（claude.js adjustMaxTokens），照抄另一条通道的数只会把
  // 夹子挪到一个没有依据的位置；真要补得先拿到 intl 自己的 product-config
  // （与 CN 同形的 maxInputTokens/maxOutputTokens/supportsImages 表），而
  // 2026-10-09 扫过 /v2/{plugin,chat,billing}/{model,config,list} 等 10 个候选
  // 路径，CN 与 intl 两边都是 404。
  // 网关侧的路由 id `auto` 也刻意不给行：它五个 prompt 全落在 glm-5.2，但落点
  // 会变，没有稳定的能力声明可写（详见 registry/codebuddy-intl.js 的说明）。
  "codebuddy-intl": {
    "space-bunny": { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 64000 },
    // kimi-k2.8-preview 是**两线同款**(同 id、同 0.77x、一套积分系统),故与 CN
    // 侧同值,不落进 *kimi*k2* 的 262144/262144——那个 pattern 的 maxOutput 等于
    // contextWindow,是泛化的 K2 时代值,对 2.8 预览版同样没依据,而 maxOutput 是
    // 真夹子:多报就会让超限的 max_tokens 直接穿过去被上游拒。
    // 与「不镜像国内能力表」不冲突:那条针对的是**只在单边存在**的模型,这里是
    // 同一款模型,理应同参。两侧数值都是 k2.7 同档占位(见 CN 注释),待
    // product-config 的 maxOutputTokens 回来一并校准。
    "kimi-k2.8-preview": { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 256000, maxOutput: 32000 },
  },
  // Qoder — upstream exposes opaque internal ids (dfmodel, kmodel, …);
  // capability lookup matches on the raw id, while clients may also address
  // models by the registry `name` (display name) — those aliases are derived
  // programmatically by aliased() so every qoder model stays out of
  // DEFAULT_CAPABILITIES (200K) and the generic family patterns either way.
  // contextWindow follows the real model family's
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
  "qoder": aliased({
    "auto":           { vision: true, reasoning: true, thinkingFormat: "claude-adaptive", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 128000 }, // 虚拟档：家族随上游路由漂移，给保守超集
    "ultimate":       { vision: true, reasoning: true, thinkingFormat: "claude-adaptive", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 128000 }, // Claude Opus 5
    "performance":    { vision: true, reasoning: true, thinkingFormat: "claude-adaptive", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 128000 }, // Claude Sonnet 5
    "efficient":      { vision: true, reasoning: true, thinkingFormat: "claude-adaptive", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 128000 }, // 虚拟档：家族随上游路由漂移，给保守超集
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
  }, { ...QODER_NAME_ALIASES, "Auto": "auto", "Ultimate": "ultimate", "Performance": "performance", "Efficient": "efficient" }),
  "qoder-cn": aliased({
    // 虚拟档：家族随上游路由漂移，给保守超集（与 INTL 侧的 auto/efficient 同形状）。
    "auto":           { vision: true, reasoning: true, thinkingFormat: "claude-adaptive", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 128000 }, // 虚拟档：家族随上游路由漂移，给保守超集
    "dmodel":         { reasoning: true, thinkingFormat: "deepseek", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 65536 },  // DeepSeek-V4-Pro
    "dfmodel":        { reasoning: true, thinkingFormat: "deepseek", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 65536 },  // DeepSeek-V4-Flash
    "gmodel":         { reasoning: true, thinkingFormat: "zai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 128000 },      // GLM-5.3
    "gfmodel":        { vision: true, reasoning: true, thinkingFormat: "zai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 128000 }, // GLM-5.3-Flash
    "gm51model":      { reasoning: true, thinkingFormat: "zai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 48000 },       // GLM-5.2
    "kmodel_latest":  { vision: true, reasoning: true, thinkingFormat: "kimi", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 65536 },      // Kimi-K3
    "kmodel":         { vision: true, reasoning: true, thinkingFormat: "kimi", thinkingCanDisable: false, contextWindow: 256000, maxOutput: 65536 },  // Kimi-K2.7-Code
    "mmodel":         { reasoning: true, thinkingFormat: "minimax", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 512000 }, // MiniMax-M3
    "qmodel_latest":  { vision: true, reasoning: true, thinkingFormat: "qwen", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 65536 },  // Qwen3.7-Max
    "qmodel":         { vision: true, reasoning: true, thinkingFormat: "qwen", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 65536 },  // Qwen3.7-Plus
    "q37fmodel":      { vision: true, reasoning: true, thinkingFormat: "qwen", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 65536 },  // Qwen3.7-Flash
    "qfmodel":        { vision: true, reasoning: true, thinkingFormat: "qwen", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 65536 },  // Qwen3.8-Flash
    "qmodel_38max":   { vision: true, reasoning: true, thinkingFormat: "qwen", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 65536 },      // Qwen3.8-Max
  }, { ...QODER_CN_NAME_ALIASES, "Auto": "auto" }),
  // Poolside Laguna — OpenAI-compatible, all reasoning-capable (32K max output).
  "poolside": {
    "laguna-s-2.1":  { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 32000 },
    "laguna-xs-2.1": { reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 32000 },
  },
};

// 传输/UI 别名与 provider id 共享同一张表（上游 89ffac5a）：combo 座位、gpt-6
// 通道路径等按 alias（cx / dv / devin）查能力时，必须命中与 id 相同的截断行，
// 否则同一模型换个拼写就回落到 pattern 拿到 5 倍大的窗口。
PROVIDER_CAPABILITIES.cx = PROVIDER_CAPABILITIES.codex;
PROVIDER_CAPABILITIES.dv = PROVIDER_CAPABILITIES["devin-cli"];
PROVIDER_CAPABILITIES.devin = PROVIDER_CAPABILITIES["devin-cli"];
PROVIDER_CAPABILITIES.kr = PROVIDER_CAPABILITIES.kiro;
PROVIDER_CAPABILITIES.ag = PROVIDER_CAPABILITIES.antigravity;
PROVIDER_CAPABILITIES.cbcn = PROVIDER_CAPABILITIES["codebuddy-cn"];
PROVIDER_CAPABILITIES.cbai = PROVIDER_CAPABILITIES["codebuddy-intl"];
// tokenharbor / poolside / atria 的传输别名：th、thh、ps、atria-asi。落空时
// th/claude-haiku-5.5:free 这类 provider 钉住的行取不到，会经 MODEL →
// PATTERN 拿到 claude-budget 的 thinking 形状和 200k/64k（应为 1M/128k +
// claude-adaptive），combo 的 min() 再把整组压到 200k。
PROVIDER_CAPABILITIES.th = PROVIDER_CAPABILITIES.tokenharbor;
PROVIDER_CAPABILITIES.thh = PROVIDER_CAPABILITIES.tokenharbor;
PROVIDER_CAPABILITIES.ps = PROVIDER_CAPABILITIES.poolside;
PROVIDER_CAPABILITIES["atria-asi"] = PROVIDER_CAPABILITIES.atria;
// Qoder 的传输/UI 别名（qd = INTL，qdc = CN）与上面同理：/api/models 的
// AI_MODELS 用 PROVIDER_MODELS 的 key（即 alias）拼 provider，若不在此归一化，
// 同一模型换个拼写就回落到 DEFAULT 200k（vision/reasoning 被剥、窗口砍到 1/5）。
PROVIDER_CAPABILITIES.qd = PROVIDER_CAPABILITIES.qoder;
PROVIDER_CAPABILITIES.qdc = PROVIDER_CAPABILITIES["qoder-cn"];

/**
 * Pattern fallback — glob (* = wildcard), matched case-insensitively and
 * anchored (^...$) so a pattern must match the full model id. ORDER MATTERS:
 * vision/specific variants first, text-only/generic families last, to avoid
 * a broad family pattern swallowing an exception (e.g. glm-4.6v vs glm-5).
 */
export const PATTERN_CAPABILITIES = [
  // ── Claude (4.6+ / Sonnet 5.x = adaptive thinking; older/haiku = budget) ──
  { pattern: "*claude*opus-5*",     caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 } },
  // 未知 Sonnet 5.x id（如 5.5）必须落在本行而不是下方泛化的 `*claude*sonnet*`：
  // 落后者会走 claude-budget，翻译层为 tool_use 轮伪造带签名 thinking 占位，
  // Sonnet 5.x 只认 adaptive，实测大上下文直接 refusal。
  { pattern: "*claude*sonnet-5*",   caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 } },
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
  // pdf:true 按第一方数据补声明（models.dev google/google-vertex：Gemini 2.5 与 3.x
  // Flash/Pro 全系 input 含 pdf）。透传层本就放行（未声明 ≠ false，modality 只剥显式
  // false），这里补的是能力徽章的准确性——antigravity/gemini 的模型卡此前不显示 PDF。
  { pattern: "*gemini-3.8*",    caps: { vision: true, audioInput: true, videoInput: true, pdf: true, reasoning: true, search: true, thinkingFormat: "gemini-level", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 65536 } },
  { pattern: "*gemini-3.7*",    caps: { vision: true, audioInput: true, videoInput: true, pdf: true, reasoning: true, search: true, thinkingFormat: "gemini-level", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 65536 } },
  { pattern: "*gemini-3*pro*",  caps: { vision: true, audioInput: true, videoInput: true, pdf: true, reasoning: true, search: true, thinkingFormat: "gemini-level", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 65535 } },
  { pattern: "*gemini-3*",      caps: { vision: true, audioInput: true, videoInput: true, pdf: true, reasoning: true, search: true, thinkingFormat: "gemini-level", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 65536 } },
  { pattern: "*gemini-2.5*",    caps: { vision: true, audioInput: true, videoInput: true, pdf: true, reasoning: true, search: true, thinkingFormat: "gemini-budget", thinkingRange: { min: 0, max: 24576 }, contextWindow: 1048576, maxOutput: 65536 } },
  { pattern: "*gemini-2*",      caps: { vision: true, audioInput: true, videoInput: true, search: true, contextWindow: 1048576, maxOutput: 65536 } },
  { pattern: "*gemini*",        caps: { vision: true, search: true, contextWindow: 1048576 } },
  { pattern: "*gemma*",         caps: { vision: true, contextWindow: 128000 } },
  { pattern: "*nanobanana*",    caps: { vision: true, imageOutput: true } },

  // ── OpenAI GPT-6.x (vision + thinking + web search) ──────────────
  // 整个 gpt-6 家族（astra/luna/sol 同）的 API 窗口是 1.05M。截得更低的网关
  // 把自家数字写在 PROVIDER_CAPABILITIES（短路优先）——Kiro 272k、codex OAuth
  // 272k/372k。此前本 pattern 抄的是 Kiro 的 272k，导致其余 provider 的 gpt-6
  // 全部按真实窗口的 ~1/3.9 发布；canonical `gpt-6-luna`（1050000）与本行同口径。
  { pattern: "*gpt-6*",         caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 1050000, maxOutput: 128000 } },

  // ── OpenAI GPT-5.x (vision + thinking + web search) ──────────────
  { pattern: "*gpt-5*image*",   caps: { imageOutput: true } },
  { pattern: "*gpt-5*codex*",   caps: { reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 400000, maxOutput: 128000 } },
  // 1.05M 窗口从 gpt-5.4 起步，但 mini/nano 两档仍停在 400k——first match wins，
  // 所以这两个例外必须列在档位行之前（上游 89ffac5a）。
  { pattern: "*gpt-5.4-mini*",  caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 400000, maxOutput: 128000 } },
  { pattern: "*gpt-5.4-nano*",  caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 400000, maxOutput: 128000 } },
  { pattern: "*gpt-5.4*",       caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 1050000, maxOutput: 128000 } },
  { pattern: "*gpt-5.5*",       caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 1050000, maxOutput: 128000 } },
  { pattern: "*gpt-5.6*",       caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 1050000, maxOutput: 128000 } },
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
  { pattern: "*qwen*max*",      caps: { vision: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 65536 } },
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
  { pattern: "*minimax-m3*",    caps: { vision: true, reasoning: true, thinkingFormat: "minimax", contextWindow: 1000000, maxOutput: 131072 } },
  { pattern: "*minimax-m2.7*",  caps: { vision: true, reasoning: true, thinkingFormat: "minimax", thinkingCanDisable: false, contextWindow: 204800, maxOutput: 131072 } },
  { pattern: "*minimax-m2.5*",  caps: { vision: true, reasoning: true, thinkingFormat: "minimax", thinkingCanDisable: false, contextWindow: 204800, maxOutput: 131072 } },
  { pattern: "*minimax*",       caps: { reasoning: true, thinkingFormat: "minimax", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 131072 } },

  // ── Xiaomi MiMo (vision + <think>-tag reasoning, always-on for the v2.5
  // generation; the v2.6 rows above stay deliberate non-declarers) ─────────
  { pattern: "*mimo*preview*",  caps: { vision: true, audioInput: true, videoInput: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1048576, maxOutput: 131072 } },
  { pattern: "*mimo*v2.5*",     caps: { vision: true, audioInput: true, videoInput: true, reasoning: true, thinkingFormat: "deepseek", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 131072 } },
  { pattern: "*mimo*omni*",     caps: { vision: true, audioInput: true, reasoning: true, thinkingFormat: "deepseek", thinkingCanDisable: false, contextWindow: 262144, maxOutput: 131072 } },
  { pattern: "*mimo*",          caps: { vision: true, reasoning: true, thinkingFormat: "deepseek", thinkingCanDisable: false, contextWindow: 262144, maxOutput: 131072 } },

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
 * Aggregate capabilities for a combo from its constituent model IDs.
 * Each entry in comboModels is a fully-qualified "provider/model" string.
 *
 * Union:        vision, pdf, audioInput, videoInput, imageOutput, audioOutput, search
 * Intersection: tools
 * Primary:      reasoning fields from the first (primary) model
 * Conservative: contextWindow = min; maxOutput = max
 *
 * @param {string[]} comboModels
 * @param {Object|null} [comboLookup] optional map of combo name → models array for nested resolution
 * @param {Function|null} [resolveCaps] optional (fullId) → caps override. The synced model
 *   catalog is server-only (it reads a file), so a browser-side resolution cannot see the
 *   limits it supplies and silently falls back to the generic patterns below. Callers that
 *   have the server's answer (/api/models, via useModelCaps) pass it here; it is merged over
 *   the local tables, so fields it does not carry (tools, pdf, audio/video, thinking*) survive.
 * @param {number} [_depth] internal recursion depth guard
 * @returns {object|null} full capabilities object, or null for empty input
 */
export function aggregateComboCapabilities(comboModels, comboLookup = null, resolveCaps = null, _depth = 0) {
  if (!comboModels?.length || _depth > 6) return null;
  const allCaps = comboModels.map((fullId) => {
    // Nested combo: bare name (no slash) that exists in the lookup — recurse
    if (!fullId.includes("/") && comboLookup?.[fullId]) {
      return aggregateComboCapabilities(comboLookup[fullId], comboLookup, resolveCaps, _depth + 1)
          ?? resolveCaps?.(fullId)
          ?? getCapabilitiesForModel(null, fullId);
    }
    const slash = fullId.indexOf("/");
    const provider = slash === -1 ? null : fullId.slice(0, slash);
    const model = slash === -1 ? fullId : fullId.slice(slash + 1);
    const local = getCapabilitiesForModel(provider, model);
    const override = resolveCaps?.(fullId);
    return override ? { ...local, ...override } : local;
  });
  const first = allCaps[0];
  return {
    vision:      allCaps.some((c) => c.vision),
    pdf:         allCaps.some((c) => c.pdf),
    audioInput:  allCaps.some((c) => c.audioInput),
    videoInput:  allCaps.some((c) => c.videoInput),
    imageOutput: allCaps.some((c) => c.imageOutput),
    audioOutput: allCaps.some((c) => c.audioOutput),
    search:      allCaps.some((c) => c.search),
    tools:       allCaps.every((c) => c.tools),
    reasoning:          first.reasoning,
    thinkingFormat:     first.thinkingFormat,
    thinkingCanDisable: first.thinkingCanDisable,
    thinkingRange:      first.thinkingRange,
    contextWindow: Math.min(...allCaps.map((c) => c.contextWindow)),
    maxOutput:     Math.max(...allCaps.map((c) => c.maxOutput)),
  };
}

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
