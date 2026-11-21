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
// Daily check-in is an explicit task-center action. Conversation progress is
// reported only for user-initiated chats that complete successfully; the
// scheduler never creates a model request to manufacture a task event.
//
// 邀请码池（用户 2026-11-20 提供，5 条）：注册引导链接每次读取随机取一条，
// 让新账号归因分散到不同码——与 CD 站点表 loginUrls 池同口径。getter 在
// provider 信息被 JSON 序列化（面板 API）时求值一次，即每次页面加载换一条。
// 已注册账号的专属邀请码另由 credits 面板经 inviteCodeUrl 实时生成。
const CROLI_INVITE_LINKS = [
  "https://www.croli.net/invite/?code=IKJCPA1SVP",
  "https://www.croli.net/invite/?code=2TELUWKZ2V",
  "https://www.croli.net/invite/?code=WQ93WZ2KZS",
  "https://www.croli.net/invite/?code=93YYUQAF3W",
  "https://www.croli.net/invite/?code=FNRPRGUUQL",
];
const pickInviteLink = () => CROLI_INVITE_LINKS[Math.floor(Math.random() * CROLI_INVITE_LINKS.length)];
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
      text: "Croli connections sign in via Clerk (Google / GitHub / email) with the paste-callback flow. Daily check-in (+100) and chat rewards are managed from the account page's Croli credits panel, which also shows balance, ledger, and this account's invite link.",
      signupUrl: "https://croli.net",
      get apiKeyUrl() {
        return pickInviteLink();
      },
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
    // Signed-in accounts expose a per-account relay resource (inference base +
    // key + model catalog); the global /models list can be wider than the
    // account's actual resource, so both sides must permit a model.
    resourceUrl: "https://api.croli.net/relay/api/relay/search",
    resourceId: "deepseek-free-pool",
    inferenceBaseUrl: "https://ds.croli.net/v1",
    // Credits APIs are separate from the inference gateway.
    creditsBaseUrl: "https://ds.croli.net/credits",
    balanceUrl: "https://ds.croli.net/credits/v1/account/balance",
    bootstrapUrl: "https://ds.croli.net/credits/v1/account/bootstrap",
    opsHomeUrl: "https://ds.croli.net/credits/v1/ops/home",
    checkinUrl: "https://ds.croli.net/credits/v1/ops/checkin",
    eventsUrl: "https://ds.croli.net/credits/v1/ops/events",
    inviteCodeUrl: "https://ds.croli.net/credits/v1/invite/code",
    ledgerUrl: "https://ds.croli.net/credits/v1/account/ledger?limit=100",
    skClaimUrl: "https://api.croli.net/relay/api/deepseek/sk",
    // 签名账号的资源目录（provisioning 前置）与 credits 账户端点
    resourceUrl: "https://api.croli.net/relay/api/relay/search",
    bootstrapUrl: "https://ds.croli.net/credits/v1/account/bootstrap",
    opsHomeUrl: "https://ds.croli.net/credits/v1/ops/home",
    balanceUrl: "https://ds.croli.net/credits/v1/account/balance",
  },
};
