/**
 * OAuth Configuration Constants — static data lives in registry, re-exported here for consumers.
 */
import { platform, arch } from "os";
import { ANTIGRAVITY_OAUTH_CLIENT, GOOGLE_OAUTH_CLIENT } from "open-sse/providers/shared.js";
import { PROVIDER_OAUTH, PROVIDERS as REGISTRY_PROVIDERS } from "open-sse/providers/index.js";

/**
 * Get the platform enum value based on the current OS.
 * Matches Antigravity binary's ClientMetadata.Platform enum.
 */
function getOAuthPlatformEnum() {
  const os = platform();
  const architecture = arch();
  if (os === "darwin") return architecture === "arm64" ? 2 : 1;
  if (os === "linux") return architecture === "arm64" ? 4 : 3;
  if (os === "win32") return 5;
  return 0;
}

// Claude OAuth Configuration (Authorization Code Flow with PKCE)
export const CLAUDE_CONFIG = { ...PROVIDER_OAUTH["claude"] };

// Codex (OpenAI) OAuth Configuration (Authorization Code Flow with PKCE)
export const CODEX_CONFIG = { ...PROVIDER_OAUTH["codex"] };

// Gemini (Google) OAuth Configuration (Standard OAuth2)
// clientId/clientSecret from GOOGLE_OAUTH_CLIENT (shared.js) — not stored in registry
export const GEMINI_CONFIG = { ...GOOGLE_OAUTH_CLIENT, ...PROVIDER_OAUTH["gemini-cli"] };

// Qoder OAuth Configuration (Device Token Flow with PKCE).
// Device tokens are long-lived (~30 days for access, ~360 for refresh).
// The upstream refresh endpoint at center.qoder.sh returns 403 for our
// flow — we accept that and surface it to the user as "re-login" instead
// of attempting to silently rotate.
export const QODER_CONFIG = { ...PROVIDER_OAUTH["qoder"] };

// iFlow OAuth Configuration (Authorization Code)
export const IFLOW_CONFIG = { ...PROVIDER_OAUTH["iflow"] };

// Antigravity OAuth Configuration (Standard OAuth2 with Google)
// clientId/clientSecret from ANTIGRAVITY_OAUTH_CLIENT (shared.js) — not stored in registry
// loadCodeAssistClientMetadata is dynamic (runtime platform detection)
export const ANTIGRAVITY_CONFIG = {
  ...ANTIGRAVITY_OAUTH_CLIENT,
  ...PROVIDER_OAUTH["antigravity"],
  loadCodeAssistClientMetadata: JSON.stringify({ ideType: 9, platform: getOAuthPlatformEnum(), pluginType: 2 }),
};

/**
 * Get client metadata using numeric enum values for API calls.
 * @returns {{ ideType: number, platform: number, pluginType: number }}
 */
export function getOAuthClientMetadata() {
  return { ideType: 9, platform: getOAuthPlatformEnum(), pluginType: 2 };
}

// OpenAI OAuth Configuration (Authorization Code Flow with PKCE)
export const OPENAI_CONFIG = { ...PROVIDER_OAUTH["openai"] };

// GitHub Copilot OAuth Configuration (Device Code Flow)
export const GITHUB_CONFIG = { ...PROVIDER_OAUTH["github"] };

// Kiro OAuth Configuration (multi-method: AWS Builder ID / IDC / Social / Import Token)
export const KIRO_CONFIG = { ...PROVIDER_OAUTH["kiro"] };

// AWS region allowlist pattern — prevents SSRF via region injection into upstream URLs (GHSA-6mwv-4mrm-5p3m)
export const AWS_REGION_PATTERN = /^[a-z]{2}-[a-z]+-\d{1,2}$/;

// Reject any region that is not a valid AWS region before interpolating it into a URL
export function assertValidAwsRegion(region) {
  if (typeof region !== "string" || !AWS_REGION_PATTERN.test(region)) {
    throw new Error("Invalid region");
  }
  return region;
}

// Cursor OAuth Configuration (Import Token from Cursor IDE)
// tokenStoragePaths: user-reference only, not stored in registry
export const CURSOR_CONFIG = {
  ...PROVIDER_OAUTH["cursor"],
  tokenStoragePaths: {
    linux: "~/.config/Cursor/User/globalStorage/state.vscdb",
    macos: "/Users/<user>/Library/Application Support/Cursor/User/globalStorage/state.vscdb",
    windows: "%APPDATA%\\Cursor\\User\\globalStorage\\state.vscdb",
  },
};

