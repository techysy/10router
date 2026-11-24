// AutoClaw（智谱澳龙）国际版 — account-plane web OAuth (Google / z.ai),
// wire-compatible with the desktop client's AuthApiAdapter (ported from
// hj01857655/AutoClaw2api internal/oauth + hubo1989/opencode-autoclaw-auth):
//
//   POST autoglm-api.autoglm.ai/userapi/overseasv1/oauth-captcha-config
//        → { enabled, region, prefix, scene_id }   (Aliyun slider captcha)
//   POST …/userapi/overseasv1/{vendor}-oauth-url
//        { source_id, device_id, navigate_uri, ali_captcha_verify_param? }
//        → data.oauth_url (vendor authorize page, carries the upstream state)
//   browser → accounts.google.com (z.ai: chatglm.cn) → 302 to
//        http://localhost:18432/auth/callback-{vendor}?code=&state=
//   POST …/userapi/overseasv1/{vendor}-oauth-login
//        { source_id, device_id, code, state, navigate_uri }
//        → { access_token, refresh_token, user_id }
//
// Not a standard OAuth client, so it does not ride the generic OAuthModal
// (whose authorize URL is built server-side without user interaction): the
// captcha is ENABLED upstream (live-observed 2026-11-24 — oauth-url without
// a receipt answers 400001), and its receipt can only come from the Aliyun
// SDK running in the user's browser. The flow is therefore a dedicated
// dashboard modal + routes (Capy / Kiro-social shape):
//   1. GET  /api/oauth/autoclaw/captcha-config → captcha params for the SDK
//   2. POST /api/oauth/autoclaw/oauth-start { vendor, captchaVerifyParam }
//        → { authUrl, flowId } (this module mints it via oauth-url)
//   3. user authorizes; the browser lands on the dead localhost:18432 page
//   4. POST /api/oauth/autoclaw/oauth-complete { flowId, callbackUrl }
//        → oauth-login → providerConnection
// navigate_uri must be the official TokenServer loopback shape (random port
// / custom path → "Redirect URI not registered for this client"); if the
// AutoClaw desktop app is running it owns 18432 and swallows the callback.
//
// device_id is the stable per-install id (autoclawDeviceId) — the account
// plane binds it into the JWT and re-checks it on refresh, so url / login /
// refresh all send the same one. Pure module, no DB: routes persist.

import crypto from "node:crypto";
import {
  AutoclawApiError,
  autoclawDeviceId,
  autoclawDisplayName,
  exchangeAutoclawOAuthCode,
  fetchAutoclawProfile,
  getAutoclawCaptchaConfig,
  getAutoclawOAuthUrl,
  normalizeAutoclawVendor,
} from "open-sse/shared/autoclaw/client.js";
import { AUTOCLAW_REGIONS, autoclawRedirectUri } from "open-sse/shared/autoclaw/constants.js";

const FLOW_TTL_MS = 10 * 60 * 1000;

// Pending sign-ins keyed by an opaque flow id: consumed on success, kept on
// a failed exchange so a mis-paste can be retried. Server-local (the
// dashboard and these routes share the process), same as capy's flows.
const pendingFlows = new Map();

function sweepExpired(now = Date.now()) {
  for (const [id, flow] of pendingFlows) {
    if (now - flow.createdAt > FLOW_TTL_MS) pendingFlows.delete(id);
  }
}

/** Captcha params the dashboard modal hands to the Aliyun SDK. */
export async function autoclawCaptchaConfig({ fetchImpl } = {}) {
  return getAutoclawCaptchaConfig({ fetchImpl });
}

/**
 * Step 1 — mint the vendor authorize URL (with the browser-produced captcha
 * receipt when the gateway demands one). Returns { flowId, authUrl, vendor,
 * redirectUri, expiresIn }.
 */
