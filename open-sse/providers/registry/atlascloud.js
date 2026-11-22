export default {
  id: "atlascloud",
  priority: 251,
  alias: "atlascloud",
  display: {
    name: "Atlas Cloud",
    icon: "cloud_queue",
    color: "#2563EB",
    textIcon: "AC",
    website: "https://www.atlascloud.ai",
    notice: {
      apiKeyUrl: "https://console.atlascloud.ai/api-keys",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: "https://api.atlascloud.ai/v1/chat/completions",
    validateUrl: "https://api.atlascloud.ai/v1/models",
    thinkingFormat: "openai",
  },
  models: [
    { id: "deepseek-ai/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "deepseek-ai/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "qwen/qwen3.5-397b-a17b", name: "Qwen 3.5 397B A17B" },
    { id: "zai-org/glm-5.2", name: "GLM 5.2" },
    { id: "zai-org/glm-5.1", name: "GLM 5.1" },
    { id: "moonshotai/kimi-k3", name: "Kimi K3" },
    { id: "moonshotai/kimi-k2.6", name: "Kimi K2.6" },
  ],
};
