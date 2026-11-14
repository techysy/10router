export default {
  id: "meoo",
  priority: 32,
  alias: "meoo",
  uiAlias: "meoo",
  display: {
    name: "Meoo 秒悟",
    icon: "auto_awesome",
    color: "#6C5CE7",
    website: "https://meoo.com",
    notice: {
      // 聊天 AK 按项目签发（api.meoo.host 401「项目服务 AK 格式非法」的头号
      // 原因：账号下没有任何项目）。指引直接写在供应商页顶部提示条上，
      // 用户不用翻日志 —— 2026-11-15 真机踩坑后用户点名要上页面。
      text: "Meoo chat needs a project service AK — create at least one project on meoo.com (cloud services on) first. Once it exists, the AK is picked up automatically; until then chat returns 401 while balance and check-in keep working.",
      signupUrl: "https://meoo.com",
      apiKeyUrl: "https://meoo.com/?inviteCode=ycDdBjLV",
    },
  },
  category: "oauth",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  // Meoo's production OAuth app only registers the CLI's loopback
  // redirect_uri — a dashboard-initiated login ALWAYS dies with
  // invalid_redirect_uri (2026-11-14/15 真机两踩). The login therefore
  // happens inside CreditDaddy and syncs over (creditDaddySync), or the
  // user pastes the control-plane key. authModes keeps "oauth" so
  // CD-pushed OAuth-token connections still refresh/transfer.
  oauthLoginHidden: true,
  // API-key mode takes a PROJECT service AK (meoo_project_service_v1.…),
  // issued per project by the control plane — not the meoo_ak_ control key
  // and not an OAuth token (both are rejected by the gateway with 401).
  authHint: "项目服务 AK (meoo_project_service_v1....) — 在 Meoo 项目的云服务环境中获取，或粘贴控制面 Key 自动解析；登录授权走 CreditDaddy 同步",
  transport: {
    baseUrl: "https://api.meoo.host/meoo-ai/compatible-mode/v1/chat/completions",
    validateUrl: "https://api.meoo.host/meoo-ai/compatible-mode/v1/models",
    headers: {},
    timeoutMs: 120000,
  },
  // Live catalog: GET /models on the gateway (Bearer = project AK) returns
  // bare ids; open-sse/services/meooModels.js merges specs + handles AK
  // re-resolution, and /v1/models prefers it over the static list below.
  modelsFetcher: { url: "https://api.meoo.host/meoo-ai/compatible-mode/v1/models", type: "openai" },
  // Usage = the control-plane points ledger. API-key (paste-key)
  // connections read it with the stored control key, so the usage route
  // must admit them alongside OAuth connections (USAGE_APIKEY_PROVIDERS
  // derives from this flag).
  features: {
    usage: true,
    usageApikey: true,
  },
  passthroughModels: true,
  models: [
    { id: "qwen3.8-max", name: "Qwen3.8-Max" },
    { id: "qwen3.8-flash", name: "Qwen3.8-Flash" },
    { id: "qwen4-max-preview", name: "Qwen4-Max-Preview" },
    { id: "qwen3.7-max", name: "Qwen3.7-Max" },
    { id: "qwen3.7-plus", name: "Qwen3.7-Plus" },
    { id: "deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash" },
    { id: "deepseek-v4-pro-0813", name: "DeepSeek V4 Pro" },
    { id: "deepseek-v4-flash-0731", name: "DeepSeek V4 Flash" },
    { id: "glm-5.2", name: "GLM-5.2" },
    { id: "glm-5.2-fast-preview", name: "GLM-5.2-Fast" },
  ],
  oauth: {
    // Public OAuth client shipped inside the official CLI
    // (@aliyun-meoo/cli, dist/lib/oauth.js): no secret, PKCE S256,
    // scope "cli.compat". resolveMeooCliClientId picks prod vs test by
    // API hostname; the gateway only ever talks to the production host.
    clientId: "meoo_app_tdWlRbpvAxN1EjmZ8XICxdTh",
    testClientId: "meoo_app_SFNvmHUFNePxyyfGjCd9hyaE",
    authorizeUrl: "https://meoo.com/oauth/authorize",
    tokenUrl: "https://meoo.com/oauth/token",
    refreshUrl: "https://meoo.com/oauth/token",
    revokeUrl: "https://meoo.com/oauth/revoke",
    scope: "cli.compat",
    codeChallengeMethod: "S256",
    refresh: { encoding: "form" },
    apiBaseUrl: "https://meoo.com",
    gatewayBaseUrl: "https://api.meoo.host/meoo-ai/compatible-mode/v1",
    userInfoUrl: "https://meoo.com/open/v1/cli-compat/account/identity",
    pointsUrl: "https://meoo.com/open/v1/cli-compat/account/points",
  },
};
