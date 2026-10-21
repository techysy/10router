/**
 * Qoder API constants ported from CLIProxyAPIPlus qoder-provider branch.
 *
 * Endpoint set:
 *   openapi.qoder.sh   - device flow + userinfo + quota usage + token refresh
 *   center.qoder.sh    - appcode-signed endpoints only (PAT job tokens)
 *   api3.qoder.sh      - inference (chat) + model list, requires COSY signing
 *   qoder.com/device   - browser landing page for device authorization
 */

export const QODER_OPENAPI_BASE = "https://openapi.qoder.sh";
export const QODER_CENTER_BASE = "https://center.qoder.sh";
export const QODER_CHAT_BASE = "https://api3.qoder.sh";
// Job-token (jt-...) traffic is rejected by api3 with "Login expired" (403);
// the official qodercli serves it from api2 instead.
export const QODER_CHAT_BASE_ALT = "https://api2.qoder.sh";

export const QODER_LOGIN_URL = "https://qoder.com/device/selectAccounts";

// Device flow endpoints
export const QODER_DEVICE_TOKEN_URL = `${QODER_OPENAPI_BASE}/api/v1/deviceToken/poll`;
export const QODER_USERINFO_URL = `${QODER_OPENAPI_BASE}/api/v1/userinfo`;
export const QODER_QUOTA_USAGE_URL = `${QODER_OPENAPI_BASE}/api/v2/quota/usage`;
// Device-flow token refresh. Deliberately on the openapi host and unsigned:
// the center `/algo/api/v3/user/refresh_token` endpoint requires the appcode
// signature and answers unsigned device-token requests with
// 403 {"errorMessage":"Request discarded"}. Kept for reference only — the
// executor/refresh handler reads the URL from the registry oauth block.
export const QODER_REFRESH_TOKEN_URL = `${QODER_OPENAPI_BASE}/api/v1/deviceToken/refresh`;
export const QODER_JOB_REFRESH_URL = `${QODER_OPENAPI_BASE}/api/v1/jobToken/refresh`;

// PAT (Personal Access Token, pt-...) → short-lived job token (jt-...) exchange.
// PATs cannot sign COSY requests directly — they must be exchanged first.
// This endpoint is NOT COSY-signed (plain JSON POST).
export const QODER_JOB_TOKEN_EXCHANGE_URL = `${QODER_OPENAPI_BASE}/api/v1/jobToken/exchange`;

// Web console (browser session) — the per-resource-pack usage breakdown is only
// served here, and only to the browser's httpOnly session cookie (device/job
// tokens get 401). CreditDaddy syncs captured cookies via providerSpecificData.
export const QODER_WEB_BASE = "https://qoder.com";

// ─── Qoder CN (qoder.com.cn deployment, from qodercli-cn v1.1.32) ──
export const QODER_CN_GATEWAY_BASE = "https://gateway.qoder.com.cn";
export const QODER_CN_OPENAPI_BASE = "https://openapi.qoder.com.cn";
export const QODER_CN_LOGIN_URL = "https://qoder.cn/device/selectAccounts";
export const QODER_CN_DEVICE_TOKEN_URL = `${QODER_CN_OPENAPI_BASE}/api/v1/deviceToken/poll`;
export const QODER_CN_USERINFO_URL = `${QODER_CN_OPENAPI_BASE}/api/v1/userinfo`;
export const QODER_CN_QUOTA_USAGE_URL = `${QODER_CN_OPENAPI_BASE}/api/v2/quota/usage`;
export const QODER_CN_JOB_TOKEN_EXCHANGE_URL = `${QODER_CN_OPENAPI_BASE}/api/v1/jobToken/exchange`;
export const QODER_CN_WEB_BASE = "https://qoder.cn";
export const QODER_CN_CHAT_BASE_ALT = QODER_CN_GATEWAY_BASE;
export const QODER_CN_MODEL_LIST_URL = `${QODER_CN_GATEWAY_BASE}/algo/api/v2/model/list`;

// Inference endpoints (under /algo on api3.qoder.sh, all COSY-signed)
export const QODER_CHAT_SIG_PATH = "/api/v2/service/pro/sse/agent_chat_generation";
export const QODER_CHAT_URL = `${QODER_CHAT_BASE}/algo${QODER_CHAT_SIG_PATH}?FetchKeys=llm_model_result&AgentId=agent_common`;
export const QODER_CHAT_URL_ENCODED = `${QODER_CHAT_URL}&Encode=1`;
export const QODER_MODEL_LIST_URL = `${QODER_CHAT_BASE}/algo/api/v2/model/list`;

// COSY header constants. These are not arbitrary — the upstream signature
// validation matches them against the values used at signing time.
export const QODER_IDE_VERSION = "1.0.0";
export const QODER_CLIENT_TYPE = "5";
export const QODER_DATA_POLICY = "disagree";
export const QODER_LOGIN_VERSION = "v2";
export const QODER_MACHINE_OS = "x86_64_windows";
export const QODER_MACHINE_TYPE = "5";

// Canonical model identifiers. Identity map — keep as a map so callers can
// cheaply test "is this a known qoder model?" before sending the request.
export const QODER_MODEL_MAP = {
  // Tier models
  auto: "auto",
  ultimate: "ultimate",
  performance: "performance",
  efficient: "efficient",
  lite: "lite",
  // Frontier models
  qmodel: "qmodel",
  qfmodel: "qfmodel",
  qmodel_latest: "qmodel_latest",
  qmodel_38max: "qmodel_38max",
  dmodel: "dmodel",
  dfmodel: "dfmodel",
  gmodel: "gmodel",
  gfmodel: "gfmodel",
  kmodel: "kmodel",
  kmodel_latest: "kmodel_latest",
  mmodel: "mmodel",
  gm51model: "gm51model",
  qmodel_preview: "qmodel_preview",
};

// RSA public key for COSY encryption (extracted from Qoder IDE v0.9).
// Matches the CLIProxyAPIPlus branch and live qodercli traffic.
export const QODER_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;
