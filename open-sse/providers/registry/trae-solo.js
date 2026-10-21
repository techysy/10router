// Trae SOLO provider registry entry — the tool-calling model port.
//
// Unlike `trae` (remote agent sessions: chat_sessions + events, flattened
// history, no tools), this entry drives the plain model endpoint
//   POST {base}/api/agent/v3/llm_utils_chat
// with `tools` / `tool_choice` forwarded. Credentials are the same
// Cloud-IDE-JWT login as `trae` (same OAuth flow, independent connection).
//
// The endpoint is CN-only today (Rust reference `providers/trae/mod.rs`), so
// the refresh path targets the CN edition and falls back to the legacy
// ExchangeToken for refresh tokens issued before DeviceProof existed.
export default {
  id: "trae-solo",
  alias: "trs",
  uiAlias: "trs",
  aliases: ["traesolo"],
  category: "oauth",
  authType: "oauth",
  hasOAuth: true,
  authModes: ["oauth"],
  display: {
    name: "Trae SOLO",
    icon: "bolt",
    color: "#FF6A00",
    textIcon: "TS",
    website: "https://www.trae.cn",
    notice: { signupUrl: "https://www.trae.cn" },
    // Same login split as `trae`: CN and intl accounts are not interchangeable.
    loginSites: {
      param: "region",
      default: "intl",
      options: [
        { value: "intl", label: "国际站", hint: "www.trae.ai · 海外账号" },
        { value: "cn", label: "国内站", hint: "www.trae.cn · 国内手机号 / 抖音账号" },
      ],
    },
  },
  transport: {
    // `llm_utils_chat` lives on the agent gateway, not the SOLO remote base.
    baseUrl: "https://trae-api-cn.mchost.guru",
    format: "openai",
    headers: {
      "X-App-Id": "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8",
      "X-Ide-Version": "0.1.61",
      "X-Ide-Version-Code": "20260820",
      "X-Device-Type": "windows",
      "Request-Traffic-Type": "prod",
    },
    // Auth: Cloud-IDE-JWT scheme on Authorization — injected by executor buildHeaders.
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "Cloud-IDE-JWT",
    },
    defaultRegion: "cn",
  },
  oauth: {
    // Login exchange stays on the legacy cloudide gateway (same as `trae`);
    // refresh only uses the new SOLO ExchangeToken when a device key is present.
    clientId: "ono9krqynydwx5",
    clientSecret: "-",
    platform: "trae",
    pollInterval: 1500,
    loginGuidanceUrl: "https://api.marscode.com/cloudide/api/v3/trae/GetLoginGuidance",
    tokenUrl: "https://api.marscode.com/cloudide/api/v3/trae/oauth/ExchangeToken",
    exchangeTokenUrl: "https://api.marscode.com/cloudide/api/v3/trae/oauth/ExchangeToken",
    // Per-edition SOLO endpoint (DeviceProof, ECDSA P-256). Host is chosen from
    // providerSpecificData.site at refresh time.
    refreshUrl: "https://api.trae.cn/trae/api/v3/oauth/ExchangeToken",
    userInfoUrl: "https://api.marscode.com/cloudide/api/v3/trae/GetUserInfo",
    refresh: { encoding: "json" },
  },
  // Model catalog: the current `trae` model list (the session modes
  // `auto`/`work` are deliberately absent — `llm_utils_chat` takes a config
  // name, not a SOLO session mode) plus the Rust reference's default config.
  models: [
    { id: "glm-5.2", name: "GLM 5.2" },
    { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
    { id: "gemini-3-flash-solo", name: "Gemini 3 Flash" },
    { id: "minimax-m3", name: "MiniMax M3" },
    { id: "minimax-m2.7", name: "MiniMax M2.7" },
    { id: "kimi-k2.5", name: "Kimi K2.5" },
    { id: "gpt-5.4", name: "GPT 5.4" },
    { id: "gpt-5.2", name: "GPT 5.2" },
  ],
  // Usage endpoint not verified for this channel yet — keep the card off.
  features: { usage: false },
};
