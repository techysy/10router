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
      // 2026-11-15 用户点名：页面上要点明 CreditDaddy 的多账号管理 + 邀请码
      // 复制/填写能力 —— 多账号是 Loomy 的主用法，不写出来用户不知道去哪管理。
      text: "Manage multiple Loomy accounts in CreditDaddy — one-click copy & fill of invite codes, balances auto-synced to 10Router.",
      // 描述里的产品名渲染成内联链接（最新 Release 页）—— 用户看到
      // CreditDaddy 时下一反应就是「去哪下载」。
      textLink: {
        term: "CreditDaddy",
        href: "https://github.com/techysy/CreditDaddy/releases/latest",
      },
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
  // 2026-11-25 实测对齐（6 个 NAS session 打 /models 全一致 + 客户端选择器截图）：
  // 聊天 5 款——spark-x2.6 限时免费已结束（×2.5），新增 deepseek-v4-flash-1017
  // （即客户端「DeepSeek V4.1 Flash 1017」，×2.0，vision，1M/384K）；0731 与
  // mimo-v2.5 已从 live 目录消失（0731 上轮已只是选择器隐藏，本轮彻底下架）。
  // 倍率 = 客户端标注的积分消耗倍数（标准 1.0x）。live 目录另有 3 款画图模型
  // 与 auto 档，本 provider 只做 chat（serviceKinds: ["llm"]），不收录。
  models: [
    { id: "spark-x2.6", name: "Spark X2.6 正式版", rateMultiplier: 2.5 },
    { id: "qwen3.8-flash", name: "Qwen 3.8 Flash", rateMultiplier: 0.8 },
    { id: "DeepSeek-V4.1-Flash", name: "DeepSeek V4.1 Flash", rateMultiplier: 2.0 },
    { id: "deepseek-v4-flash-1017", name: "DeepSeek V4.1 Flash 1017", rateMultiplier: 2.0 },
    { id: "GLM-5.3-Flash", name: "GLM 5.3 Flash", rateMultiplier: 0.8 },
  ],
  serviceKinds: ["llm"],
  passthroughModels: true,
  // 积分额度卡（issue #93）：records 探测出「永久积分 + 每日赠送积分」两张条
  features: {
    usage: true,
    usageApikey: true,
  },
};
