// DeepAI Code (deepai.org) — desktop AI coding agent. There is no
// dashboard OAuth: sign-in happens inside the desktop app (Google /
// Apple — since upstream 0.3.19 inference is limited to social-login
// accounts; email-registered accounts get 403 social_login_required).
// The app exchanges the login for a long-lived account API key (UUID)
// written to ~/.deepai-code/userdata/secrets/deepai-account.bin, and
// inference is OpenAI-shaped at api.deepai.org/deepai_code with a
// custom `Api-Key` header (NOT Bearer) plus the billing-lane header
// X-DeepAI-Code-Theos: 2 — handled via transport.auth (dots precedent)
// and transport.headers. 27 models: 11 unmetered free, the rest spend
// the daily Theos grant (see services/usage/deepai.js). Live catalog:
// open-sse/services/deepaiModels.js. Verified end-to-end 2026-11-16.
export default {
  id: "deepai",
  priority: 33,
  alias: "deepai",
  uiAlias: "deepai",
  display: {
    name: "DeepAI Code",
    icon: "code",
    color: "#FF6B2C",
    textIcon: "DA",
    website: "https://deepai.org",
    notice: {
      text: "The API key is issued by the DeepAI Code desktop app: sign in with Google or Apple there, then copy the apiKey value from ~/.deepai-code/userdata/secrets/deepai-account.bin (on Windows: %USERPROFILE%\\.deepai-code\\userdata\\secrets\\deepai-account.bin). Email-registered accounts cannot call inference (403 social_login_required). Frontier models spend the daily Theos grant; the 11 free models are unmetered.",
      signupUrl: "https://deepai.org",
      apiKeyUrl: "https://deepai.org",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  authHint: "桌面端 API Key (UUID) — 在 DeepAI Code 应用内用 Google/Apple 登录后，从本机 ~/.deepai-code/userdata/secrets/deepai-account.bin 复制 apiKey 字段",
  transport: {
    baseUrl: "https://api.deepai.org/deepai_code/chat/completions",
    validateUrl: "https://api.deepai.org/deepai_code/models",
    auth: { combined: true, header: "api-key", scheme: "raw" },
    headers: { "X-DeepAI-Code-Theos": "2" },
    timeoutMs: 120000,
  },
  // Live catalog: GET /deepai_code/models returns a { models: [...] }
  // envelope with full per-model specs; open-sse/services/deepaiModels.js
  // resolves it per connection and both model routes prefer it over the
  // static list below.
  modelsFetcher: { url: "https://api.deepai.org/deepai_code/models", type: "openai" },
  features: {
    usage: true,
    usageApikey: true,
  },
  passthroughModels: true,
  models: [
    { id: "glm-5.3-flash", name: "GLM 5.3 Flash" },
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash 1017" },
    { id: "mimo-2.6-flash", name: "MiMo 2.6 Flash" },
    { id: "qwen-3.8-flash", name: "Qwen 3.8 Flash" },
    { id: "minimax-m3.1-flash", name: "MiniMax M3.1 Flash" },
    { id: "muse-ember", name: "Muse Ember" },
    { id: "solar-mini-4", name: "Solar Mini 4" },
    { id: "gpt-6-luna", name: "GPT-6 Luna" },
    { id: "mimo-2.6-pro", name: "MiMo 2.6 Pro" },
    { id: "glyph-cluster", name: "Glyph Cluster" },
    { id: "deepai-cyber", name: "DeepAI Cyber" },
    { id: "minimax-m3", name: "MiniMax M3" },
    { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
    { id: "gemini-4-argon", name: "Gemini 4 Argon" },
    { id: "glm-5.3", name: "GLM 5.3" },
    { id: "kimi-k3", name: "Kimi K3" },
    { id: "kimi-k3.1-pro", name: "Kimi K3.1 Pro" },
    { id: "gpt-6.1-terra", name: "GPT-6.1 Terra" },
    { id: "muse-spark-1.3", name: "Muse Spark 1.3" },
    { id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" },
    { id: "gemini-4-carbon", name: "Gemini 4 Carbon" },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
    { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
    { id: "muse-wonder", name: "Muse Wonder" },
    { id: "qwen-3.8-max-prime", name: "Qwen 3.8 Max Prime" },
    { id: "claude-fable-5-2", name: "Claude Fable 5.2" },
    { id: "gpt-6-astra", name: "GPT-6 Astra" }
  ],
};