// Kimi Code OAuth (Device Code Flow) — merged into provider id `kimi` (dual auth)
// clientId: registry first, env override for forks
export const KIMI_CONFIG = {
  ...PROVIDER_OAUTH["kimi"],
  clientId:
    process.env.KIMI_CODING_OAUTH_CLIENT_ID ||
    process.env.KIMI_OAUTH_CLIENT_ID ||
    REGISTRY_PROVIDERS["kimi"]?.clientId ||
    PROVIDER_OAUTH["kimi"]?.clientId,
};
// Back-compat alias for any remaining KIMI_CODING_CONFIG imports
export const KIMI_CODING_CONFIG = KIMI_CONFIG;

// KiloCode OAuth Configuration (Custom Device Auth Flow)
export const KILOCODE_CONFIG = { ...PROVIDER_OAUTH["kilocode"] };

// Cline OAuth Configuration (Local Callback Flow via app.cline.bot)
export const CLINE_CONFIG = { ...PROVIDER_OAUTH["cline"] };

// ClinePass OAuth Configuration (shares Cline's OAuth endpoints)
export const CLINEPASS_CONFIG = { ...PROVIDER_OAUTH["clinepass"] };

// GitLab Duo OAuth Configuration (Authorization Code Flow with PKCE)
export const GITLAB_CONFIG = { ...PROVIDER_OAUTH["gitlab"] };

// CodeBuddy (Tencent) OAuth Configuration (Browser OAuth Polling Flow)
export const CODEBUDDY_CONFIG = { ...PROVIDER_OAUTH["codebuddy-cn"] };

// CodeBuddy International — same shape as CN, .ai domain (mirror of codebuddy-cn).
export const CODEBUDDY_INTL_CONFIG = { ...PROVIDER_OAUTH["codebuddy-intl"] };

// Kimchi OAuth Configuration (Browser token callback flow)
export const KIMCHI_CONFIG = { ...PROVIDER_OAUTH["kimchi"] };

// Grok CLI / Grok Build OAuth Configuration (Device Code Flow)
// Endpoint: cli-chat-proxy.grok.com — same client_id as xai, different flow + scopes
export const GROK_CLI_CONFIG = { ...PROVIDER_OAUTH["grok-cli"] };

// Trae (ByteDance marscode) OAuth — authorization_code flow with local callback.
//   1) POST GetLoginGuidance {loginTraceID} → {Result.LoginHost}
//   2) Browser opens ${loginHost}/authorization?client_id=...&login_trace_id=...&auth_callback_url=${cb}
//   3) Redirect → ${cb}?refreshToken=...&loginHost=...&isRedirect=true
//   4) POST ExchangeToken {ClientID, RefreshToken, ClientSecret:"-"} → {Result.AccessToken, ExpiresAt}
//   5) POST GetUserInfo (x-cloudide-token) → email/name
// Xiaomi MiMo Desktop OAuth — custom ECDH encrypted-callback flow (NOT standard OAuth2).
//   1) Client generates X25519 keypair
//   2) Browser opens ${platformUrl}/authorize?pk=<pubkey>&redirect_uri=http://localhost:<port>/&kn=mimocode&key_name=...
//   3) Redirect → http://localhost:<port>/?u=<base64 encrypted payload>
//   4) Decrypt: ECDH(shared) → SHA256 → AES-256-GCM
//      Layout: [12-byte nonce][32-byte ephemeral pubkey][ciphertext][16-byte GCM tag]
//   5) Result JSON: { uid, sk, url }
export const XIAOMI_MIMO_CONFIG = {
  platformUrl: process.env.MIMO_PLATFORM_URL || "https://platform.xiaomimimo.com",
  defaultBaseUrl: "https://api.xiaomimimo.com/v1",
  kn: "mimocode",
  // Identifies us as the MiMo client to the platform. The official builder always
  // sends it; without it the platform mints the authorization code for a different
  // client, so the blob it hands back cannot be decrypted by the key we registered.
  app: "MiMo",
  timeoutMs: 300000, // 5 minutes — how long the local callback listener waits
  // How long a pending private key stays usable for a PASTED authorization code.
  // The platform's code page makes the user copy the code by hand, so the local
  // 5-minute window is far too short; MiMo Desktop keeps its own pending keys for
  // 24 h for exactly this reason (pendingKeyTtlMs in its login engine).
  pendingTtlMs: 24 * 60 * 60 * 1000,
};

