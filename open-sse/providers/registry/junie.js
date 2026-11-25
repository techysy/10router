// Junie (JetBrains) — the FREE Junie Lite lane only.
//
// Junie Lite is a standing free tier on every JetBrains account (no
// card, no subscription): one model slot whose backend JetBrains swaps
// without notice (docs say GPT-6 Luna; this account's CLI logs show
// Qwen/Qwen3.6-27B-FP8 — see shared/junie/constants.js). The lane is
// NOT reachable with the official JUNIE_API_KEY (perm- keys answer 403
// NO_LICENSE on free accounts); it needs the JBA OAuth login's
// **id_token** plus the Free-license headers the CLI itself sends.
//
// Sign-in is authorization-code + PKCE with the CLI's public client
// (junie-cli). The registered redirect is http://localhost:62345 —
// nothing serves it, so after approving, the user's browser lands on a
// dead localhost page and they paste the full address back into the
// dashboard (paste-callback, same shape as croli). The connection
// stores the id_token in the accessToken slot (it IS the inference
// credential) and the rotating refresh_token; refresh mints a fresh
// id_token (see tokenRefresh refreshJunieToken). Refresh tokens are
// single-use — the gateway must be the only refresher, so do not sign
// the same account into the Junie CLI elsewhere at the same time.
export default {
  id: "junie",
  priority: 37,
  alias: "junie",
  uiAlias: "junie",
  display: {
    name: "Junie (JetBrains)",
    icon: "smart_toy",
    color: "#7B61FF",
    textIcon: "JU",
    website: "https://junie.jetbrains.com",
    notice: {
      text: "Sign in with your own JetBrains account (a free account is enough) to use the free Junie Lite lane — one model for small tasks, served by JetBrains. Only sign in with your own account.",
      signupUrl: "https://junie.jetbrains.com/cli",
      apiKeyUrl: "https://junie.jetbrains.com/cli",
    },
  },
  category: "oauth",
  authModes: ["oauth"],
  hasOAuth: true,
  authHint: "用你自己的 JetBrains 账号登录（免费账号就行）：点登录、在打开的页面点批准，浏览器会跳到一个打不开的页面——把地址栏里那一整段地址复制回来，粘到下方框里点连接就行。",
  transport: {
    baseUrl: "https://ingrazzio-cloud-prod.labs.jb.gg/llm/vllm/v1/chat/completions",
    headers: {},
    timeoutMs: 120000,
  },
  // Static list — the lane has no /models endpoint. One slot only: the
  // executor maps this key to the current Lite backend model string
  // (shared/junie/constants.js JUNIE_UPSTREAM_MODEL).
  models: [
    { id: "junie-lite", name: "Junie Lite 免费车道" },
  ],
  oauth: {
    clientId: "junie-cli",
    authorizeUrl: "https://junie.jetbrains.com/cli-auth",
    tokenUrl: "https://oauth.account.jetbrains.com/oauth2/token",
    refreshUrl: "https://oauth.account.jetbrains.com/oauth2/token",
    scope: "offline_access openid jb-authn-service",
    codeChallengeMethod: "S256",
    redirectUri: "http://localhost:62345",
    refreshLeadMs: 5 * 60 * 1000,
  },
};
