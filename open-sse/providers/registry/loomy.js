export default {
  id: "loomy",
  priority: 96,
  alias: "loomy",
  uiAlias: "loomy",
  display: {
    name: "Loomy",
    icon: "auto_awesome",
    color: "#0284C7",
    textIcon: "LM",
    website: "https://loomy.xunfei.cn",
    notice: {
      // 凭据不是开放注册的 API Key，而是 Loomy 客户端（loomy.xunfei.cn）登录后的
      // 会话 token：本机客户端登录后由 CreditDaddy「本机导入 / 手机直登」捕获，
      // 或直接粘贴 session。chat 认 Bearer；/models 只认自定义 token 头（见
      // PROVIDER_MODELS_CONFIG.loomy）。session 约 14 天有效，客户端退出不影响。
      apiKeyUrl: "https://loomy.xunfei.cn",
    },
  },
  category: "freeTier",
  authModes: ["apikey"],
  transport: {
    baseUrl: "https://loomyad.xunfei.cn/api/v1/chat/completions",
    format: "openai",
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
    },
  },
  // 2026-10-30 实测可用清单（来源：NAS 10R 已路由验证的自定义节点导入结果）
  models: [
    { id: "spark-x2.6", name: "Spark X2.6 (Free)" },
    { id: "qwen3.8-flash", name: "Qwen 3.8 Flash" },
    { id: "qwen-3.8-max", name: "Qwen 3.8 Max" },
    { id: "DeepSeek-V4.1-Flash", name: "DeepSeek V4.1 Flash" },
    { id: "deepseek-v4-flash-0731", name: "DeepSeek V4 Flash 0731" },
    { id: "MiniMax-M3", name: "MiniMax M3" },
    { id: "Kimi-k2.6", name: "Kimi K2.6" },
    { id: "GLM-5.3-Flash", name: "GLM 5.3 Flash" },
  ],
  serviceKinds: ["llm"],
  passthroughModels: true,
};
