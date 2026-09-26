// LongCat 国际站 (美团, longcat.ai) — 与国内站 (longcat) 共用同一套模型文档与
// 规格（官方 docs 为双域名同源部署，domainSync 机制按域名改写 link/code，国际站
// 渲染产物即 api.longcat.ai 端点；/openai/v1/models 实探 401 missing_api_key，
// 错误结构与国内站同构）。但账号、计费与 API 基域完全独立 → 独立成家。
// 能力行无需单列：canonical 查表按模型 id 全局匹配，LongCat-2.5-Preview /
// LongCat-2.0 已有行。仅代理 OpenAI 形态。
export default {
  id: "longcat-intl",
  alias: "longcat-intl",
  uiAlias: "longcat-intl",
  display: {
    name: "LongCat Intl",
    icon: "pets",
    color: "#F59E0B",
    textIcon: "LC",
    website: "https://longcat.ai",
    notice: {
      apiKeyUrl: "https://longcat.ai/platform/product",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: "https://api.longcat.ai/openai/v1/chat/completions",
    validateUrl: "https://api.longcat.ai/openai/v1/models",
  },
  models: [
    { id: "LongCat-2.5-Preview", name: "LongCat 2.5 Preview" },
    { id: "LongCat-2.0", name: "LongCat 2.0" },
  ],
};
