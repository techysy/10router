/**
 * CodeArts (Huawei Cloud) web login — the pure protocol half.
 *
 * ── Flow ─────────────────────────────────────────────────────
 *   1. `buildAuthorizeUrl()` → `/portal/authorize` on codearts.huaweicloud.com.
 *      The portal only accepts a **port**; it always calls back on its own fixed
 *      path `/oauth/callback`, so the local listener must use that path.
 *   2. The loopback callback carries `code` (+ `state`/`ticket_id` when the
 *      portal echoes it). `parseLoopbackCallback()` validates it.
 *   3. `exchangeCode()` → POST STS `/v1/oauth2/tokens`, form-urlencoded, with a
 *      fresh **DPoP** proof (ES256, low-S) and `client_id=vscode-codebot`.
 *   4. `refresh()` → same endpoint with `grant_type=refresh_token`; the PKCE
 *      verifier and the *same* DPoP private key must be sent again.
 *
 * ── What must survive in the credential ──────────────────────
 * The STS refresh token is bound to the PKCE context and the DPoP public key
 * from the original login. Rust `credentials.rs` stores `OAuthContext`
 * (verifier + key pair) next to the tokens for exactly this reason; dropping
 * either half makes the account unrefreshable. `exchangeCode()` therefore
 * returns `providerSpecificData` carrying `pkceVerifier` (plus the
 * `codeVerifier` alias the shared refresh path reads), `dpopPrivateKeyPem`,
 * `clientId`, and the rotating `refreshToken`.
 *
 * ── Reuse, not a second signer ───────────────────────────────
 * DPoP proofs and the portal's `encodeURIComponent`-style escaping both come
 * from `open-sse/shared/codearts/signing.js` (Rust `dpop.rs` / `oauth.rs`
 * parity), so there is only one implementation of low-S and of the
 * `!'()*`-literal encoding the portal expects.
 */
import crypto from "node:crypto";

import {
  CODEARTS_OAUTH_CLIENT_ID,
  CODEARTS_TOKEN_URL,
  CODEARTS_WEB_LOGIN_BASE,
} from "open-sse/config/codearts.js";
import {
  buildDpopProof,
  dpopKeyFromPrivateKey,
  encodeComponent,
} from "open-sse/shared/codearts/signing.js";

/** Portal callback path is fixed upstream — we cannot choose it. */
const CALLBACK_PATH = "/oauth/callback";
/** Portal only knows this challenge-method spelling (not OAuth's `S256`). */
const PKCE_METHOD = "SHA-256";
const DEFAULT_PLUGIN_NAME = "snap_vscode";
const DEFAULT_PLUGIN_VERSION = "26.9.101";
const DEFAULT_LANGUAGE = "en-us";
const REQUEST_TIMEOUT_MS = 30_000;

export const config = {
  authorizeUrl: `${CODEARTS_WEB_LOGIN_BASE}/portal/authorize`,
  webLoginBase: CODEARTS_WEB_LOGIN_BASE,
  tokenUrl: CODEARTS_TOKEN_URL,
  clientId: CODEARTS_OAUTH_CLIENT_ID,
  callbackPath: CALLBACK_PATH,
  // 0 = the loopback listener picks an ephemeral port; the portal learns it
  // from `redirect_uri` (it validates the port, then composes this path).
  fixedPort: 0,
  pkceMethod: PKCE_METHOD,
  pluginName: DEFAULT_PLUGIN_NAME,
  pluginVersion: DEFAULT_PLUGIN_VERSION,
  language: DEFAULT_LANGUAGE,
  flowType: "authorization_code_pkce",
};

function oauthError(message, { statusCode = 502, code = "token_request_failed", reauthRequired = false } = {}) {
  const error = new Error(message);
  error.name = "CodeArtsOAuthError";
  error.statusCode = statusCode;
  error.code = code;
  error.reauthRequired = reauthRequired;
  return error;
}

/** Go `url.Values.Encode()` / Rust `form_encode`: space is `+`, `!'()*` escaped. */
function formEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+");
}

function formBody(fields) {
  return fields
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => `${formEncode(name)}=${formEncode(value)}`)
    .join("&");
}

function resolveFetch(options) {
  const impl = options?.fetchImpl || globalThis.fetch;
  if (typeof impl !== "function") throw new Error("CodeArts OAuth 缺少 fetch 实现");
  return impl;
}

