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
  models: [{ id: "LongCat-2.0", name: "LongCat 2.0" }],
};
