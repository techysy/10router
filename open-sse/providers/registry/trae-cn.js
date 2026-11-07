// Trae 国内站 (trae.cn, ByteDance marscode CN) registry entry — issue #99 拆线（方案 A）。
// 与国际站 (trae.js) 的账号 / refresh token 不互通（拿错端换必 20101），数据面与
// 账号面主机也完全分叉（#99 情报二），故拆为独立条目；CreditDaddy 账号同步按
// TENROUTER_PROVIDER_MAP 以 provider id 对接（qoder-cn / codebuddy-cn 同款约定）。
// Chat = SOLO remote agent API（与国际站同形态）:
//   POST {base}/chat_sessions → {data:{chat_session_id, message_id}}
//   GET  {base}/chat_sessions/{id}/events?reply_to_message_id=... → SSE
//   Auth: Authorization: Cloud-IDE-JWT <jwt>
export default {
  id: "trae-cn",
  alias: "trae-cn",
  uiAlias: "trae-cn",
  category: "oauth",
  authType: "oauth",
  hasOAuth: true,
  authModes: ["oauth"],
  display: {
    name: "Trae (China)",
    icon: "bolt",
    color: "#FF6A00",
    textIcon: "TC",
    website: "https://www.trae.cn",
    notice: { signupUrl: "https://www.trae.cn" },
  },
  transport: {
    // 国内 web remote 数据面（#99 情报二，trae2api-hub / Trae2api-cn 双源实测）：
    // core-normal.trae.cn 不解析；api.trae.com.cn 只承接 CloudIDE/OAuth/pay，
    // /api/ide/* 打过去 404 —— 国内 SOLO remote 会话走 mchost.guru 网关。
    baseUrl: "https://trae-api-cn.mchost.guru/api/remote/v1",
    soloBaseUrlCn: "https://trae-api-cn.mchost.guru/api/remote/v1",
    format: "openai",
    headers: {
      "X-Trae-Client-Type": "web",
      "X-Preferenced-Language": "zh",
      "Referer": "https://www.trae.cn/",
    },
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "Cloud-IDE-JWT",
    },
    usage: {
      url: "https://api.trae.com.cn/cloudide/api/v3/trae/GetUserInfo",
    },
    regions: {
      cn: "https://api.trae.com.cn",
    },
    defaultRegion: "cn",
  },
  oauth: {
    clientId: "ono9krqynydwx5",
    clientSecret: "-",
    platform: "trae",
    pollInterval: 1500,
    // 国内站网关族：api.trae.com.cn / api.marscode.cn / api.trae.cn（#69 实测全部可用）。
    loginGuidanceUrl: "https://api.trae.com.cn/cloudide/api/v3/trae/GetLoginGuidance",
    tokenUrl: "https://api.trae.com.cn/cloudide/api/v3/trae/oauth/ExchangeToken",
    exchangeTokenUrl: "https://api.trae.com.cn/cloudide/api/v3/trae/oauth/ExchangeToken",
    refreshUrl: "https://api.trae.com.cn/cloudide/api/v3/trae/oauth/ExchangeToken",
    userInfoUrl: "https://api.trae.com.cn/cloudide/api/v3/trae/GetUserInfo",
    refresh: { encoding: "json" },
  },
  // 模型目录对齐 TRAE 2.3.87413 官方 remote（Work / SOLO Agent，2026-10-10 采集，#54；
  // 与 trae-free 同源——同一条 SOLO remote 协议的国内目录）。
  models: [
    { id: "Doubao-Seed-Code", name: "Doubao Seed Code" },
    { id: "Doubao-Seed-2.1-Pro", name: "Doubao Seed 2.1-Pro" },
    { id: "Doubao-Seed-2.1-Turbo", name: "Doubao Seed 2.1-Turbo" },
    { id: "Doubao-Seed-Evolving", name: "Doubao Seed Evolving" },
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1-Flash" },
    { id: "DeepSeek-V4-Flash-Official", name: "DeepSeek V4-Flash Official" },
    { id: "DeepSeek-V4-Pro-Official", name: "DeepSeek V4-Pro Official" },
    { id: "glm-5.2", name: "GLM 5.2" },
    { id: "glm-5.3", name: "GLM 5.3" },
    { id: "glm-5.3-flash", name: "GLM 5.3-Flash" },
    { id: "glm-5.3-flashx", name: "GLM 5.3-FlashX" },
    { id: "mimo-v2.6-flash", name: "MiMo V2.6-Flash" },
    { id: "mimo-v2.6-pro", name: "MiMo V2.6-Pro" },
    { id: "kimi-k2.6", name: "Kimi K2.6" },
    { id: "kimi-k2.7-code", name: "Kimi K2.7-Code" },
    { id: "kimi-k3", name: "Kimi K3" },
    { id: "minimax-m3", name: "MiniMax M3" },
    { id: "qwen-3.7-plus", name: "Qwen 3.7-Plus" },
    { id: "qwen3.8-max", name: "Qwen 3.8-Max" },
    { id: "step-5-preview", name: "Step 5-Preview" },
  ],
  features: { usage: true },
};
