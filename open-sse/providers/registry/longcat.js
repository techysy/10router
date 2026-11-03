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
      apiKeyUrl: "https://longcat.chat/platform/product?inviteCode=ULW84AMZ",
    },
  },
  category: "apikey",
  // Token 资源包只在网页会话侧（longcat.chat 平台页），API key 查不到——
  // river/modelscope 同款：CD 推送 + 同名认领，无原生 usage handler。
  // 消耗顺序官方规则（2026-10 平台公告）：购买包未动时优先烧赠送包（即使
  // 购买包更早到期）；购买包开烧后全包按到期时间统一排序。前端展示按
  // detailOnly 逐包明细走，倒计时交给 earliestExpiryFirst 的存活包排序。
  features: {
    usage: true,
    usageApikey: true,
  },
  transport: {
    baseUrl: "https://api.longcat.chat/openai/v1/chat/completions",
    validateUrl: "https://api.longcat.chat/openai/v1/models",
  },
  // 2026-09-25 上线（官方更新日志）：多模态（image_url/video_url 块）+ thinking
  // 开关；快速开始限流规则 1M 上下文 / 128K 输出。
  // 2026-11 正式发布 LongCat-2.5（官方《模型参数参考》：1,048,576 上下文 /
  // max_tokens 上限 262,144 / thinking_budget 上限 262,144 / thinking
  // {type:enabled|disabled} 开关）。Preview 与正式版并存：正式版是 GA，Preview
  // 仍在目录里（老配置不失效）。
  models: [
    { id: "LongCat-2.5", name: "LongCat 2.5" },
    { id: "LongCat-2.5-Preview", name: "LongCat 2.5 Preview" },
    { id: "LongCat-2.0", name: "LongCat 2.0" },
  ],
};
