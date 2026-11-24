// AutoClaw 国际版（智谱澳龙 / AutoGLM 桌面端，Google / z.ai 账号）。
//
// Unofficial, reverse-engineered desktop protocol (ported from
// hj01857655/AutoClaw2api + hubo1989/opencode-autoclaw-auth — see
// shared/autoclaw/constants.js for the wire facts and their sources).
//
// Sign-in is the account plane's web OAuth (dashboard AutoclawOAuthModal +
// /api/oauth/autoclaw/* routes, not the generic OAuthModal):
//   POST autoglm-api.autoglm.ai/userapi/overseasv1/{google|zai}-oauth-url
//        { source_id, device_id, navigate_uri, ali_captcha_verify_param }
//        → authorize URL (carries state). The Aliyun slider captcha is ON
//        upstream, so the receipt is produced in the user's browser first.
//   POST …/{vendor}-oauth-login { code, state, navigate_uri } → token pair
// navigate_uri must be the official TokenServer loopback shape
// http://localhost:18432/auth/callback-<vendor>; nothing listens there from
// the dashboard, so the user pastes the dead-page URL back (paste-callback,
// croli / junie shape). If the AutoClaw desktop app is running it owns
// 18432 and swallows the callback — quit it before signing in.
//
// Credentials: accessToken = account JWT (~24h), refreshToken = rotating
// refresh JWT (treated as single-use: the gateway must be the only
// refresher — do not keep the desktop client signed in to the same account).
// Chat: autoglm-api.autoglm.ai/autoclaw-proxy/proxy/autoclaw/v1/chat/completions,
// OpenAI-compatible after AutoclawExecutor's body shaping.
import { AUTOCLAW_MODELS, AUTOCLAW_CHAT_URL_INTL, AUTOCLAW_REFRESH_LEAD_MS } from "../../shared/autoclaw/constants.js";

export default {
  id: "autoclaw",
  priority: 38,
  alias: "autoclaw",
  uiAlias: "autoclaw",
  display: {
    name: "AutoClaw",
    icon: "smart_toy",
    color: "#2563EB",
    textIcon: "AC",
    website: "https://autoglm.ai",
    notice: {
      text: "Sign in with your own AutoClaw (Zhipu AutoGLM) international account (Google or z.ai). Unofficial reverse-engineered desktop API — accounts may be restricted; do not keep the AutoClaw desktop app signed in to the same account while 10Router uses it.",
      signupUrl: "https://autoglm.ai",
    },
  },
  category: "oauth",
  authModes: ["oauth"],
  hasOAuth: true,
  authHint: "用你自己的 AutoClaw 国际版账号登录：先退出 AutoClaw 桌面端，点登录、完成滑块验证、在打开的 Google / z.ai 页面授权，浏览器会跳到一个打不开的 localhost:18432 页面——把地址栏里那一整段地址复制回来，粘到弹窗里点连接就行。",
  transport: {
    baseUrl: AUTOCLAW_CHAT_URL_INTL,
    headers: {},
    timeoutMs: 120000,
  },
  models: AUTOCLAW_MODELS.map((m) => ({ ...m })),
  passthroughModels: true,
  features: {
    usage: true,
  },
  oauth: {
    accountBaseUrl: "https://autoglm-api.autoglm.ai",
    redirectUri: "http://localhost:18432/auth/callback-google",
    refreshUrl: "https://autoglm-api.autoglm.ai/userapi/v1/refresh",
    refreshLeadMs: AUTOCLAW_REFRESH_LEAD_MS,
  },
};