// Trae — two independent ecosystems that share the same cloudide API shape but
// NOT the same credentials. A refresh token minted on the CN site is rejected
// by the intl hosts (and vice versa, Error 20101 "refresh token is invalid"),
// so every call has to know which side the user signed in on.
//   intl: www.trae.ai    — api.marscode.com / api.trae.ai / www.trae.ai
//   cn:   www.trae.cn    — api.trae.com.cn / api.marscode.cn / api.trae.cn
// The CN origins below are the ones the official www.trae.cn web build calls
// (its bundle exports API_CN = https://api.trae.com.cn and gets LoginHost
// www.trae.cn); all four answer GetLoginGuidance / ExchangeToken / GetUserInfo.
// Kept as an ordered list so a retired host can be dropped without touching the
// provider logic — each entry is tried in turn.
export const TRAE_CONFIG = {
  clientId: "ono9krqynydwx5",
  clientSecret: "-",
  loginGuidanceUrls: [
    "https://api.marscode.com/cloudide/api/v3/trae/GetLoginGuidance",
    "https://api.trae.ai/cloudide/api/v3/trae/GetLoginGuidance",
    "https://www.trae.ai/cloudide/api/v3/trae/GetLoginGuidance",
  ],
  // 国际账号面（cloudide 族：旧 ExchangeToken 刷新 + GetUserInfo）host 已换代
  // （#99 情报一/二）：api.trae.ai 的 pay/ent 已 404（trae2api-hub 实测 2026-10-19），
  // USTTP（US）账号只认 grow-normal.traeapi.us。顺序 = 尝试顺序，新 host 优先，
  // 老 marscode/trae.ai 保留兜底（存量老账号仍走它们）。
  apiOrigins: [
    "https://grow-normal.trae.ai",
    "https://grow-normal.traeapi.us",
    "https://api.marscode.com",
    "https://api.trae.ai",
    "https://www.trae.ai",
    "https://www.marscode.com",
  ],
  // ── 新版授权（AuthCode + PKCE，muskke/trae-api-proxy v0.5 考古）──
  // 官方客户端升级为 PKCE 授权码流：authorize URL 带 code_challenge（S256），
  // 回调回 AuthCode（或 authCodeInfo JSON），用 v3 换票端点 + DeviceInfo 换
  // access/refresh。旧 refreshToken 回调 + /cloudide/.../ExchangeToken 仍活着，
  // 作为兼容路径保留（社区至今用它做 refresh）。
  authCodeExchangePath: "/trae/api/v3/oauth/ExchangeToken",
  // v3 AuthCode 换票 host（muskke authCodeAPIHosts）。USTTP userTag 的账号
  // 只认 grow-normal.traeapi.us，其余国际账号走 growsg/grow-normal.trae.ai。
  authCodeOrigins: [
    "https://growsg-normal.trae.ai",
    "https://grow-normal.trae.ai",
    "https://grow-normal.traeapi.us",
  ],
  cnAuthCodeOrigins: [
    "https://api.trae.cn",
    "https://api.trae.com.cn",
  ],
  // ── CN (trae.cn) ──────────────────────────────────────────────────────────
  cnLoginGuidanceUrls: [
    "https://api.trae.com.cn/cloudide/api/v3/trae/GetLoginGuidance",
    "https://api.marscode.cn/cloudide/api/v3/trae/GetLoginGuidance",
    "https://api.trae.cn/cloudide/api/v3/trae/GetLoginGuidance",
  ],
  cnApiOrigins: [
    "https://api.trae.com.cn",
    "https://api.marscode.cn",
    "https://api.trae.cn",
  ],
  // Hosts that only ever appear on the intl side — used to tell the two apart
  // when all we have is a pasted callback / an already-stored loginHost.
  // traeapi.us = 国际站新一代生成域名族（USTTP 账号面，#99）。
  intlHostSuffixes: ["trae.ai", "marscode.com", "traeapi.us"],
  cnHostSuffixes: ["trae.cn", "trae.com.cn", "marscode.cn"],
  // Done-card web console, one per ecosystem (accounts don't cross over).
  consoleUrl: "https://www.trae.ai/settings",
  cnConsoleUrl: "https://www.trae.cn/settings",
  exchangeTokenPath: "/cloudide/api/v3/trae/oauth/ExchangeToken",
  getUserInfoPath: "/cloudide/api/v3/trae/GetUserInfo",
  authorizationPath: "/authorization",
  callbackPath: "/callback",
  minAppVersion: "3.5.54",
  defaultAppVersion: "3.5.54",
  defaultAppType: "stable",
  defaultPluginVersion: "local",
  // service machine id is derived at runtime; device_id "0" is the stable default
  defaultDeviceId: "0",
  userAgent: "Trae/1.0.0 antigravity-cockpit-tools",
  webUrl: "https://www.trae.ai",
  authScheme: "Cloud-IDE-JWT",
  tokenLifetimeDays: 14,
  oauthTimeoutMs: 600_000,
};

