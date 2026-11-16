import { GOOGLE_OAUTH_CLIENT } from "../shared.js";

export default {
  id: "gemini",
  priority: 50,
  hasFree: true,
  alias: "gemini",
  display: {
    name: "Gemini",
    icon: "diamond",
    color: "#4285F4",
    textIcon: "GE",
    website: "https://ai.google.dev",
    notice: {
      apiKeyUrl: "https://aistudio.google.com/app/apikey",
    },
  },
  category: "freeTier",
  authType: "apikey",
  authModes: ["apikey"],
  mediaPriority: 1,
  transport: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/models",
    format: "gemini",
    clientId: "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com",
    clientSecret: "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",
    auth: {
      apiKey: {
        header: "x-goog-api-key",
        scheme: "raw",
      },
      oauth: {
        header: "Authorization",
        scheme: "bearer",
      },
    },
  },
  models: [
    // 2026-11-16（gemini.google.com 官方模型选择器）：Hydrogen 与 Carbon 加入
    // Gemini API 一线 —— 官方 UI 语义（快速解答=3.5 Flash-Lite / 日常帮助=
    // 4 Hydrogen / 深度研究=3.1 Pro / 代码与分析=4 Argon / 高难任务=4 Carbon，
    // Carbon 带 Pro 档升级墙）。Hydrogen 是官方「日常帮助」默认档；思考等级
    // 低/中/高三档与 gemini-level thinkingFormat 对齐。能力走 *gemini-4*
    // 通配（vision/pdf/reasoning/search/1M/1M），不另建精确行。
    // 2026-11-16 现网实测（NAS 真账号）：gemini-4-argon 免费层三项配额**恒为
    // 0**（generate_content_free_tier_input_token_count / _requests 的 RPM 与
    // RPD 全部 limit: 0）——不是「暂时超限」，是免费层根本不开放，付费专用。
    // Carbon 官方 UI 直接挂 Pro 升级墙（SGD 139.99/月）。两行 paidTier 同义：
    // 免费账号请求必然 429，等多久都不会好，出路是绑付费计费。
    // Hydrogen 免费层配额未实测（0 命中日志），先不标——官方把它当默认档，
    // 大概率免费可用，待真机 429 证据再定。
    { id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" },
    { id: "gemini-4-carbon", name: "Gemini 4 Carbon", paidTier: true, proOnly: true },
    { id: "gemini-4-argon", name: "Gemini 4 Argon", paidTier: true },
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
    { id: "gemini-3.7-flash", name: "Gemini 3.7 Flash" },
    { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash" },
    { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite" },
    { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview" },
    { id: "gemini-3.1-flash-lite-preview", name: "Gemini 3.1 Flash Lite Preview" },
    { id: "gemini-3-flash-preview", name: "Gemini 3 Flash Preview" },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite" },
    { id: "gemma-4-31b-it", name: "Gemma 4 31B IT" },
    { id: "gemini-embedding-2-preview", name: "Gemini Embedding 2 Preview", kind: "embedding" },
    { id: "gemini-embedding-001", name: "Gemini Embedding 001", kind: "embedding" },
    { id: "text-embedding-005", name: "Text Embedding 005", kind: "embedding" },
    { id: "text-embedding-004", name: "Text Embedding 004 (Legacy)", kind: "embedding" },
    { id: "gemini-3.1-flash-image-preview", name: "Gemini 3.1 Flash Image (Nano Banana 2)", params: [], kind: "image" },
    { id: "gemini-3-pro-image-preview", name: "Gemini 3 Pro Image (Nano Banana Pro)", params: [], kind: "image" },
    { id: "gemini-2.5-flash-image", name: "Gemini 2.5 Flash Image (Nano Banana)", params: [], kind: "image" },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro (Best)", params: ["language","prompt"], kind: "stt" },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", params: ["language","prompt"], kind: "stt" },
    { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite (Cheapest)", params: ["language","prompt"], kind: "stt" },
    { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", params: ["language","prompt"], kind: "stt" },
    { id: "gemini-2.5-flash-native-audio-preview-09-17", name: "Gemini Live Transcription (Realtime)", params: ["language","prompt","system_instruction","setup_timeout_ms","turn_timeout_ms"], kind: "stt", transport: "gemini-live" },
    { id: "gemini-3.1-flash-tts-preview", name: "Gemini 3.1 Flash TTS", kind: "tts" },
    { id: "gemini-2.5-flash-preview-tts", name: "Gemini 2.5 Flash TTS", kind: "tts" },
    { id: "gemini-2.5-pro-preview-tts", name: "Gemini 2.5 Pro TTS", kind: "tts" },
    { id: "embedding-001", name: "Embedding 001", dimensions: 768, kind: "embedding" },
  ],
  serviceKinds: ["llm","embedding","image","imageToText","webSearch","tts","stt"],
  ttsConfig: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/models",
    authType: "apikey",
    authHeader: "key",
    format: "gemini-tts",
  },
  sttConfig: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/models",
    authType: "apikey",
    authHeader: "key",
    format: "gemini-stt",
  },
  embeddingConfig: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/models", authType: "apikey", authHeader: "key" },
  imageConfig: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/models" },
  searchViaChat: {
    defaultModel: "gemini-2.5-flash",
    endpoint: "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
    pricingUrl: "https://ai.google.dev/pricing",
    freeTier: "Free tier: 15 RPM, 1M tokens/day on gemini-2.5-flash via AI Studio.",
  },
};