/** Accept a PKCS#8/PEM string (what exchangeCode stores) or a KeyObject. */
function importDpopPrivateKey(input) {
  const value = typeof input === "string" ? input.trim() : input;
  if (!value) throw oauthError("CodeArts 缺少 DPoP 私钥，请重新登录", { statusCode: 400, code: "missing_dpop_key" });
  try {
    return value instanceof crypto.KeyObject ? value : crypto.createPrivateKey(value);
  } catch {
    throw oauthError("CodeArts DPoP 私钥不可用，请重新登录", { statusCode: 400, code: "invalid_dpop_key" });
  }
}

/**
 * One P-256 key pair for the whole login. The private key stays in the
 * server-side session and is persisted with the credential; the public half is
 * embedded in every DPoP proof by the shared signer.
 */
export function generateDpopKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
  };
}

function portOf(redirectUri) {
  let url;
  try {
    url = new URL(String(redirectUri || ""));
  } catch {
    throw oauthError(`CodeArts callback 地址非法：${redirectUri}`, { statusCode: 400, code: "invalid_redirect_uri" });
  }
  if (!url.port) {
    throw oauthError("CodeArts 回调地址必须带 loopback 端口（portal 只认 port）", {
      statusCode: 400,
      code: "missing_callback_port",
    });
  }
  return url.port;
}

function localeOf(language) {
  return String(language || "").trim().toLowerCase().startsWith("zh") ? "zh-cn" : "en";
}

/**
 * Build the portal authorize URL.
 *
 * Parameter order and escaping match the Rust `authorize_url` (and its golden
 * vectors): `port` is parsed out of `redirectUri`, and `auth_callback_url`
 * carries the full loopback URL. `state` doubles as the portal's `ticket_id`.
 */
export function buildAuthorizeUrl({
  redirectUri,
  state,
  pkceChallenge,
  language = config.language,
  pluginName = config.pluginName,
  pluginVersion = config.pluginVersion,
} = {}) {
  const code = String(state || "").trim();
  const challenge = String(pkceChallenge || "").trim();
  if (!redirectUri) throw oauthError("CodeArts 授权需要 redirectUri", { statusCode: 400, code: "missing_redirect_uri" });
  if (!code) throw oauthError("CodeArts 授权需要 state", { statusCode: 400, code: "missing_state" });
  if (!challenge) throw oauthError("CodeArts 授权需要 PKCE challenge", { statusCode: 400, code: "missing_pkce_challenge" });

  const pairs = [
    ["theme", "2"],
    ["locale", localeOf(language)],
    ["uri_scheme", config.clientId],
    ["client_id", config.clientId],
    ["port", portOf(redirectUri)],
    ["code_challenge", challenge],
    ["code_challenge_method", config.pkceMethod],
    ["ticket_id", code],
    ["auth_callback_url", String(redirectUri)],
    ["plugin-name", pluginName],
    ["plugin-version", pluginVersion],
  ];
  const query = pairs.map(([name, value]) => `${name}=${encodeComponent(value)}`).join("&");
  return `${config.webLoginBase.replace(/\/+$/, "")}${new URL(config.authorizeUrl).pathname}?${query}`;
}

/** `\${seconds}` until the RFC3339 `expiration`, or undefined when unparseable. */
function expiresInSeconds(expiration, nowMs = Date.now()) {
  const text = String(expiration || "").trim();
  if (!text) return undefined;
  const expiry = Date.parse(text);
  if (!Number.isFinite(expiry)) return undefined;
  return Math.max(1, Math.floor((expiry - nowMs) / 1000));
}

/**
 * Identity stashed in the refresh token's JWT (`user_profile` is itself a
 * base64url JSON blob). This is the cheap alternative to a second signed call
 * to `/v5/caller-identity`; a malformed token simply yields no identity.
 */
function identityFromRefreshToken(refreshToken) {
  try {
    const parts = String(refreshToken || "").split(".");
    if (parts.length < 2) return {};
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const profile = typeof claims?.user_profile === "string" ? claims.user_profile : "";
    if (!profile) return {};
    const identity = JSON.parse(Buffer.from(profile, "base64url").toString("utf8"));
    const accountId = String(identity?.account_id || "").trim();
    const principalId = String(identity?.principal_id || "").trim();
    const urn = String(identity?.principal_urn || "").trim();
    if (!accountId || !principalId || !urn) return {};
    return {
      domainId: accountId,
      userId: principalId,
      userName: urn.split(/[:/]/).pop() || urn,
    };
  } catch {
    return {};
  }
}

