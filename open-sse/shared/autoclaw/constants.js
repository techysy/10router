// AutoClaw（智谱澳龙 / AutoGLM 桌面端）— wire constants, single source of truth.
//
// Reverse-engineered protocol, ported from hj01857655/AutoClaw2api
// (docs/dual-domain-protocol.md + internal/{oauth,lanes,account}, 2026-10-26
// field notes) and cross-checked against hubo1989/opencode-autoclaw-auth
// (index.mjs). NOT an official API — upstream can change it without notice.
//
// Two independent account systems, so two registry entries:
//
//   | provider     | login                              | account host              | chat host / path                                              |
//   |--------------|------------------------------------|---------------------------|---------------------------------------------------------------|
//   | autoclaw     | Google / z.ai web OAuth            | autoglm-api.autoglm.ai    | autoglm-api.autoglm.ai/autoclaw-proxy/proxy/autoclaw/v1/chat/completions |
//   | autoclaw-cn  | +86 phone SMS code (no OAuth link) | autoglm-api.zhipuai.cn    | autoglm-acceleration-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw/chat/completions (no /v1) |
//
// Tokens do NOT cross domains (intl token on the CN chat host → 401 and vice
// versa). The refresh/access JWT's `source_id` claim tells them apart:
// starts with "agent" = CN (SMS) account, anything else = intl OAuth account.
//
// Every call (account plane AND chat) carries the managed-layer signature
//   X-Auth-Appid / X-Auth-TimeStamp / X-Auth-Sign = md5(appId&ts&appKey)
// plus the client identity headers (X-Version / X-Tm / X-Product /
// X-Channel / X-Lang) and an EXPLICIT User-Agent — the upstream WAF answers a
// missing / library-default UA with 405 (Aliyun block page).

export const AUTOCLAW_APP_ID = "100003";
export const AUTOCLAW_APP_KEY = "38d2391985e2369a5fb8227d8e6cd5e5";
export const AUTOCLAW_PRODUCT = "autoclaw";
// Account-plane request bodies always carry source_id + device_id (the
// official client hard-codes them; missing device_id → 400001).
export const AUTOCLAW_SOURCE_ID = "autoclaw";

export const AUTOCLAW_GLOBAL_HOST = "https://autoglm-api.autoglm.ai";
export const AUTOCLAW_CN_HOST = "https://autoglm-api.zhipuai.cn";
// CN chat rides the desktop "managed" gateway — a third host.
export const AUTOCLAW_CN_CHAT_HOST = "https://autoglm-acceleration-api.zhipuai.cn";

export const AUTOCLAW_CHAT_URL_INTL = `${AUTOCLAW_GLOBAL_HOST}/autoclaw-proxy/proxy/autoclaw/v1/chat/completions`;
export const AUTOCLAW_CHAT_URL_CN = `${AUTOCLAW_CN_CHAT_HOST}/autoclaw-proxy/proxy/autoclaw/chat/completions`;

export const AUTOCLAW_PATHS = {
  oauthUrl: (vendor) => `/userapi/overseasv1/${vendor}-oauth-url`,
  oauthLogin: (vendor) => `/userapi/overseasv1/${vendor}-oauth-login`,
  captchaConfig: "/userapi/overseasv1/oauth-captcha-config",
  smsSend: "/userapi/v1/agent-send-code",
  // The trailing slash is part of the endpoint shape (without it → 404).
  smsLogin: "/userapi/v1/agent-login/",
  refresh: "/userapi/v1/refresh",
  refreshAlt: "/userapi/v1/agent-refresh",
  userProfile: "/userapi/v1/user-profile",
  wallets: `/agent-assetmgr/api/v2/wallets?biz_app_id=${AUTOCLAW_PRODUCT}`,
  // Task endpoints hang under /autoclaw-proxy/proxy/ as SIBLINGS of the chat
  // base (…/proxy/autoclaw/autoclaw-task-list is a 404).
  taskList: "/autoclaw-proxy/proxy/autoclaw-task-list",
  taskComplete: "/autoclaw-proxy/proxy/autoclaw-task-complete",
};

// Refresh: first hop /refresh; business code 400002 → second hop /agent-refresh.
export const AUTOCLAW_REFRESH_FALLBACK_CODE = 400002;
export const AUTOCLAW_DAILY_SIGNIN_TASK = "daily_signin";

// Region identity (doc table "双供应商 / 双域"). The gateways do not
// hard-check X-Channel today (AutoClaw2api saw "official" pass on both), but
// we send the values each official client sends.
export const AUTOCLAW_REGIONS = {
  intl: {
    providerId: "autoclaw",
    accountHost: AUTOCLAW_GLOBAL_HOST,
    chatUrl: AUTOCLAW_CHAT_URL_INTL,
    channel: "AutoClaw4",
    version: "1.18.1",
    agentId: null,
  },
  cn: {
    providerId: "autoclaw-cn",
    accountHost: AUTOCLAW_CN_HOST,
    chatUrl: AUTOCLAW_CHAT_URL_CN,
    channel: "AutoClaw26",
    version: "2.1.0",
    agentId: "main",
  },
};

