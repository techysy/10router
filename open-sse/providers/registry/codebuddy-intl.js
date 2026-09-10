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
  // The intl gateway has no verified public model-catalog endpoint. Keep this
  // list static; the old hand-maintained JSON import advertised models that
  // the intl service rejected with 11102 (model service info not found).
  // rateMultiplier = credit cost multiplier published on codebuddy.ai
  // (0 = rides the free quota).
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
    { id: "glm-5.3", name: "GLM-5.3", rateMultiplier: 0.79 },
    { id: "glm-5.2", name: "GLM-5.2", rateMultiplier: 0.79 },
    { id: "kimi-k3", name: "Kimi-K3", rateMultiplier: 1.62 },
    { id: "kimi-k2.6", name: "Kimi-K2.6", rateMultiplier: 0.52 },
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
