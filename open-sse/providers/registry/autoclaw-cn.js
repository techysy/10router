// AutoClaw 国内版（智谱澳龙，+86 手机号账号）。
//
// Same product as `autoclaw`, separate account system: there is NO OAuth
// link on the CN side — sign-in is the two-step phone SMS API on
// autoglm-api.zhipuai.cn (agent-send-code → agent-login/, the code must be
// sent as a JSON number), driven by the dashboard's AutoclawSmsModal
// (Loomy / Capy two-step shape). Chat rides the desktop "managed" gateway
// autoglm-acceleration-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw/chat/completions
// (no /v1). Refresh is shared with the intl entry (host order follows the
// refresh JWT's source_id). Unofficial reverse-engineered API.
import { AUTOCLAW_MODELS, AUTOCLAW_CHAT_URL_CN, AUTOCLAW_REFRESH_LEAD_MS } from "../../shared/autoclaw/constants.js";

export default {
  id: "autoclaw-cn",
  priority: 39,
  alias: "autoclaw-cn",
  uiAlias: "autoclaw-cn",
  display: {
    name: "AutoClaw CN",
    icon: "smart_toy",
    color: "#1D4ED8",
    textIcon: "AC",
    website: "https://autoglm.zhipuai.cn",
    notice: {
      text: "Sign in with your own AutoClaw (智谱澳龙) China account using a +86 phone verification code. Unofficial reverse-engineered desktop API — accounts may be restricted; do not keep the AutoClaw desktop app signed in to the same account while 10Router uses it.",
      signupUrl: "https://autoglm.zhipuai.cn",
    },
  },
  category: "oauth",
  authModes: ["oauth"],
  hasOAuth: true,
  transport: {
    baseUrl: AUTOCLAW_CHAT_URL_CN,
    headers: {},
    timeoutMs: 120000,
  },
  models: AUTOCLAW_MODELS.map((m) => ({ ...m })),
  passthroughModels: true,
  features: {
    usage: true,
  },
  oauth: {
    accountBaseUrl: "https://autoglm-api.zhipuai.cn",
    refreshUrl: "https://autoglm-api.zhipuai.cn/userapi/v1/refresh",
    refreshLeadMs: AUTOCLAW_REFRESH_LEAD_MS,
  },
};
