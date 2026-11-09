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
  // 模型目录：显示名 / 倍率 / 标签按官方客户端 2026-11-09 实拍对齐（用户截图四张，
  // 倍率 = 官方积分消耗速度；#108 发版前校准）。官方清单没有的旧模型**删除**
  // （用户明确要求：截图上没有的就删掉；老 combo 引用断了可重建，不留僵尸行）。
  // 标签字段口径（与 codebuddy-cn 同一套）：
  //   专属补贴 / 会员限时优惠 / 闲时折扣 都是**折扣型**（倍率非 0），用 discountNote
  //   承载规则说明——不亮 free 徽章（promoFree* 会亮 free，夸大）。
  //   Kimi-K3.1-Pro 官方列表带锁（会员 Lite/Pro/Pro+/Ultra/Express 专属）→ paidTier。
  // 显示名去掉『Doubao 』前缀（官方列表就叫 Seed-2.1-Turbo）；id 不动（老 combo /
  // 连接引用不受影响）。
  models: [
    { id: "Doubao-Seed-2.1-Turbo", name: "Seed-2.1-Turbo", rateMultiplier: 0.20, discountNote: "专属补贴：积分消耗 0.20 倍" },
    { id: "Doubao-Seed-2.1-Pro", name: "Seed-2.1-Pro-0915", rateMultiplier: 0.80 },
    { id: "Doubao-Seed-Evolving", name: "Seed-Evolving", rateMultiplier: 0.80 },
    { id: "Doubao-Seed-Code", name: "Seed-Code", rateMultiplier: 0.06, discountNote: "专属补贴：积分消耗 0.06 倍" },
    { id: "glm-5.3", name: "GLM-5.3", rateMultiplier: 0.78, discountNote: "会员限时优惠 0.78 倍，生效至 11-16" },
    { id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash", rateMultiplier: 0.06, discountNote: "会员限时优惠 0.06 倍，生效至 11-16" },
    { id: "DeepSeek-V4-Pro-Official", name: "DeepSeek-V4-Pro", rateMultiplier: 0.36, discountNote: "闲时折扣：北京时间周一至周五 09:00-12:00、14:00-18:00 属忙时 0.36 倍，其余时段 5 折 0.06 倍" },
    { id: "kimi-k3.1-pro", name: "Kimi-K3.1-Pro", paidTier: true },
    { id: "kimi-k3", name: "Kimi-K3", rateMultiplier: 1.83 },
    { id: "mimo-v2.6-flash", name: "MiMo-V2.6-Flash", rateMultiplier: 0.06 },
    { id: "mimo-v2.6-pro", name: "MiMo-V2.6-Pro", rateMultiplier: 0.15 },
    { id: "minimax-m3.1-flash", name: "MiniMax-M3.1-Flash", rateMultiplier: 0.09 },
    { id: "minimax-m3", name: "MiniMax-M3", rateMultiplier: 0.26 },
    { id: "step-5-preview", name: "Step-5-Preview", rateMultiplier: 0.48 },
    { id: "qwen3.8-flash", name: "Qwen3.8-Flash", rateMultiplier: 0.08 },
    { id: "qwen3.8-max", name: "Qwen3.8-Max", rateMultiplier: 1.50 },
    { id: "glm-5.3-flash", name: "GLM-5.3-Flash", rateMultiplier: 0.08 },
    { id: "glm-5.3-flashx", name: "GLM-5.3-FlashX", rateMultiplier: 0.31 },
  ],
  features: { usage: true },
};