function parseTokenPayload(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw oauthError("CodeArts 令牌响应不是合法 JSON", { statusCode: 502, code: "invalid_response" });
  }
  const material = payload?.credentials && typeof payload.credentials === "object" ? payload.credentials : payload;
  const read = (name) => String(material?.[name] ?? payload?.[name] ?? "").trim();
  const parsed = {
    accessKeyId: read("access_key_id"),
    secretAccessKey: read("secret_access_key"),
    securityToken: read("security_token"),
    expiration: read("expiration"),
    refreshToken: read("refresh_token"),
    projectId: read("project_id") || read("projectId"),
  };
  if (!parsed.accessKeyId || !parsed.secretAccessKey || !parsed.securityToken) {
    throw oauthError("CodeArts 令牌响应缺少 access_key_id / secret_access_key / security_token", {
      statusCode: 502,
      code: "invalid_response",
    });
  }
  return parsed;
}

function tokenResult(material, context) {
  const refreshToken = material.refreshToken || context.refreshToken || "";
  const identity = identityFromRefreshToken(refreshToken);
  const providerSpecificData = {
    authMethod: "oauth",
    accessKeyId: material.accessKeyId,
    secretAccessKey: material.secretAccessKey,
    securityToken: material.securityToken,
    refreshToken,
    // Task-facing name plus the alias `open-sse/shared/codearts/oauth.js`
    // reads on automatic refresh; both must stay.
    pkceVerifier: context.codeVerifier,
    codeVerifier: context.codeVerifier,
    dpopPrivateKeyPem: context.dpopPrivateKeyPem,
    clientId: context.clientId,
  };
  if (material.expiration) providerSpecificData.expiration = material.expiration;
  if (material.projectId) providerSpecificData.projectId = material.projectId;
  if (identity.domainId) providerSpecificData.domainId = identity.domainId;
  if (identity.userId) providerSpecificData.userId = identity.userId;
  if (identity.userName) providerSpecificData.userName = identity.userName;

  return {
    accessToken: material.accessKeyId,
    refreshToken: refreshToken || null,
    expiresIn: expiresInSeconds(material.expiration),
    providerSpecificData,
  };
}

function tokenErrorFrom(status, text) {
  const raw = String(text || "").trim();
  let detail = raw;
  try {
    const payload = JSON.parse(raw);
    detail =
      String(payload?.error_description || payload?.error || payload?.message || raw).trim() ||
      raw;
  } catch {
    // HTML/plain-text error bodies stay as-is, just truncated below.
  }
  if (detail.length > 300) detail = `${detail.slice(0, 300)}…`;
  // Classify on the whole body: `error_description` alone ("refresh token
  // used") would hide the `invalid_grant` code that makes this a re-login.
  const lowered = `${raw} ${detail}`.toLowerCase();
  const reauthRequired =
    status === 401 || status === 403 || lowered.includes("invalid_grant");
  const suffix = reauthRequired ? "，请重新登录" : "";
  return oauthError(
    `CodeArts 令牌端点${reauthRequired ? "拒绝" : "返回"}（HTTP ${status}）${detail ? `：${detail}` : ""}${suffix}`,
    {
      statusCode: status,
      code: reauthRequired ? "reauth_required" : "token_request_failed",
      reauthRequired,
    }
  );
}

