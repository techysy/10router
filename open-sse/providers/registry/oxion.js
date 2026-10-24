// Oxion AI (oxionai.com) — USD 预付 OpenAI 兼容聚合网关（owned_by 标 "cleanapis"）。
// 官方文档：https://oxionai.com/docs（authentication / chat-completions / streaming /
// tool-calling / vision / reasoning 全套标准 OpenAI 面）；Base: https://oxionai.com/v1，
// 鉴权 Authorization: Bearer cc_...（Dashboard → API Keys 签发）。
// 2026-10-24 实测（cc_ 测试 key）：/v1/models 33 款（catalog 为裸 id，无 vendor 前缀）、
// chat/completions 非流式与 SSE 流式正常；reasoning_effort 在 glm / claude / gemini 三族
// 均被网关接受不 400（usage.reasoning_tokens 回显）——与 apinex 同为「转发 effort」的
// OpenAI 透传面，故 transport 级 thinkingFormat:"openai" 整线覆盖，canonical 行的
// zai / claude-adaptive 形状不得落到这条线。无余额 API（/v1/dashboard/billing/* 404），
// 额度只在网页 Dashboard；/v1/models/{id} 不吐 context_window/capabilities/pricing
// （文档示例是愿景 schema，现网只有 id/object/created/owned_by 基本字段）。
export default {
  id: "oxion",
  alias: "oxion",
  aliases: ["oxionai"],
  display: {
    name: "Oxion AI",
    icon: "bolt",
    color: "#3060F0",
    textIcon: "OX",
    website: "https://oxionai.com",
    notice: {
      text: "Prepaid USD-credit OpenAI-compatible aggregator. Keys and balance live in the web dashboard (no billing API). Third-party reseller — treat as untrusted for sensitive traffic.",
      apiKeyUrl: "https://oxionai.com/dashboard",
    },
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  transport: {
    baseUrl: "https://oxionai.com/v1/chat/completions",
    validateUrl: "https://oxionai.com/v1/models",
    thinkingFormat: "openai",
  },
  serviceKinds: ["llm"],
  models: [
    { id: "claude-fable-5", name: "Claude Fable 5" },
    { id: "claude-fable-5.1", name: "Claude Fable 5.1" },
    { id: "claude-mythos-preview", name: "Claude Mythos Preview" },
    { id: "claude-opus-4.6", name: "Claude Opus 4.6" },
    { id: "claude-opus-4.7", name: "Claude Opus 4.7" },
    { id: "claude-opus-4.8", name: "Claude Opus 4.8" },
    { id: "claude-opus-5", name: "Claude Opus 5" },
    { id: "claude-opus-5.5", name: "Claude Opus 5.5" },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
    { id: "deepseek-v4-flash-0731", name: "DeepSeek V4 Flash 0731" },
    { id: "deepseek-v4-pro-0813", name: "DeepSeek V4 Pro 0813" },
    { id: "deepseek-v4-pro-max", name: "DeepSeek V4 Pro Max" },
    { id: "gemma-2-2b", name: "Gemma 2 2B" },
    { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
    { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash" },
    { id: "gemini-3.7-flash", name: "Gemini 3.7 Flash" },
    { id: "glm-5.2", name: "GLM-5.2" },
    { id: "glm-5.3", name: "GLM-5.3" },
    { id: "gpt-5.5", name: "GPT-5.5" },
    { id: "gpt-5.5-pro", name: "GPT-5.5 Pro" },
    { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
    { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
    { id: "grok-4.5", name: "Grok 4.5" },
    { id: "grok-4.6", name: "Grok 4.6" },
    { id: "kimi-k2.6", name: "Kimi K2.6" },
    { id: "kimi-k3", name: "Kimi K3" },
    { id: "muse-spark-1.1", name: "Muse Spark 1.1" },
    { id: "qwen3.7-max", name: "Qwen 3.7 Max" },
    { id: "qwen3.8-27b", name: "Qwen 3.8 27B" },
    { id: "qwen3.8-max", name: "Qwen 3.8 Max" },
    { id: "seed-2.1-pro", name: "Seed 2.1 Pro" },
    { id: "seed-2.1-turbo", name: "Seed 2.1 Turbo" },
  ],
};