export async function startAutoclawOAuth({ vendor, captchaVerifyParam = null } = {}, { fetchImpl } = {}) {
  const v = normalizeAutoclawVendor(vendor);
  const navigateUri = autoclawRedirectUri(v);
  const deviceId = await autoclawDeviceId();
  let auth;
  try {
    auth = await getAutoclawOAuthUrl({ vendor: v, navigateUri, captchaVerifyParam }, { deviceId, fetchImpl });
  } catch (e) {
    const needsCaptcha = !captchaVerifyParam && Number(e?.code) === 400001;
    throw new AutoclawApiError(
      needsCaptcha
        ? "AutoClaw 要求先完成滑块安全验证（captcha 回执缺失），请在弹窗内完成验证后重试"
        : `AutoClaw 获取授权页失败：${e.message}`,
      { code: e?.code ?? null, status: e?.status ?? null },
    );
  }
  sweepExpired();
  const flowId = crypto.randomBytes(24).toString("base64url");
  pendingFlows.set(flowId, { vendor: v, navigateUri, deviceId, state: auth.state, createdAt: Date.now() });
  return {
    flowId,
    authUrl: auth.authorizeUrl,
    vendor: v,
    redirectUri: navigateUri,
    expiresIn: Math.floor(FLOW_TTL_MS / 1000),
  };
}

/** Pull code + state out of a pasted callback URL (or a bare query string). */
export function parseAutoclawCallback(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new AutoclawApiError("请粘贴授权后浏览器地址栏里的完整地址");
  let params;
  try {
    params = new URL(raw).searchParams;
  } catch {
    params = new URLSearchParams(raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : raw);
  }
  const error = params.get("error");
  if (error) throw new AutoclawApiError(params.get("error_description") || error);
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) throw new AutoclawApiError("地址里没有 code 或 state——请复制跳转后地址栏里的完整地址");
  return { code, state };
}

/**
 * Step 2 — exchange the callback for the token pair. The callback's state
 * must match the one the authorize URL was minted with (anti-hijack; the
 * upstream re-checks it too). Returns everything the connection needs.
 */
export async function completeAutoclawOAuth({ flowId, callbackUrl }, { fetchImpl } = {}) {
  sweepExpired();
  const flow = typeof flowId === "string" ? pendingFlows.get(flowId) : null;
  if (!flow) throw new AutoclawApiError("登录已过期，请重新开始授权", { code: "flow_expired" });
  const { code, state } = parseAutoclawCallback(callbackUrl);
  if (state !== flow.state) throw new AutoclawApiError("回调 state 与本次授权不符，已拒绝（请使用本次打开的授权页）");
  const fields = await exchangeAutoclawOAuthCode(
    { vendor: flow.vendor, code, state, navigateUri: flow.navigateUri },
    { deviceId: flow.deviceId, fetchImpl },
  );
  pendingFlows.delete(flowId);
  const profile = await fetchAutoclawProfile(fields.accessToken, { region: "intl", deviceId: flow.deviceId, fetchImpl });
  return { ...fields, vendor: flow.vendor, deviceId: flow.deviceId, profile };
}

/** Stable identity for dedup: profile email, else the account's user_id. */
export function autoclawIdentityEmail(profile, userId) {
  const email = String(profile?.email || profile?.user_email || "").trim();
  if (email) return email;
  return userId ? `autoclaw-${userId}` : null;
}

/** createProviderConnection payload (route + tests share it). */
export function autoclawIntlConnectionPayload(r) {
  const name = autoclawDisplayName(r.profile, `AutoClaw ${r.vendor === "zai" ? "z.ai" : "Google"} 账号`);
  return {
    provider: "autoclaw",
    authType: "oauth",
    name,
    email: autoclawIdentityEmail(r.profile, r.userId),
    displayName: name,
    accessToken: r.accessToken,
    refreshToken: r.refreshToken,
    expiresAt: new Date(Date.now() + r.expiresIn * 1000).toISOString(),
    isActive: true,
    testStatus: "active",
    providerSpecificData: {
      authMethod: "oauth",
      region: "intl",
      vendor: r.vendor,
      userId: r.userId,
      deviceId: r.deviceId,
      accountHost: AUTOCLAW_REGIONS.intl.accountHost,
      loginAt: new Date().toISOString(),
      credentialSource: "web-oauth",
    },
  };
}

/** Test hook. */
export function _resetAutoclawFlows() {
  pendingFlows.clear();
}
