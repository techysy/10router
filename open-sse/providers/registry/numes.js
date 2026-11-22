// Numes (numes.ai) — OpenAI-compatible inference marketplace: independent
// providers serve the models behind one Chat Completions endpoint, paid per
// request from a USD or Bitcoin balance (key currency is fixed at creation).
// https://numes.ai/docs — "Numes speaks the OpenAI Chat Completions API, so
// existing code needs only a new base URL and key."
//
// Wire notes (docs/api-reference):
//   · Auth: `Authorization: Bearer $NUMES_API_KEY` — same header on /models
//     and /chat/completions (GET /models answers 401 without it, so no
//     modelsFetcher: the dashboard's suggested-models proxy fetches without
//     credentials and would always come back empty).
//   · Model ids are OpenRouter-shaped `author/model`, plus suffixes: `:free`
//     (free endpoints, plain ids only route to priced endpoints), `:e2ee`
//     (encrypted-inference envelope, not plain chat — not registered here),
//     `:batch`. Reasoning accepts BOTH `reasoning: {effort}` (OpenRouter
//     object) and the OpenAI `reasoning_effort` shorthand (docs/features/
//     reasoning) — thinkingFormat "openai" maps onto the latter directly.
//   · Catalog drifts like every marketplace (309 ids when onboarded,
//     2026-11-23): static list anchors the flagships + the free roster,
//     passthroughModels accepts everything else by id.
//   · 503 service_unavailable is the platform's overload/available-capacity
//     error and flaps under load (observed repeatedly during onboarding);
//     the default retry table already retries it 3× with backoff.
export default {
  id: "numes",
  priority: 33,
  alias: "numes",
  uiAlias: "numes",
  display: {
    name: "Numes",
    icon: "bolt",
    color: "#d7ff01",
    textIcon: "NU",
    website: "https://numes.ai",
    notice: {
      text: "OpenAI-compatible marketplace: frontier and open-source models from independent providers, billed per request from a USD or Bitcoin balance. Ids ending in :free are served at no charge; a plain id routes only to priced endpoints.",
      apiKeyUrl: "https://numes.ai/dashboard",
      signupUrl: "https://numes.ai",
    },
  },
  category: "apikey",
  hasFree: true,
  authType: "apikey",
  authModes: ["apikey"],
  transport: {
    baseUrl: "https://api.numes.ai/api/v1/chat/completions",
    validateUrl: "https://api.numes.ai/api/v1/models",
    thinkingFormat: "openai",
    timeoutMs: 120000,
  },
  passthroughModels: true,
  models: [
    // ── free roster (charged $0; quotas return 429 rate_limited, never a paid fallback) ──
    { id: "z-ai/glm-5.3:free", name: "GLM 5.3 (free)" },
    { id: "z-ai/glm-5.3-flash:free", name: "GLM 5.3 Flash (free)" },
    { id: "deepseek/deepseek-v4.1-flash:free", name: "DeepSeek V4.1 Flash (free)" },
    { id: "moonshotai/kimi-k3.1-pro:free", name: "Kimi K3.1 Pro (free)" },
    { id: "nvidia/nemotron-3-ultra-550b-a55b:free", name: "Nemotron 3 Ultra 550B (free)" },
    // ── OpenAI ──
    { id: "openai/gpt-6-luna", name: "GPT-6 Luna" },
    { id: "openai/gpt-6-luna-pro", name: "GPT-6 Luna Pro" },
    { id: "openai/gpt-6-sol", name: "GPT-6 Sol" },
    { id: "openai/gpt-6-astra", name: "GPT-6 Astra" },
    { id: "openai/gpt-5.2", name: "GPT-5.2" },
    // ── Anthropic ──
    { id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5" },
    { id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5" },
    { id: "anthropic/claude-fable-5.2", name: "Claude Fable 5.2" },
    { id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5" },
    // ── Google ──
    { id: "google/gemini-3.1-pro", name: "Gemini 3.1 Pro" },
    { id: "google/gemini-3.8-flash", name: "Gemini 3.8 Flash" },
    // ── xAI ──
    { id: "x-ai/grok-4.7", name: "Grok 4.7" },
    // ── DeepSeek ──
    { id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
    { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "deepseek/deepseek-v3.2", name: "DeepSeek V3.2" },
    // ── GLM ──
    { id: "z-ai/glm-5.3", name: "GLM 5.3" },
    { id: "z-ai/glm-5.3-flashx", name: "GLM 5.3 FlashX" },
    { id: "z-ai/glm-4.7", name: "GLM 4.7" },
    // ── Qwen ──
    { id: "qwen/qwen4-max", name: "Qwen4 Max" },
    { id: "qwen/qwen3.8-max", name: "Qwen3.8 Max" },
    { id: "qwen/qwen3.8-flash", name: "Qwen3.8 Flash" },
    // ── Moonshot ──
    { id: "moonshotai/kimi-k3", name: "Kimi K3" },
    { id: "moonshotai/kimi-k3.1-pro", name: "Kimi K3.1 Pro" },
    { id: "moonshotai/kimi-k2.6", name: "Kimi K2.6" },
    // ── others ──
    { id: "minimax/minimax-m3.1-flash", name: "MiniMax M3.1 Flash" },
    { id: "xiaomi/mimo-v2.6-pro", name: "MiMo-V2.6 Pro" },
    { id: "xiaomi/mimo-v2.6-flash", name: "MiMo V2.6 Flash" },
    { id: "tencent/hy4", name: "Hy4" },
    { id: "tencent/hy4-flash", name: "Hy4 Flash" },
  ],
};
