// TokenBom — new-api style OpenAI-compatible gateway (docs: https://tokenbom.com/welcome).
// Bearer auth; chat + image generation under one key. Base: https://tokenbom.com/v1
// Model IDs are per-credential (new-api catalog); the seed list below can be
// extended from the provider's /models endpoint (Import from /models).
export default {
  id: "tokenbom",
  alias: "tokenbom",
  display: {
    name: "TokenBom",
    icon: "bolt",
    color: "#6366F1",
    textIcon: "TB",
    website: "https://tokenbom.com",
    notice: {
      apiKeyUrl: "https://tokenbom.com/login?mode=register&invite=SS-CB5D0A43",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: "https://tokenbom.com/v1/chat/completions",
    validateUrl: "https://tokenbom.com/v1/models",
  },
  models: [
    { id: "claude-opus-5", name: "Claude Opus 5" },
    { id: "claude-4.8-opus", name: "Claude Opus 4.8" },
    { id: "claude-4.7-opus", name: "Claude Opus 4.7" },
    { id: "claude-4.6-opus", name: "Claude Opus 4.6" },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
    { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "glm-5.3-flash", name: "GLM-5.3-Flash" },
    { id: "glm-5.3", name: "GLM-5.3" },
    { id: "kimi-k3", name: "Kimi K3" },
    { id: "qwen3.8-flash", name: "Qwen3.8-Flash" },
  ],
};