// Intl web OAuth. The OAuth client only accepts navigate_uri values shaped
// http://localhost:<official TokenServer port>/auth/callback-<vendor>
// (random port / custom path → "Redirect URI not registered for this
// client"). Nothing listens there from the dashboard, so the user pastes
// the dead-page URL back (paste-callback, same shape as croli / junie).
export const AUTOCLAW_OAUTH_PORTS = [18432, 19654, 19723, 53699];
export const AUTOCLAW_OAUTH_VENDORS = ["google", "zai"];
export const AUTOCLAW_DEFAULT_VENDOR = "google";
// The authorize page must live on the vendor's own host (main.cjs
// isTrustedOAuthUrl) — handing a code to any other host leaks the account.
export const AUTOCLAW_OAUTH_HOSTS = {
  google: "accounts.google.com",
  zai: "chatglm.cn",
};
export function autoclawRedirectUri(vendor = AUTOCLAW_DEFAULT_VENDOR, port = AUTOCLAW_OAUTH_PORTS[0]) {
  return `http://localhost:${port}/auth/callback-${vendor}`;
}

// Models (route ids, prefix kept on the user-facing side and in
// X-Request-Model; the body `model` has the zai_/zaicoding_ prefix stripped).
// zai_glm-5-turbo and the tdpsk_deepseek-* rows were delisted upstream
// (calls answer 400 illegal model) — not listed.
export const AUTOCLAW_MODELS = [
  { id: "zai_auto", name: "AutoClaw Auto（自动路由）" },
  { id: "zai_auto-fast", name: "AutoClaw Auto Fast" },
  { id: "zai_glm-5.3-flash", name: "GLM-5.3 Flash（免费）" },
  { id: "zaicoding_glm-5.3", name: "GLM-5.3 Coding" },
];
export const AUTOCLAW_DEFAULT_MODEL = "zai_auto";
export const AUTOCLAW_CONTEXT_WINDOW = 1_000_000;
// Upstream reasoning variants are low / high / max only.
export const AUTOCLAW_REASONING_LEVELS = ["low", "high", "max"];

const PROVIDER_PREFIXES = ["zai", "zaicoding", "tdpsk", "zhipu"];

/** "zai_auto" → "auto"; anything without a known prefix is returned as-is. */
export function stripAutoclawModelPrefix(model) {
  const m = String(model || "");
  for (const sep of ["_", "-"]) {
    const i = m.indexOf(sep);
    if (i > 0 && PROVIDER_PREFIXES.includes(m.slice(0, i))) return m.slice(i + 1);
  }
  return m;
}

// ── Chat body constraints (2.x gateway) ─────────────────────────────────────
// The system prompt must contain the 2.x banner (containment match).
export const AUTOCLAW_BANNER = "You are AutoClaw. Answer the user directly and concisely.";
// max_tokens family → 406 with an EMPTY body (indistinguishable from other
// 406s), so they must never leave the gateway.
export const AUTOCLAW_FORBIDDEN_FIELDS = ["max_tokens", "max_completion_tokens", "max_output_tokens"];
// Fields the upstream does not accept; OpenAI clients commonly send them.
export const AUTOCLAW_STRIP_FIELDS = [
  "frequency_penalty", "presence_penalty", "logit_bias",
  "logprobs", "top_logprobs", "n", "seed", "user",
  "parallel_tool_calls", "store", "metadata", "service_tier",
];
// 2.x system-prompt denylist: case-insensitive substring → 406. Order is the
// replacement order (must match AutoClaw2api lanes.ForeignIdentityPhrases).
export const AUTOCLAW_FOREIGN_IDENTITY_PHRASES = [
  "you are claude code",
  "you are cursor",
  "you are cline",
  "you are codex",
  "you are qwen code",
  "you are opencode",
  "you are an interactive cli tool that helps users with software engineering tasks",
  "you are an interactive agent in traecode",
  "claude agent sdk",
];
export const AUTOCLAW_FOREIGN_IDENTITY_REPLACEMENT = "You are AutoClaw";
export const AUTOCLAW_FOREIGN_IDENTITY_REPLACEMENTS = { "claude agent sdk": "AutoClaw" };

export const AUTOCLAW_HTTP_TIMEOUT_MS = 20_000;
// Access JWTs live ~24h; refresh ahead.
export const AUTOCLAW_REFRESH_LEAD_MS = 10 * 60 * 1000;
export const AUTOCLAW_FALLBACK_EXPIRES_IN_S = 5 * 3600;

// Business codes → readable reason (AutoClaw2api oauth.businessCodes).
export const AUTOCLAW_BUSINESS_CODES = {
  400000: "登录已失效，请重新登录",
  400001: "请求参数缺失或格式不对",
  400002: "签名校验未通过",
  429: "操作太频繁，请稍后再试",
  630202: "验证码错误",
  630203: "操作太频繁，请稍后再试",
  630012: "账号最近注销过",
  631000: "登录失败（客户端身份头缺失）",
  631010: "不是该企业成员",
  631011: "企业已停用",
  631012: "企业服务不可用",
  631013: "企业不支持此操作",
  631014: "所在地区不支持",
  631015: "企业账号需先选择身份",
  631016: "身份凭证过期，请重新登录",
};

export const AUTOCLAW_CN_PHONE_RE = /^1[3-9]\d{9}$/;
