// Capy — agent 平台（线程跑在已登记设备上），经 Clerk Native API email-code
// 登录接入（官方桌面端同一通道，非标准 OAuth client）。
// 执行非 OpenAI 协议：CapyExecutor 自建 worktree jam + NDJSON 事件流 →
// 合成 OpenAI 响应；transport.baseUrl 仅作占位/验证提示，真实路径由 executor 走
// api.capy.ai/app。
// 模型 id 保留上游 `provider/name` 斜杠形态（请求 capy/particle/particle-1
// → 上游 modelId particle/particle-1）；passthroughModels 放开其余模型 id。
export default {
  id: "capy",
  priority: 115,
  alias: "capy",
  aliases: ["capy-ai"],
  uiAlias: "capy",
  display: {
    name: "Capy",
    icon: "smart_toy",
    color: "#5B5BD6",
    textIcon: "CP",
    website: "https://capy.ai",
    notice: {
      text: "Sign in with your Capy account (email code). Threads (jams) are reused after login — no per-request device needed. Includes free ad-funded models (GLM-5.3-Flash, DeepSeek V4.1 Flash).",
      signupUrl: "https://capy.ai/sign-in",
    },
  },
  category: "oauth",
  authModes: ["oauth"],
  hasOAuth: true,
  transport: {
    baseUrl: "https://api.capy.ai/app",
    validateUrl: "https://api.capy.ai/app/me",
    format: "openai",
  },
  models: [
    { id: "particle/particle-1", name: "Particle-1 (free)" },
    { id: "zai/glm-5.3-flash-ads", name: "GLM-5.3-Flash (ads, free)" },
    { id: "deepseek/deepseek-v4.1-flash-ads", name: "DeepSeek V4.1 Flash (ads, free)" },
    { id: "anthropic/claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
    { id: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5" },
    { id: "openai/gpt-6.2-sol", name: "GPT-6.2 Sol" },
    { id: "openai/gpt-5.5", name: "GPT-5.5" },
    { id: "google/gemini-3.8-flash", name: "Gemini 3.8 Flash" },
    { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "moonshotai/kimi-k3.1-pro", name: "Kimi K3.1 Pro" },
    { id: "zai/glm-5.3", name: "GLM-5.3" },
    { id: "xiaomi/mimo-v2.6-pro", name: "MiMo-V2.6 Pro" },
  ],
  passthroughModels: true,
};
