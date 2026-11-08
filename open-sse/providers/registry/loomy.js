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
  // 2026-11-08 实测收紧（客户端模型选择器 + /models 双源核对）：上游 8 → 5 款
  // （deepseek-v4-flash-0731 仍可调但客户端选择器已隐藏），qwen-3.8-max /
  // MiniMax-M3 / Kimi-k2.6 下线不可调，新增 mimo-v2.5（全模态）。倍率对齐
  // 客户端标注（积分消耗倍数，Spark-X2.6 限时免费 ×0.0）。
  models: [
    { id: "spark-x2.6", name: "Spark X2.6 正式版", rateMultiplier: 0, promoFreeNote: "限时免费" },
    { id: "qwen3.8-flash", name: "Qwen 3.8 Flash", rateMultiplier: 0.8 },
    { id: "DeepSeek-V4.1-Flash", name: "DeepSeek V4.1 Flash", rateMultiplier: 2.0 },
    { id: "deepseek-v4-flash-0731", name: "DeepSeek V4 Flash 0731", rateMultiplier: 3.0 },
    { id: "GLM-5.3-Flash", name: "GLM 5.3 Flash", rateMultiplier: 0.8 },
    { id: "mimo-v2.5", name: "MiMo V2.5", rateMultiplier: 3.3 },
  ],
  serviceKinds: ["llm"],
  passthroughModels: true,
  // 积分额度卡（issue #93）：records 探测出「永久积分 + 每日赠送积分」两张条
  features: {
    usage: true,
    usageApikey: true,
  },
};
