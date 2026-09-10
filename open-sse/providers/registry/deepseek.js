import { CLAUDE_API_HEADERS } from "../shared.js";

export default {
  id: "deepseek",
  priority: 110,
  alias: "deepseek",
  aliases: [
    "ds",
  ],
  uiAlias: "ds",
  display: {
    name: "DeepSeek",
    icon: "bolt",
    color: "#4D6BFE",
    textIcon: "DS",
    website: "https://deepseek.com",
    notice: {
      apiKeyUrl: "https://platform.deepseek.com/api_keys",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: "https://api.deepseek.com/chat/completions",
    validateUrl: "https://api.deepseek.com/models",
    reasoningInject: {
      scope: "all",
    },
  },
  // Multi-endpoint: pick the transport matching client sourceFormat to skip translation.
  transports: [
    {
      format: "openai",
      baseUrl: "https://api.deepseek.com/chat/completions",
      auth: { combined: true, header: "Authorization", scheme: "bearer" },
    },
    {
      format: "claude",
      baseUrl: "https://api.deepseek.com/anthropic/v1/messages",
      headers: { ...CLAUDE_API_HEADERS },
      auth: { combined: true, header: "x-api-key", scheme: "raw" },
    },
  ],
  models: [
    // V4.1-Flash 的官方 id（2026-09-10 起）。第一方更新日志：「Change the model
    // name to deepseek-flash to call the latest V4.1 Flash model」，原生多模态、
    // 1M 输入 / 384K 输出。下面的 v4-pro* / v4-flash* 是上一代命名，官方已将它们
    // 退役并临时路由到 V4.1 Flash，保留只为不打断既有配置。
    { id: "deepseek-flash", name: "DeepSeek V4.1 Flash" },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "deepseek-v4-pro-max", name: "DeepSeek V4 Pro Max", upstreamModelId: "deepseek-v4-pro" },
    { id: "deepseek-v4-pro-none", name: "DeepSeek V4 Pro No Thinking", upstreamModelId: "deepseek-v4-pro" },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Flash Vision (Exp)" },
    { id: "deepseek-chat", name: "DeepSeek V3.2 Chat" },
    { id: "deepseek-reasoner", name: "DeepSeek V3.2 Reasoner" },
  ],
  features: {
    usage: true,
    usageApikey: true,
  },
};
