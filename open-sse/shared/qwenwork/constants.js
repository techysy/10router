/**
 * QwenWork （千问办公） API constants.
 *
 * QwenWork is Alibaba's workplace agent (QoderWork + MuleRun + Wukong merged,
 * public beta 2026-08). Its desktop client speaks the SAME protocol family as
 * Qoder — device-token flow (PKCE + nonce + machine_id), COSY envelope
 * signing, agent_chat_generation SSE chat, /algo/api/v2/model/list catalog —
 * with per-site constants swapped. Community implementations verified this
 * end to end against the desktop app (magpie-plugin-qwenwork shares one
 * adapter between Qoder and QwenWork; only the site config differs).
 *
 * Two deployments, mirroring qoder/qoder-cn:
 *   qwenwork     — international, gateway.qwenwork.ai (Google/email sign-up)
 *   qwenwork-cn  — China, gateway.qwenwork.cn （钉钉/手机号/阿里云账号）
 *
 * Unlike Qoder, chat runs on the DEVICE token directly (no job-token
 * exchange, no PAT), and the device token DOES refresh:
 *   POST /api/v1/deviceToken/refresh { refresh_token, target: "c" }
 * Refresh tokens are single-use and rotate on every refresh — the gateway
 * must be the only refresher and must persist the new pair immediately.
 */

import { randomUUID } from "node:crypto";

// The COSY RSA public key is the same server key Qoder uses (verified
// byte-identical across the Qoder IDE bundle and the QwenWork desktop
// bundle), so it is re-exported rather than duplicated.
export { QODER_RSA_PUBLIC_KEY as QWENWORK_RSA_PUBLIC_KEY } from "../qoder/constants.js";

// ─── International (qwenwork.ai) ───
export const QWENWORK_GATEWAY_BASE = "https://gateway.qwenwork.ai";
export const QWENWORK_CLIENT_ID = "cc65e5fc-05bd-4f5d-a4e8-0df19aa3d75a";
export const QWENWORK_REDIRECT_URI = "qwenwork://";
export const QWENWORK_LOGIN_URL = `${QWENWORK_GATEWAY_BASE}/device/selectAccounts`;
export const QWENWORK_DEVICE_TOKEN_URL = `${QWENWORK_GATEWAY_BASE}/api/v1/deviceToken/poll`;
export const QWENWORK_REFRESH_TOKEN_URL = `${QWENWORK_GATEWAY_BASE}/api/v1/deviceToken/refresh`;
export const QWENWORK_USERINFO_URL = `${QWENWORK_GATEWAY_BASE}/api/v1/adapter/user/account-context?include=user,plan,quota,page,data_sharing`;
export const QWENWORK_MODEL_LIST_URL = `${QWENWORK_GATEWAY_BASE}/algo/api/v2/model/list?Encode=1`;
export const QWENWORK_CHAT_URL = `${QWENWORK_GATEWAY_BASE}/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;

// ─── China (qwenwork.cn) ───
export const QWENWORK_CN_GATEWAY_BASE = "https://gateway.qwenwork.cn";
export const QWENWORK_CN_CLIENT_ID = "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb";
export const QWENWORK_CN_REDIRECT_URI = "qwenwork-cn://";
export const QWENWORK_CN_LOGIN_URL = `${QWENWORK_CN_GATEWAY_BASE}/device/selectAccounts`;
export const QWENWORK_CN_DEVICE_TOKEN_URL = `${QWENWORK_CN_GATEWAY_BASE}/api/v1/deviceToken/poll`;
export const QWENWORK_CN_REFRESH_TOKEN_URL = `${QWENWORK_CN_GATEWAY_BASE}/api/v1/deviceToken/refresh`;
export const QWENWORK_CN_USERINFO_URL = `${QWENWORK_CN_GATEWAY_BASE}/api/v1/adapter/user/account-context?include=user,plan,quota,page,data_sharing`;
export const QWENWORK_CN_MODEL_LIST_URL = `${QWENWORK_CN_GATEWAY_BASE}/algo/api/v2/model/list?Encode=1`;
export const QWENWORK_CN_CHAT_URL = `${QWENWORK_CN_GATEWAY_BASE}/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;