async function postToken(form, { dpopPrivateKeyPem, fetchImpl, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const privateKey = importDpopPrivateKey(dpopPrivateKeyPem);
  const key = dpopKeyFromPrivateKey(privateKey);
  // htm/htu must match the outgoing request byte-for-byte; both come from the
  // same constants, never from caller input.
  const proof = buildDpopProof({
    privateKey: key.privateKey,
    publicJwk: key.publicJwk,
    method: "POST",
    url: config.tokenUrl,
  });

  let response;
  try {
    response = await resolveFetch({ fetchImpl })(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        DPoP: proof,
      },
      body: formBody(form),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw oauthError(`CodeArts 令牌请求失败：${error?.message || error}`, {
      statusCode: 502,
      code: "network_error",
    });
  }

  const text = await response.text().catch(() => "");
  if (!response.ok) throw tokenErrorFrom(response.status, text);

  return parseTokenPayload(text);
}

/**
 * Exchange the loopback authorization code for temporary AK/SK/STS.
 *
 * `redirectUri` must be the exact URL handed to the portal (STS compares it);
 * it is optional here only so callers that do not send it keep working.
 */
export async function exchangeCode(
  { code, codeVerifier, dpopPrivateKeyPem, redirectUri, clientId = config.clientId } = {},
  options = {}
) {
  const authCode = String(code || "").trim();
  const verifier = String(codeVerifier || "").trim();
  if (!authCode) throw oauthError("CodeArts 缺少授权码", { statusCode: 400, code: "missing_code" });
  if (!verifier) throw oauthError("CodeArts 缺少 PKCE verifier", { statusCode: 400, code: "missing_code_verifier" });

  const material = await postToken(
    [
      ["client_id", clientId],
      ["code", authCode],
      ["code_verifier", verifier],
      ["grant_type", "authorization_code"],
      ["redirect_uri", redirectUri],
    ],
    { dpopPrivateKeyPem, ...options }
  );

  // A credential without a refresh token dies at the first expiry and cannot
  // explain why (Rust `token_request` rejects the same shape).
  if (!material.refreshToken) {
    throw oauthError("CodeArts 令牌响应没有 refresh token，该凭据无法续期，请重新登录", {
      statusCode: 502,
      code: "missing_refresh_token",
    });
  }

  return tokenResult(material, { codeVerifier: verifier, dpopPrivateKeyPem, clientId, refreshToken: "" });
}

/**
 * Refresh the temporary AK/SK/STS. One-time refresh token: the caller must
 * single-flight concurrent refreshes (the shared refresh path already does).
 * The verifier and the original DPoP key are mandatory — this is why they are
 * part of `providerSpecificData` rather than transient login state.
 */
export async function refresh(
  { refreshToken, pkceVerifier, dpopPrivateKeyPem, clientId = config.clientId } = {},
  options = {}
) {
  const token = String(refreshToken || "").trim();
  const verifier = String(pkceVerifier || "").trim();
  if (!token) throw oauthError("CodeArts 缺少 refresh token，请重新登录", { statusCode: 400, code: "missing_refresh_token" });
  if (!verifier) throw oauthError("CodeArts 缺少 PKCE verifier，无法续期，请重新登录", {
    statusCode: 400,
    code: "missing_code_verifier",
  });

  const material = await postToken(
    [
      ["client_id", clientId],
      ["code_verifier", verifier],
      ["grant_type", "refresh_token"],
      ["refresh_token", token],
    ],
    { dpopPrivateKeyPem, ...options }
  );

  return tokenResult(material, {
    codeVerifier: verifier,
    dpopPrivateKeyPem,
    clientId,
    refreshToken: token,
  });
}

/**
 * Parse the portal's loopback callback.
 *
 * The portal has been observed to return `code` alone (no `state`), so a
 * missing state is tolerated; a present-but-different state is rejected. The
 * caller should still match the code to the pending login round (state, then
 * oldest-first candidates), as Rust `oauth.rs` does.
 */
export function parseLoopbackCallback(url, expectedState) {
  let parsed;
  try {
    parsed = url instanceof URL ? url : new URL(String(url || ""));
  } catch {
    throw oauthError(`CodeArts 回调地址非法：${url}`, { statusCode: 400, code: "invalid_callback_url" });
  }

  const upstreamError = String(parsed.searchParams.get("error") || "").trim();
  if (upstreamError) {
    const description = String(parsed.searchParams.get("error_description") || "").trim();
    throw oauthError(`CodeArts 回调返回 ${upstreamError}${description ? `：${description}` : ""}`, {
      statusCode: 400,
      code: "callback_error",
    });
  }

  const code = String(parsed.searchParams.get("code") || "").trim();
  const state = String(parsed.searchParams.get("state") || "").trim();
  if (!code) throw oauthError("CodeArts 回调缺少 code", { statusCode: 400, code: "missing_code" });

  const expected = String(expectedState || "").trim();
  if (expected && state && state !== expected) {
    throw oauthError("CodeArts 回调 state 不匹配，已拒绝", { statusCode: 400, code: "state_mismatch" });
  }

  return { code, state: state || null };
}
