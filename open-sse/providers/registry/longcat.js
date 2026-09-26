// LongCat (美团) — OpenAI-compatible gateway at api.longcat.chat.
// Docs: https://longcat.chat/platform/docs/zh/api-docs
// OpenAI format lives under /openai/ (chat: POST /openai/v1/chat/completions),
// Anthropic format under /anthropic/ — we only proxy the OpenAI shape here.
export default {
  id: "longcat",
  alias: "longcat",
  display: {
    name: "LongCat",
    icon: "pets",
    color: "#F59E0B",
    textIcon: "LC",
    website: "https://longcat.chat",
    notice: {
      apiKeyUrl: "https://longcat.chat/platform/product",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: "https://api.longcat.chat/openai/v1/chat/completions",
    validateUrl: "https://api.longcat.chat/openai/v1/models",
  },
  // 2026-09-25 上线（官方更新日志）：多模态（image_url/video_url 块）+ thinking
  // 开关；快速开始限流规则 1M 上下文 / 128K 输出。当前在线模型仅 2.5-Preview 与 2.0。
  models: [
    { id: "LongCat-2.5-Preview", name: "LongCat 2.5 Preview" },
    { id: "LongCat-2.0", name: "LongCat 2.0" },
  ],
};
