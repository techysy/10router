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
  // INTL 端 model_list 返回 403 no schema found（#99 情报二），目录只能静态维护，
  // 待按 trae2api-hub 的 trae_catalog_intl.json 口径重筛。
  models: [
    { id: "auto", name: "Auto (Server Picks)" },
    { id: "work", name: "Work (Fast)" },
    { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
    { id: "gemini-3-flash-solo", name: "Gemini 3 Flash" },
    { id: "minimax-m3", name: "MiniMax M3" },
    { id: "minimax-m2.7", name: "MiniMax M2.7" },
    { id: "kimi-k2.5", name: "Kimi K2.5" },
    { id: "gpt-5.4", name: "GPT 5.4" },
    { id: "gpt-5.2", name: "GPT 5.2" },
  ],
  features: { usage: true },
};
