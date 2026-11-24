// QuWork（quwork.cn，人人租 QurWork 桌面端同一账号体系）— 手机号短信直登
// （阿里云滑块 → /api/sendVerifyCode → /api/user/client/login）或粘贴 token，
// OpenAI 兼容推理网关 llm.quwork.cn/v1，DefaultExecutor 直走 transport。
// 协议源自开源 quwork-auth@0.1.0（github okdunli/quwork-auth，MIT）。
//
// 凭据落位（与 croli/meoo 同构）：apiKey = llm_token（推理 Bearer，QuWork 不
// 轮换；DefaultExecutor 的 Bearer 描述符优先 apiKey）；accessToken /
// refreshToken = 账号 token（~2h，tokenRefresh 的 quwork 刷新器经
// oauth.refreshUrl 续期；积分/签到用）。
//
// 网络：QuWork 网关前置阿里云 WAF，非中国大陆出口 IP 会被直接 405。本 provider
// 不内置任何代理逻辑——需要时用 10Router 通用的全局出站代理或连接级代理/代理池。
export default {
  id: "quwork",
  priority: 116,
  alias: "quwork",
  uiAlias: "quwork",
  display: {
    name: "QuWork",
    icon: "smart_toy",
    color: "#ff7a06",
    textIcon: "QW",
    website: "https://quwork.cn",
    notice: {
      text: "Sign in with your QuWork phone number (SMS code after a slider captcha) or paste llm_token + access token. QuWork's gateways reject non-mainland-China IPs (HTTP 405): if this server is outside mainland China, set a mainland proxy in Settings (outbound proxy) or on the connection. Daily reward points can be claimed from the connection card or automatically (Experimental).",
      signupUrl: "https://quwork.cn",
    },
  },
  category: "oauth",
  authModes: ["oauth"],
  hasOAuth: true,
  transport: {
    baseUrl: "https://llm.quwork.cn/v1/chat/completions",
    validateUrl: "https://llm.quwork.cn/v1/models",
    headers: { "X-QurWork-Env": "prod", "X-QurWork-Version": "0.2.2-rc.1" },
    timeoutMs: 180000,
    format: "openai",
  },
  features: {
    usage: true,
  },
  passthroughModels: true,
  models: [
    { id: "deepseek-flash", name: "DeepSeek-V4.1-Flash" },
    { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro" },
    { id: "kimi-k2.7-code", name: "Kimi-K2.7-Code" },
    { id: "kimi-k2.6", name: "Kimi-K2.6" },
    { id: "glm-5.2", name: "GLM-5.2" },
    { id: "glm-5.3-flash", name: "GLM-5.3 Flash" },
    { id: "qwen3.7-plus", name: "Qwen3.7-Plus" },
    { id: "qwen3.8-max", name: "Qwen3.8-Max" },
    { id: "qwen3.8-flash", name: "Qwen3.8-Flash" },
    { id: "MiniMax-M2.5", name: "MiniMax-M2.5" },
  ],
  oauth: {
    // 账号网关（端点配置 img1.rrzuji.cn/.../quwork-desktop-api-endpoint-config.json 的 prod 值）
    apiBaseUrl: "https://llm.rrzu.com",
    sendCodeUrl: "https://llm.rrzu.com/api/sendVerifyCode",
    loginUrl: "https://llm.rrzu.com/api/user/client/login",
    refreshUrl: "https://llm.rrzu.com/api/user/refresh",
    userInfoUrl: "https://llm.rrzu.com/api/user/self",
    dailyRewardStatusUrl: "https://llm.rrzu.com/api/user/daily-reward/status",
    dailyRewardClaimUrl: "https://llm.rrzu.com/api/user/daily-reward/claim",
    inferenceBaseUrl: "https://llm.quwork.cn/v1",
    modelConfigUrl: "https://img1.rrzuji.cn/qurvis-package/latest/qurvis-desktop-model-config.json",
    clientVersion: "0.2.2-rc.1",
    platform: "qurvis",
    // 阿里云验证码 2.0（与 QuWork 桌面端一致）
    captcha: { region: "cn", prefix: "1hms8d", sceneId: "10vzkucv" },
  },
};
