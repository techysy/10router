// Trae 国际站 (trae.ai, ByteDance marscode) registry entry — issue #99 拆线。
// 国内站独立条目见 trae-cn.js（账号与 refresh token 不互通，主机面完全分叉）。
// Chat = SOLO remote agent API:
//   POST {base}/chat_sessions → {data:{chat_session_id, message_id}}
//   GET  {base}/chat_sessions/{id}/events?reply_to_message_id=... → SSE
//   Auth: Authorization: Cloud-IDE-JWT <jwt>
export default {
  id: "trae",
  alias: "tr",
  uiAlias: "tr",
  aliases: ["marscode"],
  category: "oauth",
  authType: "oauth",
  hasOAuth: true,
  authModes: ["oauth"],
  display: {
    name: "Trae",
    icon: "bolt",
    color: "#FF6A00",
    textIcon: "TR",
    website: "https://www.trae.ai",
    notice: { signupUrl: "https://www.trae.ai" },
  },
  transport: {
    // SOLO remote agent base — verified working chat endpoint.
    // 国际版 core host 已按账号区域生成（USTTP → traeapi.us / SG → coresg- / US → coreva-），
    // 动态发现待 #99 落地要点 3；当前仍是老全球主机。
    baseUrl: "https://core-normal.trae.ai/api/remote/v1",
    format: "openai",
    headers: {
      "X-Trae-Client-Type": "web",
      "X-Preferenced-Language": "en",
      "Referer": "https://solo.trae.ai/",
    },
    // Auth: Cloud-IDE-JWT scheme on Authorization — injected by executor buildHeaders.
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "Cloud-IDE-JWT",
    },
    usage: {
      url: "https://api.marscode.com/cloudide/api/v3/trae/GetUserInfo",
    },
    regions: {
      cn: "https://api.marscode.com",
      sg: "https://api.trae.ai",
      us: "https://www.trae.ai",
    },
    defaultRegion: "cn",
  },
  oauth: {
    clientId: "ono9krqynydwx5",
    clientSecret: "-",
    platform: "trae",
    pollInterval: 1500,
    // Login guidance returns LoginHost for browser open.
    loginGuidanceUrl: "https://api.marscode.com/cloudide/api/v3/trae/GetLoginGuidance",
    // ExchangeToken: refresh -> access (POST JSON, body below).
    tokenUrl: "https://api.marscode.com/cloudide/api/v3/trae/oauth/ExchangeToken",
    exchangeTokenUrl: "https://api.marscode.com/cloudide/api/v3/trae/oauth/ExchangeToken",
    refreshUrl: "https://api.marscode.com/cloudide/api/v3/trae/oauth/ExchangeToken",
    userInfoUrl: "https://api.marscode.com/cloudide/api/v3/trae/GetUserInfo",
    // Trae refresh uses custom JSON body, not OAuth form — handled by refresh.js, not config-driven.
    refresh: { encoding: "json" },
  },
  // Model catalog (IDE flow, core-normal.trae.ai).
  // INTL 端 model_list 返回 403 no schema found（#99 情报二），目录只能静态维护。
  // 2026-11-10 按官方国际版客户端「内置模型」清单全量对齐（用户截图四张）：
  //   · Auto Mode + Seed-2.1-Turbo 是免费档 —— Seed-2.1-Turbo 支持图片理解、
  //     按 Token 计费（无积分倍率概念），是免费账号的默认可用模型。
  //   · 免费账号每月 $1（Dollar Usage）额度；其余模型全部会员锁定
  //     （该模型仅限 Lite, Pro, Pro+, Ultra 用户使用）→ paidTier 亮锁。
  //   · 官方清单没有的旧条目删除（用户口径：截图上没有的就删掉；
  //     老 combo 引用断了可重建）—— work / gemini-3.1-pro / gemini-3-flash-solo 撤下。
  //   · 命名口径同 trae-cn / codebuddy-cn：name 只抄官方型号本体；
  //     id 沿用线上 id 风格（gpt-5.4 / gpt-5.2 / kimi-k2.5 / minimax-m3 /
  //     minimax-m2.7 是旧目录实测在用的 id，其余按同风格推导——INTL 无法
  //     探测 model_list，上线后以实际请求为准修正）。
  //   · Seed 系 id 沿用国内线实证的线上 id（Doubao 前缀是 ByteDance 内部
  //     型号名，客户端 UI 统一隐藏）；INTL 侧未实测，标注存疑。
  //   · INTL pay 端点实测 404（套餐数据只在 dashboard 可见），无倍率可抄，
  //     故不放 rateMultiplier（与旧目录一致）。
  models: [
    { id: "auto", name: "Auto Mode" },
    // 免费默认（图片理解 / 按 Token 计费）—— 不带 paidTier
    { id: "Doubao-Seed-2.1-Turbo", name: "Seed-2.1-Turbo" },
    // GPT-6.x 家族
    { id: "gpt-6.1-sol", name: "GPT-6.1-Sol", paidTier: true },
    { id: "gpt-6.1-terra", name: "GPT-6.1-Terra", paidTier: true },
    { id: "gpt-6-astra", name: "GPT-6-Astra", paidTier: true },
    { id: "gpt-6-sol", name: "GPT-6-Sol", paidTier: true },
    // GPT-5.x 家族（gpt-5.4 / gpt-5.2 为旧目录实测 id）
    { id: "gpt-5.6-sol", name: "GPT-5.6-Sol", paidTier: true },
    { id: "gpt-5.6-terra", name: "GPT-5.6-Terra", paidTier: true },
    { id: "gpt-5.6-luna", name: "GPT-5.6-Luna", paidTier: true },
    { id: "gpt-5.5", name: "GPT-5.5", paidTier: true },
    { id: "gpt-5.4", name: "GPT-5.4", paidTier: true },
    { id: "gpt-5.2", name: "GPT-5.2", paidTier: true },
    // GLM / DeepSeek / Kimi / Gemini / MiniMax（全部会员锁定）
    { id: "glm-5.2", name: "GLM-5.2", paidTier: true },
    { id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash", paidTier: true },
    { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash", paidTier: true },
    { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", paidTier: true },
    { id: "kimi-k3", name: "Kimi-K3", paidTier: true },
    { id: "kimi-k2.7-code", name: "Kimi-K2.7-Code", paidTier: true },
    { id: "kimi-k2.5", name: "Kimi-K2.5", paidTier: true },
    { id: "gemini-3.1-pro-preview", name: "Gemini-3.1-Pro-Preview", paidTier: true },
    { id: "gemini-3-flash-preview", name: "Gemini-3-Flash-Preview", paidTier: true },
    { id: "minimax-m3", name: "MiniMax-M3", paidTier: true },
    { id: "minimax-m2.7", name: "MiniMax-M2.7", paidTier: true },
  ],
  features: { usage: true },
};
