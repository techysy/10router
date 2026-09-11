// CodeBuddy international (codebuddy.ai) — mirrors codebuddy-cn registry shape,
// swapping the Tencent CN domain for the .ai endpoint set. All OAuth/plugin URLs
// use the /v2/plugin prefix with platform=ide (CN uses platform=CLI).
export default {
  id: "codebuddy-intl",
  alias: "cbai",
  uiAlias: "cbai",
  hidden: false,
  priority: 90,
  display: {
    name: "CodeBuddy",
    icon: "smart_toy",
    color: "#006EFF",
    website: "https://www.codebuddy.ai",
    notice: {
      signupUrl: "https://www.codebuddy.ai",
    },
  },
  category: "oauth",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  transport: {
    // Chat gateway is OpenAI-compatible SSE (same /v2/chat/completions path as CN).
    baseUrl: "https://www.codebuddy.ai/v2/chat/completions",
    forceStream: true,
    // CodeBuddy intl speaks the same unified OpenAI reasoning_effort shape as CN.
    thinkingFormat: "openai",
    headers: {
      "User-Agent": "IDE/2.108.1 CodeBuddy/2.108.1",
      "X-Product": "SaaS",
      "X-IDE-Type": "IDE",
      "X-IDE-Name": "IDE",
      "x-requested-with": "XMLHttpRequest",
      "x-codebuddy-request": "1",
    },
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
    },
    // Intl billing endpoint mirrors CN shape (data.Response.Data.Accounts[]).
    usage: {
      url: "https://www.codebuddy.ai/v2/billing/meter/get-user-resource",
    },
  },
  // The intl gateway publishes no model-catalog endpoint, so this list is
  // static. Two rules keep it honest:
  //  (1) a model is only advertised after the live gateway answers it with a
  //      real request. The gateway is an OpenAI passthrough, so an unlisted id
  //      can be probed straight through it; ids the service rejects with 11102
  //      ("model service info not found") are never listed here.
  //  (2) rateMultiplier is read off the CN credit page: CN and intl share one
  //      credit system, so a model present on both carries an identical
  //      multiplier (holds for every currently overlapping id).
  // Kept out on purpose even though a probe answers 200: kimi-k2.5 (absent from
  // the published credit list — the CN catalog drops it for the same reason),
  // deepseek-v4-pro / deepseek-v4-flash / glm-5.3-flash (11102), kimi-k2-thinking,
  // glm-4.6 / glm-4.5, gpt-5.2 / gpt-5.1 / gpt-5.6, gemini-3.5-pro / gemini-3-flash,
  // deepseek-v3.2, qwen3-max, claude-sonnet-4.5, hy4 (all 11102).
  // A listed model may still fail for one account (gemini-3.5-flash answers the
  // live 429 / code 14003 "too many requests" on a rate-limited account) — that
  // is an account/quota state, not a catalog error, so it stays advertised.
  models: [
    { id: "hy4-preview", name: "Hy4-Preview", rateMultiplier: 0 },
    { id: "hy3", name: "Hy3", rateMultiplier: 0 },
    { id: "gpt-5.6-sol", name: "GPT-5.6-Sol", rateMultiplier: 3.47 },
    { id: "gpt-5.6-terra", name: "GPT-5.6-Terra", rateMultiplier: 1.39 },
    { id: "gpt-5.6-luna", name: "GPT-5.6-Luna", rateMultiplier: 0.14 },
    { id: "gpt-5.5", name: "GPT-5.5", rateMultiplier: 3.31 },
    { id: "gpt-5.4", name: "GPT-5.4", rateMultiplier: 1.65 },
    { id: "gpt-5.3-codex", name: "GPT-5.3-Codex", rateMultiplier: 1.25 },
    { id: "gemini-3.5-flash", name: "Gemini-3.5-Flash", rateMultiplier: 0.99 },
    { id: "glm-5v-turbo", name: "GLM-5v-Turbo", rateMultiplier: 0.71 },
    { id: "glm-5.3", name: "GLM-5.3", rateMultiplier: 0.79 },
    { id: "glm-5.2", name: "GLM-5.2", rateMultiplier: 0.79 },
    { id: "glm-5.1", name: "GLM-5.1", rateMultiplier: 0.79 },
    { id: "minimax-m3", name: "MiniMax-M3", rateMultiplier: 0.25 },
    { id: "kimi-k3", name: "Kimi-K3", rateMultiplier: 1.62 },
    { id: "kimi-k2.7", name: "Kimi-K2.7-Code", rateMultiplier: 0.57 },
    { id: "kimi-k2.6", name: "Kimi-K2.6", rateMultiplier: 0.52 },
    // Promo: free for the two weeks after the upstream V4.1-Flash launch
    // (2026-09-10 — DeepSeek's "set your model to deepseek-flash" announcement).
    // The paid multiplier (0.03, CN credit page; CN and intl share one credit
    // system) stays written here on purpose: `promoFreeUntil` only drives the
    // badge, which shows `free` while the window is open and falls back to
    // 0.03x by itself afterwards — no hand cleanup, and the CN/intl parity
    // invariant in tests/unit/codebuddy-intl-models.test.js keeps holding.
    { id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash", rateMultiplier: 0.03, promoFreeUntil: "2026-09-24" },
  ],
  oauth: {
    baseUrl: "https://www.codebuddy.ai",
    stateUrl: "https://www.codebuddy.ai/v2/plugin/auth/state",
    tokenUrl: "https://www.codebuddy.ai/v2/plugin/auth/token",
    refreshUrl: "https://www.codebuddy.ai/v2/plugin/auth/token/refresh",
    userAgent: "IDE/2.63.2 CodeBuddy/2.63.2",
    platform: "ide",
    pollInterval: 5000,
  },
  features: {
    usage: true,
    usageApikey: true,
  },
};
