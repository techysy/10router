// AtomCode (AtomGit / GitCode CodingPlan) — upstream planes and protocol
// constants. Single source for the executor, OAuth flow, usage and check-in.
//
// Three planes, three hosts (do not mix them):
//   sign-in broker   https://acs.atomgit.com
//   CodingPlan REST  https://api.gitcode.com/api/v5
//   chat gateway     https://api-ai.gitcode.com/v1
//
// The official CLI defaults its chat gateway to https://llm-api.atomgit.com/v1,
// which demands a closed-source request signature. api-ai.gitcode.com is the
// first-party gateway the official CLI recognises as unsigned (same OAuth
// bearer, same models) — our transport points there on purpose. The models-v2
// catalogue's per-entry `base_url` also names the signed host; it is display
// data only and must never replace this base URL.

const trimBase = (value, fallback) => {
  const trimmed = typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
  return trimmed || fallback;
};

export const ATOMCODE_DEFAULT_BROKER_BASE = "https://acs.atomgit.com";
export const ATOMCODE_DEFAULT_CODINGPLAN_BASE = "https://api.gitcode.com/api/v5";
export const ATOMCODE_DEFAULT_GATEWAY_BASE = "https://api-ai.gitcode.com/v1";

export function atomcodeBrokerBase() {
  return trimBase(process.env.ATOMCODE_BROKER_BASE, ATOMCODE_DEFAULT_BROKER_BASE);
}

export function atomcodeCodingPlanBase() {
  return trimBase(process.env.ATOMCODE_CODINGPLAN_BASE, ATOMCODE_DEFAULT_CODINGPLAN_BASE);
}

export function atomcodeGatewayBase() {
  return trimBase(process.env.ATOMCODE_GATEWAY_BASE, ATOMCODE_DEFAULT_GATEWAY_BASE);
}

export function atomcodeChatUrl() {
  return `${atomcodeGatewayBase()}/chat/completions`;
}

export const ATOMCODE_BROKER_PROVIDER = "atomgit";
export const ATOMCODE_BROKER_LOGIN_PATH = "/auth/login";
export const ATOMCODE_BROKER_CHECK_PATH = "/auth/check";
export const ATOMCODE_BROKER_TOKEN_PATH = "/auth/token";
export const ATOMCODE_BROKER_REFRESH_PATH = "/oauth/refresh";

export const ATOMCODE_CODINGPLAN_CLAIM_PATH = "/coding-plan/claim-v2";
export const ATOMCODE_CODINGPLAN_MODELS_PATH = "/coding-plan/models-v2";
export const ATOMCODE_CODINGPLAN_STATUS_PATH = "/coding-plan/status-v2";

// User-Agent is functional. The gateway decides whether to demand the
// closed-source signature by identity: any `atomcode/<version>` UA triggers
// `403 ATOMCODE_SIG_MISSING`, while a neutral UA on api-ai.gitcode.com answers
// normally. This adapter therefore never claims to be the official client.
export const ATOMCODE_ADAPTER_USER_AGENT = "10router-atomcode/1.0";

export const ATOMCODE_REQUEST_TIMEOUT_MS = 30_000;
// Chat connect/stall budget: a reasoning prefill can exceed the maintenance
// timeout above, and cutting it early turns a slow answer into a 502.
export const ATOMCODE_CHAT_TIMEOUT_MS = 120_000;
export const ATOMCODE_REFRESH_LEAD_SECONDS = 3600;

// Plan tiers and cascade order (official types.rs CASCADE_ORDER).
export const ATOMCODE_PLAN_MAX = "Max";
export const ATOMCODE_PLAN_PRO = "Pro";
export const ATOMCODE_PLAN_LITE = "Lite";
export const ATOMCODE_PLAN_CASCADE = [
  ATOMCODE_PLAN_MAX,
  ATOMCODE_PLAN_PRO,
  ATOMCODE_PLAN_LITE,
];

// `atomcode-signing-v1` primitives. The master key is compiled into the
// official desktop build; the value below is the community-documented one and
// can be replaced without touching call sites when upstream rotates it.
export const ATOMCODE_SIGN_MASTER_KEY_HEX =
  "e97250f05303162c8ecd68c688b2f55c1d81e508d243d88466472e7f54637123";
export const ATOMCODE_SIGN_CLIENT_VERSION = "5.0.2";
export const ATOMCODE_SIGN_VERSION = "v1";
export const ATOMCODE_SIGN_LABEL = "atomcode-signing-v1";
export const ATOMCODE_SIGN_ALG = "1";
export const ATOMCODE_SIGN_NONCE_BYTES = 16;
export const ATOMCODE_SIGN_HEADER_SIG = "X-AtomCode-Sig";
export const ATOMCODE_SIGN_HEADER_TS = "X-AtomCode-Ts";
export const ATOMCODE_SIGN_HEADER_NONCE = "X-AtomCode-Nonce";
export const ATOMCODE_SIGN_HEADER_ALG = "X-AtomCode-Alg";
export const ATOMCODE_SIGN_HEADER_VER = "X-AtomCode-Ver";
export const ATOMCODE_SIG_MISSING_CODE = "ATOMCODE_SIG_MISSING";

export function atomcodeSignMasterKeyHex(override = null) {
  const value = typeof override === "string" && override.trim()
    ? override.trim()
    : process.env.ATOMCODE_SIGN_MASTER_KEY;
  return value && value.trim() ? value.trim() : ATOMCODE_SIGN_MASTER_KEY_HEX;
}

export function atomcodeSignClientVersion(override = null) {
  const value = typeof override === "string" && override.trim()
    ? override.trim()
    : process.env.ATOMCODE_SIGN_CLIENT_VERSION;
  return value && value.trim() ? value.trim() : ATOMCODE_SIGN_CLIENT_VERSION;
}

// HTTP 200 bodies the gateway uses to reject a request without an error status.
export const ATOMCODE_PARAMETER_ERROR_MESSAGE = "参数错误";
export const ATOMCODE_THIRD_PARTY_FAILURE_MARKER = "三方请求失败";

// Quota-wall copy (also delivered as HTTP 200) — different from a transient
// overload: the account has hit a window/model limit and should cool down.
export const ATOMCODE_QUOTA_WALL_MARKERS = [
  "用量窗口内已达上限",
  "窗口内已达上限",
  "每月token额度已不足",
  "额度已不足",
  "额度不足",
];
