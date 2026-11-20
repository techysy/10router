// Croli (croli.net) — Clerk OAuth + credits 池 + 模型网关（2026-11-20 CD 侧全链实测）。
//
// 凭据链：Clerk JWT（24h 短命 + refresh 轮换）→ POST relay/api/deepseek/sk 领
// 网关 key（幂等，同一账号恒回同一把 csk_）→ ds.croli.net/v1 OpenAI 兼容 +
// /v1/messages anthropic 兼容（claude_code 线）。
//
// 模型目录为 CD 侧 2026-11-20 逐一探活矩阵的**可用子集**（/v1/models 列 11 个，
// 其中 5 个实测不可用：claude-fable-5-2 与 deepseek-v4-flash 不在 OpenCode Go
// 套餐、deepseek-v4.1-flash 地区限制、DeepSeek-V4.1-Flash 计费口径不同、
// gemini-4-argon 上游挂起）。上游校验 max_tokens ≥ 16。
//
// 每日任务：签到 +100（ops/checkin）、每日首次对话 +200（agent_turn_completed
// 事件 = 用网关发一条 say-hi，消耗 trial 池每日 2000 免费）——调度器在
// src/sse/services/croliCheckin.js，settings key croliCheckin。
export default {
  id: "croli",
  priority: 33,
  alias: "croli",
  uiAlias: "croli",
  display: {
    name: "Croli",
    icon: "smart_toy",
    color: "#84cc16",
    website: "https://croli.net",
    notice: {
      text: "Croli connections sign in via Clerk (Google / GitHub / email) with the paste-callback flow. Daily check-in (+100) and the first-conversation gift (+200) are automated by the Croli check-in scheduler.",
      signupUrl: "https://croli.net",
      apiKeyUrl: "https://www.croli.net/invite/?code=FNRPRGUUQL",
    },
  },
  category: "oauth",
  authModes: ["oauth"],
  hasOAuth: true,
  // Clerk 只注册 loopback redirect_uri（127.0.0.1:任意端口/callback 通配）——
  // 与 antigravity 同款：dashboard 生成 loopback 形授权 URL，用户浏览器授权后
  // 跳转失败的页面正是回调（地址栏即完整回调 URL），粘贴回来完成换票。
  oauthLoginHidden: false,
  authHint: "授权窗口会话可选无痕/账号槽；回调页面打不开是正常的——复制地址栏完整 URL 粘贴回 CreditDaddy/10Router 即可",
  transport: {
    baseUrl: "https://ds.croli.net/v1/chat/completions",
    validateUrl: "https://ds.croli.net/v1/models",
    headers: {},
    timeoutMs: 120000,
  },
  modelsFetcher: { url: "https://ds.croli.net/v1/models", type: "openai" },
  features: {
    usage: true,
  },
  passthroughModels: true,
  models: [
    // CD 侧 2026-11-20 逐一探活的可用子集（6/11）；上游校验 max_tokens ≥ 16。
    // claude 系走 group/auto-* 池化路由，gpt 系直连上游（windsurf/kiro 池）。
    { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
    { id: "claude-opus-5.5", name: "Claude Opus 5.5" },
    { id: "gpt-6-luna", name: "GPT-6-Luna" },
    { id: "gpt-6.1-sol", name: "GPT-6.1-Sol" },
    { id: "gpt-5.6-luna", name: "GPT-5.6-Luna" },
    { id: "gpt-5.6-sol", name: "GPT-5.6-Sol" },
  ],
  oauth: {
    // Clerk OAuth application（public client，PKCE S256，无 secret）。
    // issuer clerk.croli.net；token/userinfo 端点与 CD 侧 croliAuth.js 同源。
    clientId: "znV4SkcUsY1AektQ",
    authorizeUrl: "https://clerk.croli.net/oauth/authorize",
    tokenUrl: "https://clerk.croli.net/oauth/token",
    refreshUrl: "https://clerk.croli.net/oauth/token",
    scope: "profile email offline_access",
    codeChallengeMethod: "S256",
    refresh: { encoding: "form" },
    apiBaseUrl: "https://clerk.croli.net",
    gatewayBaseUrl: "https://ds.croli.net/v1",
    userInfoUrl: "https://clerk.croli.net/oauth/userinfo",
    // credits 池（签到/余额/sk 领取）与网关不同域
    creditsBaseUrl: "https://ds.croli.net/credits",
    skClaimUrl: "https://api.croli.net/relay/api/deepseek/sk",
  },
};