// COSY / client fingerprint for QwenWork (desktop app 1.2.5, verified by
// magpie-plugin-qwenwork's defaults.json). Qoder's values differ
// (version 1.0.0 / clientType 5) — do not mix them.
export const QWENWORK_COSY_VERSION = "1.1.59";
export const QWENWORK_CLIENT_TYPE = "6";
export const QWENWORK_BUSINESS_PRODUCT = "qoder_work";
export const QWENWORK_SESSION_TYPE = "qoder_work";
export const QWENWORK_MODEL_SCENE = "qwork";
// The desktop adapter refreshes its device token with target "c".
export const QWENWORK_REFRESH_TARGET = "c";

// The preamble the desktop engine puts under the host's system messages.
export const QWENWORK_SYSTEM_PREAMBLE =
  "You are QwenWork (qw), a helpful assistant. Use the instructions below and the tools available to you to assist the user.";

/** Site table keyed by provider id — every per-deployment value in one place. */
export const QWENWORK_SITES = {
  qwenwork: {
    gatewayBase: QWENWORK_GATEWAY_BASE,
    clientId: QWENWORK_CLIENT_ID,
    redirectUri: QWENWORK_REDIRECT_URI,
    loginUrl: QWENWORK_LOGIN_URL,
    deviceTokenUrl: QWENWORK_DEVICE_TOKEN_URL,
    refreshTokenUrl: QWENWORK_REFRESH_TOKEN_URL,
    userInfoUrl: QWENWORK_USERINFO_URL,
    modelListUrl: QWENWORK_MODEL_LIST_URL,
    chatUrl: QWENWORK_CHAT_URL,
  },
  "qwenwork-cn": {
    gatewayBase: QWENWORK_CN_GATEWAY_BASE,
    clientId: QWENWORK_CN_CLIENT_ID,
    redirectUri: QWENWORK_CN_REDIRECT_URI,
    loginUrl: QWENWORK_CN_LOGIN_URL,
    deviceTokenUrl: QWENWORK_CN_DEVICE_TOKEN_URL,
    refreshTokenUrl: QWENWORK_CN_REFRESH_TOKEN_URL,
    userInfoUrl: QWENWORK_CN_USERINFO_URL,
    modelListUrl: QWENWORK_CN_MODEL_LIST_URL,
    chatUrl: QWENWORK_CN_CHAT_URL,
  },
};

export function qwenworkSite(providerId) {
  return QWENWORK_SITES[providerId] || QWENWORK_SITES.qwenwork;
}

/**
 * COSY fingerprint overrides for buildCosyHeaders (shared/qoder/cosy.js):
 * QwenWork signs with its own client version/type and carries three extra
 * headers the Qoder client does not send (business product, business type,
 * model scene).
 */
export const QWENWORK_COSY_SITE = {
  cosyVersion: QWENWORK_COSY_VERSION,
  clientType: QWENWORK_CLIENT_TYPE,
  extraHeaders: {
    "Cosy-Business-Product": QWENWORK_BUSINESS_PRODUCT,
    "Cosy-Business-Type": "agent",
    "Cosy-Scene": QWENWORK_MODEL_SCENE,
  },
};

// Desktop-app identity for non-chat calls (model list, account context).
// Verified by the community dsh-qwenwork-connector against the live
// service: without these headers the server does not recognize the
// request as coming from the official client — the international
// gateway then serves a reduced catalog (only the 3 tier keys, none of
// the direct model keys the client shows). Platform/arch name the
// DESKTOP client (darwin/arm64), not the gateway host: this header set
// is the client introducing itself. Values from desktop app 1.2.1.
export const QWENWORK_APP_VERSION = "1.2.1";
export const QWENWORK_APP_RELEASE = "1.2.1-26092107";
export const QWENWORK_APP_PLATFORM = "darwin";
export const QWENWORK_APP_ARCH = "arm64";

export function qwenworkClientHeaders() {
  return {
    "User-Agent": `qoderwork/${QWENWORK_APP_VERSION}`,
    "X-Request-Id": randomUUID(),
    "X-QwenWork-Version": QWENWORK_APP_VERSION,
    "X-QwenWork-Release-Version": QWENWORK_APP_RELEASE,
    "X-QwenWork-Build": QWENWORK_APP_RELEASE.split("-")[1] ?? "",
    "X-QwenWork-Platform": QWENWORK_APP_PLATFORM,
    "X-QwenWork-Arch": QWENWORK_APP_ARCH,
    "X-QwenWork-Channel": "stable",
  };
}
