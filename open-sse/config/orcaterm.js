export const ORCATERM_CONFIG = {
  origin: "https://orcaterm.com",
  wechatConfigUrl: "https://orcaterm.com/oauth/wechat/config",
  exchangeUrl: "https://orcaterm.com/oauth/wechat/exchange",
  refreshUrl: "https://orcaterm.com/cgi/api?action=OAuthRefreshToken",
  apiUrl: "https://orcaterm.com/cgi/api",
  // Desktop sign-in: browser authorize page + PKCE, redeemed with OAuthExchangeToken.
  // Unlike the embedded web widget, this grant carries a distinct refresh token.
  authorizeUrl: "https://orcaterm.com/oauth/authorize",
  desktopReturnUrl: "orcaterm://oauth_callback",
  bridgeUrl: "https://orcaterm.com/oauth/wechat/bridge",
  wechatSdkUrl: "https://res.wx.qq.com/connect/zh_CN/htmledition/js/wxLogin.js",
  chatUrl: "https://lightai.cloud.tencent.com/assistant/chat?name=orcaterm&mode=0&csrfCode=&sseresume=true",
  product: "orcaterm",
  loginTtlMs: 5 * 60 * 1000,
  loginBodyMaxBytes: 8 * 1024,
  maxAuthorizeRequests: 20,
  authorizeWindowMs: 10 * 60 * 1000,
  maxInFlightLoginRequests: 4,
  tokenLifetimeSeconds: 7200,
  requestTimeoutMs: 20000,
  chatConnectTimeoutMs: 60000,
  maxOutputTokens: 8096,
  maxResponseChars: 2 * 1024 * 1024,
  toolNamespace: "10router-tools",
  pendingToolTtlMs: 10 * 60 * 1000,
  maxPendingTools: 256,
  maxImages: 4,
  maxImageBytes: 10 * 1024 * 1024,
  maxTotalImageBytes: 20 * 1024 * 1024,
};

// Only models exposed by OrcaTerm's selector; this is not an unrestricted TokenHub proxy.
export const ORCATERM_MODELS = [
  { id: "TokenHub/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", vision: true },
  { id: "TokenHub/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
  { id: "TokenHub/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
  { id: "TokenHub/kimi-k3", name: "Kimi K3", vision: true },
  { id: "TokenHub/glm-5.3-flash", name: "GLM 5.3 Flash" },
  { id: "TokenHub/glm-5.3", name: "GLM 5.3" },
  { id: "TokenHub/glm-5.2", name: "GLM 5.2" },
  { id: "Hunyuan3/hy3", name: "Hunyuan 3" },
];