// Windsurf / Devin CLI OAuth — authorization_code (implicit) flow with local callback.
//   1) Browser opens windsurf.com/windsurf/signin?response_type=token&client_id=...&redirect_uri=${cb}
//   2) Redirect → ${cb}?access_token=${firebaseJWT}&state=...
//   3) POST RegisterUser {firebase_id_token} → {apiKey, apiServerUrl, name}
//   4) POST GetOneTimeAuthToken → GetCurrentUser (best-effort email/plan)
export const WINDSURF_CONFIG = {
  clientId: "3GUryQ7ldAeKEuD2obYnppsnmj58eP5u",
  authBaseUrl: "https://www.windsurf.com",
  signInPath: "/windsurf/signin",
  registerApiBaseUrl: "https://register.windsurf.com",
  registerPath: "/exa.seat_management_pb.SeatManagementService/RegisterUser",
  oneTimeAuthPath: "/exa.seat_management_pb.SeatManagementService/GetOneTimeAuthToken",
  currentUserPath: "/exa.seat_management_pb.SeatManagementService/GetCurrentUser",
  planStatusPath: "/exa.seat_management_pb.SeatManagementService/GetPlanStatus",
  userStatusPath: "/exa.seat_management_pb.SeatManagementService/GetUserStatus",
  defaultApiServerUrl: "https://server.codeium.com",
  firebaseApiKey: "AIzaSyDsOl-1XpT5err0Tcn0TFFod1H8gVGIycY",
  callbackPath: "/windsurf-auth-callback",
  userAgent: "antigravity-cockpit-tools",
  oauthTimeoutMs: 600_000,
};

// Zai GLM Coding OAuth — ZCode CLI 轮询流程（非 PKCE）：init 签发一次性 poll
// token，浏览器打开服务端生成的 authorize_url，poll/ready 返回 token；随后
// Z.AI OAuth token 换平台业务 JWT，再换长期 coding-plan API key（无 refresh
// 授权，到期重新登录）。
export const GLM_OAUTH_CONFIG = { ...PROVIDER_OAUTH["glm"] };

// Muse —— 订阅型 device code 流程打到 auth.meta.com，无 refresh（Meta 拒绝
// refresh_token 授权；铸造的 Model API key 不过期，401 只能重新登录）。
export const MUSE_CONFIG = { ...PROVIDER_OAUTH["muse"] };

// MiniMax Code (Device Code Flow)
export const MINIMAX_CODE_CONFIG = { ...PROVIDER_OAUTH["minimax-code"] };
export const MINIMAX_CODE_GLOBAL_CONFIG = { ...PROVIDER_OAUTH["minimax-code-global"] };

// Zed hosted LLM aggregator — RSA keypair native-app auth (NOT OAuth).
// Client generates ephemeral RSA-2048 keypair; user signs in at zed.dev/native_app_signin;
// Zed redirects to local callback with access_token RSA-encrypted against our public key.
// See open-sse/shared/zedAuth.js for the keypair/decrypt helpers.
export const ZED_HOSTED_CONFIG = {
  webBaseUrl: "https://zed.dev",
  cloudBaseUrl: "https://cloud.zed.dev",
  llmBaseUrl: "https://cloud.zed.dev",
  defaultNativeAppPort: 58443,
  oauthTimeoutMs: 600_000,
};

// OAuth timeout (5 minutes)
export const OAUTH_TIMEOUT = 300000;

// Provider list
export const PROVIDERS = {
  CLAUDE: "claude",
  CODEX: "codex",
  GEMINI: "gemini-cli",
  QODER: "qoder",
  IFLOW: "iflow",
  ANTIGRAVITY: "antigravity",
  OPENAI: "openai",
  GITHUB: "github",
  KIRO: "kiro",
  CURSOR: "cursor",
  KIMI: "kimi",
  KIMI_CODING: "kimi",
  KILOCODE: "kilocode",
  CLINE: "cline",
  CLINEPASS: "clinepass",
  GITLAB: "gitlab",
  CODEBUDDY: "codebuddy-cn",
  CODEBUDDY_INTL: "codebuddy-intl",
  KIMCHI: "kimchi",
  GROK_CLI: "grok-cli",
  TRAE: "trae",
  WINDSURF: "windsurf",
  GLM: "glm",
  MUSE: "muse",
  ZED: "zed",
  MINIMAX_CODE: "minimax-code",
  MINIMAX_CODE_GLOBAL: "minimax-code-global",
};
