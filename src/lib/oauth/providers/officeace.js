// OfficeAce (华为果办 / OfficeClaw) self-service OAuth — protocol-only module.
//
// Ported behaviourally from our Rust provider
// `agent2api .../providers/officeace/oauth.rs` (+ provision.rs / credentials.rs).
// No desktop shell and no loopback listener: the cloud terminates the redirect
// and the login is completed by POLLING the cloud for the authorization code.
//
// ── the nine steps ────────────────────────────────────────────
//   ① POST {cloud}/v1/claw/auth/state                  → state (no auth)
//   ② local PKCE(S256) + one P-256 DPoP key pair
//   ③ authorizeUrl (outer login.html?service=<inner authorize>)
//   ④ GET  {cloud}/v1/claw/auth/code?state=…           202 pending / 404 dead /
//                                                      200 code
//   ⑤ POST {sts}/v1/oauth2/tokens (form + `DPoP:` header) → temp AK/SK/STS
//   ⑥ GET  {cloud}/v1/claw/client-permission-validate (SDK-HMAC)
//        → identity + `subscription.model_info` (may be empty = not provisioned)
//   ⑥a GET  {iam}/v3/projects (SDK-HMAC, only when project_id is empty)
//        → match by region name
//   ⑥b POST {cloud}/v1/claw/client-subscription (body `{}`, only when model_info
//        is empty) → provision, response carries top-level `model_info`
//   ⑦ payload: non-expiring gateway Basic `model_app_key:model_app_secret`
//        (returned as `accessToken`), temp credentials + DPoP key go into
//        `providerSpecificData` so refresh / usage / bonus claim keep working.
//
// ── wiring (three actions, no callback server) ────────────────
//   authorize   → startLogin({ fetchImpl, proxyOptions })
//   poll-status → pollAuthorization(state)  (repeat every `pollIntervalMs`)
//   exchange    → finishLogin({ state, code, pkceVerifier, dpopPrivateKeyPem })
// `finishLogin` also resolves the PKCE verifier + DPoP key from the in-module
// session cache populated by `startLogin`, so a poll-once-then-exchange route
// can pass just `{ state, code }`.
//
// ── hard constraints ──────────────────────────────────────────
//   · 404 on step ④ is terminal ("state dead") — never wait for the 10 min TTL;
//   · the token endpoint has no client secret: every call needs a fresh DPoP
//     proof whose `htu` is the exact token URL and whose header embeds the
//     public JWK (private `d` must never leave the process);
//   · `client-permission-validate` returning an empty `model_info` is a normal
//     "not provisioned yet" state, not an error — ⑥a/⑥b are the recovery path;
//   · control-plane calls are SDK-HMAC signed via
//     `open-sse/shared/officeace/signer.js` (do not re-implement signing).
import crypto from "node:crypto";

import { signOfficeAceRequest } from "open-sse/shared/officeace/signer.js";

import { generateCodeChallenge, generateCodeVerifier } from "../utils/pkce.js";

/** All upstream facts in one place (mirrors the Rust `pub const`s). */
export const OFFICEACE_LOGIN_CONFIG = {
  cloudBase: "https://agentarts.cn-southwest-2.myhuaweicloud.com",
  authBase: "https://auth.huaweicloud.com",
  iamBase: "https://iam.myhuaweicloud.com",
  clientId: "pdp5_for_agentarts",
  // The redirect points at the CLOUD, not at a loopback listener.
  redirectUri: "https://agentarts.cn-southwest-2.myhuaweicloud.com/v1/claw/auth/callback",
  tokenUrl: "https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens",
  region: "cn-southwest-2",
  scope: "openid",
  pollIntervalMs: 2500,
  loginTtlMs: 10 * 60 * 1000,
  requestTimeoutMs: 30_000,
  paths: {
    state: "/v1/claw/auth/state",
    code: "/v1/claw/auth/code",
    permission: "/v1/claw/client-permission-validate",
    subscription: "/v1/claw/client-subscription",
    projects: "/v3/projects",
  },
  subscriptionTypeHeader: { name: "x-subscription-type", value: "v2" },
};

/**
 * Classified failure: `stage` names the step that failed ("state" | "poll" |
 * "session" | "token" | "sign" | "validate" | "subscribe" | "gateway" |
 * "network"), `status` is the upstream HTTP status (0 when none). The route
 * should surface `message`; stage 404 polling is reported as `expired` instead.
 */
export class OfficeAceLoginError extends Error {
  constructor(message, { stage = "unknown", status = 0, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "OfficeAceLoginError";
    this.stage = stage;
    this.status = Number(status) || 0;
  }
}

// ── login session cache (PKCE verifier + DPoP key live server-side) ───────
const LOGIN_SESSIONS = new Map();
const LOGIN_SESSION_LIMIT = 32;

function rememberSession(state, context) {
  const now = Date.now();
  for (const [key, value] of LOGIN_SESSIONS) {
    if (now - value.createdAt > OFFICEACE_LOGIN_CONFIG.loginTtlMs) LOGIN_SESSIONS.delete(key);
  }
  LOGIN_SESSIONS.delete(state);
  LOGIN_SESSIONS.set(state, { ...context, createdAt: now });
  while (LOGIN_SESSIONS.size > LOGIN_SESSION_LIMIT) {
    LOGIN_SESSIONS.delete(LOGIN_SESSIONS.keys().next().value);
  }
}

function peekSession(state) {
  const key = trim(state);
  if (!key) return null;
  const session = LOGIN_SESSIONS.get(key);
  if (!session) return null;
  if (Date.now() - session.createdAt > OFFICEACE_LOGIN_CONFIG.loginTtlMs) {
    LOGIN_SESSIONS.delete(key);
    return null;
  }
  return session;
}

/** Drop a session (cancel / abandon). Optional for the route; the TTL also does it. */
export function forgetLoginSession(state) {
  return LOGIN_SESSIONS.delete(trim(state));
}

// ── small helpers ────────────────────────────────────────────────────────
function trim(value) {
  return typeof value === "string" ? value.trim() : "";
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeBase64Json(text) {
  const body = trim(text).replace(/=+$/, "");
  if (!body) return null;
  for (const encoding of ["base64url", "base64"]) {
    try {
      return JSON.parse(Buffer.from(body, encoding).toString("utf8"));
    } catch {
      // try the other alphabet / reject as "no identity", never throw
    }
  }
  return null;
}

function parseRfc3339Ms(value) {
  const text = trim(value);
  if (!text) return 0;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Object with at least one key — `{}` means "no model info" for steps ⑥a/⑥b. */
function isNonEmptyObject(value) {
  return isPlainObject(value) && Object.keys(value).length > 0;
}

function timeoutSignal() {
  return typeof AbortSignal?.timeout === "function"
    ? AbortSignal.timeout(OFFICEACE_LOGIN_CONFIG.requestTimeoutMs)
    : undefined;
}

/**
 * `fetchImpl` wins when it is not the global fetch; otherwise `proxyOptions`
 * routes through the shared proxy-aware fetch (lazy: no import side effects
 * for the plain-fetch path).
 */
function resolveFetch(fetchImpl, proxyOptions) {
  if (typeof fetchImpl === "function" && fetchImpl !== fetch) return fetchImpl;
  if (proxyOptions) {
    return async (url, init) => {
      const { proxyAwareFetch } = await import("open-sse/utils/proxyFetch.js");
      return proxyAwareFetch(url, init, proxyOptions);
    };
  }
  return typeof fetchImpl === "function" ? fetchImpl : fetch;
}

async function requestJson(fetchImpl, url, init, stage) {
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    throw new OfficeAceLoginError(
      `OfficeAce ${stage}请求失败：${error?.message || String(error)}`,
      { stage, cause: error }
    );
  }
  const status = Number(response?.status) || 0;
  let text = "";
  try {
    text = typeof response?.text === "function" ? await response.text() : "";
  } catch {
    text = "";
  }
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  return { status, ok: status >= 200 && status < 300, text, payload };
}

function signedHeaders({ method, url, headers = {}, body = "", credential }) {
  try {
    return signOfficeAceRequest({
      algorithm: "SDK",
      method,
      url,
      headers,
      body,
      credential,
      region: OFFICEACE_LOGIN_CONFIG.region,
    }).headers;
  } catch (error) {
    throw new OfficeAceLoginError(
      `OfficeAce 控制面签名失败：${error?.message || String(error)}`,
      { stage: "sign" }
    );
  }
}

// ── identity from the token response (id_token first, then refresh_token) ──
function jwtClaims(token) {
  const parts = String(token || "").split(".");
  if (parts.length < 2) return null;
  return decodeBase64Json(parts[1]);
}

function textOf(container, field) {
  const value = container && typeof container === "object" ? container[field] : null;
  return trim(typeof value === "string" ? value : "");
}

function identityOfClaims(claims) {
  const empty = { userName: "", principalId: "", accountId: "", email: "" };
  if (!isPlainObject(claims)) return empty;
  const profile = decodeBase64Json(claims.user_profile);
  const principalId = textOf(profile, "principal_id") || textOf(claims, "principal_id");
  const accountId = textOf(profile, "account_id") || textOf(claims, "account_id");
  const email = textOf(claims, "email") || textOf(profile, "email");
  for (const field of ["preferred_username", "name"]) {
    const userName = textOf(claims, field);
    if (userName) {
      const looksLikeEmail = userName.includes("@");
      return {
        userName,
        principalId,
        accountId,
        email: email || (field === "preferred_username" && looksLikeEmail ? userName : ""),
      };
    }
  }
  return { userName: textOf(profile, "account_name"), principalId, accountId, email };
}

/** Same precedence as the Rust `response_identity`: id_token, then refresh_token. */
function responseIdentity(payload) {
  let principalOnly = { userName: "", principalId: "", accountId: "", email: "" };
  for (const field of ["id_token", "refresh_token"]) {
    const identity = identityOfClaims(jwtClaims(payload?.[field]));
    if (identity.userName) return identity;
    if (!principalOnly.principalId && identity.principalId) principalOnly = identity;
  }
  return principalOnly;
}

// ── ③ authorize URL ──────────────────────────────────────────────────────
function buildAuthorizeUrl(state, challenge) {
  const { authBase, clientId, redirectUri, scope } = OFFICEACE_LOGIN_CONFIG;
  const inner =
    `${authBase}/authui/v1/oauth2/authorize` +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&code_challenge=${encodeURIComponent(challenge)}` +
    `&code_challenge_method=SHA-256` +
    `&state=${encodeURIComponent(state)}` +
    `&scope=${encodeURIComponent(scope)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code`;
  return `${authBase}/authui/login.html?service=${encodeURIComponent(inner)}`;
}

// ── ② DPoP proof (ES256 JWS, public JWK in the header, RFC 9449) ─────────
function buildDpopProof(privateKeyPem, method, url, nowMs = Date.now()) {
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(privateKeyPem);
  } catch (error) {
    throw new OfficeAceLoginError(
      `DPoP 私钥不可用：${error?.message || String(error)}`,
      { stage: "token", cause: error }
    );
  }
  const jwk = crypto.createPublicKey(privateKey).export({ format: "jwk" });
  const header = base64urlJson({
    alg: "ES256",
    typ: "dpop+jwt",
    jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
  });
  const payload = base64urlJson({
    htm: String(method || "POST").toUpperCase(),
    htu: url,
    iat: Math.floor(nowMs / 1000),
    jti: crypto.randomBytes(32).toString("hex"),
  });
  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign("sha256", Buffer.from(signingInput, "utf8"), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

// ── ① start ──────────────────────────────────────────────────────────────
async function fetchLoginState(call) {
  const url = `${OFFICEACE_LOGIN_CONFIG.cloudBase}${OFFICEACE_LOGIN_CONFIG.paths.state}`;
  const { status, payload } = await requestJson(
    call,
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: "{}",
      signal: timeoutSignal(),
    },
    "state"
  );
  const state = trim(payload?.state);
  if (!state) {
    throw new OfficeAceLoginError(`云端没给出 state（HTTP ${status}）`, { stage: "state", status });
  }
  return state;
}

/**
 * Steps ①–③. Returns the cloud state, the browser URL, the PKCE pair (the
 * verifier must survive until step ⑤) and the DPoP private key PEM (must be
 * persisted with the account — refresh signs with the SAME key).
 *
 * @returns {Promise<{state: string, authorizeUrl: string,
 *   pkce: {verifier: string, challenge: string}, dpopPrivateKeyPem: string}>}
 */
export async function startLogin({ fetchImpl = fetch, proxyOptions } = {}) {
  const call = resolveFetch(fetchImpl, proxyOptions);
  const state = await fetchLoginState(call);

  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);

  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const dpopPrivateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  rememberSession(state, { pkceVerifier: verifier, dpopPrivateKeyPem });
  return {
    state,
    authorizeUrl: buildAuthorizeUrl(state, challenge),
    pkce: { verifier, challenge },
    dpopPrivateKeyPem,
  };
}

// ── ④ poll ───────────────────────────────────────────────────────────────
/**
 * One poll. 202 → pending, 404 → expired (terminal, do not keep polling),
 * 2xx with `code` → done. Any other status throws a classified error.
 *
 * @returns {Promise<{status: "pending"|"expired"|"done", code?: string, error?: string}>}
 */
export async function pollAuthorization(state, { fetchImpl = fetch, proxyOptions } = {}) {
  const key = trim(state);
  if (!key) throw new OfficeAceLoginError("缺少 state，无法轮询授权码", { stage: "poll" });

  const call = resolveFetch(fetchImpl, proxyOptions);
  const url = `${OFFICEACE_LOGIN_CONFIG.cloudBase}${OFFICEACE_LOGIN_CONFIG.paths.code}` +
    `?state=${encodeURIComponent(key)}`;
  const { status, payload } = await requestJson(
    call,
    url,
    { method: "GET", headers: { Accept: "application/json" }, signal: timeoutSignal() },
    "poll"
  );

  if (status === 202) return { status: "pending" };
  if (status === 404) {
    // Terminal for this state: drop the local PKCE/DPoP context as well.
    forgetLoginSession(key);
    return { status: "expired", error: "授权码已失效或 state 不认识，请重新发起登录" };
  }
  if (status < 200 || status >= 300) {
    throw new OfficeAceLoginError(`取授权码返回 HTTP ${status}`, { stage: "poll", status });
  }

  if (payload?.error) {
    const message = trim(payload.error_msg) || trim(payload.error);
    forgetLoginSession(key);
    return { status: "expired", error: `云端拒绝：${message}` };
  }
  const code = trim(payload?.code) || trim(payload?.authorization_code);
  if (!code) {
    throw new OfficeAceLoginError("云端说好了，但没给授权码", { stage: "poll", status });
  }
  return { status: "done", code };
}

// ── ⑥a project_id recovery (fail-open) ───────────────────────────────────
async function resolveProjectId(call, credential) {
  const url = `${OFFICEACE_LOGIN_CONFIG.iamBase}${OFFICEACE_LOGIN_CONFIG.paths.projects}`;
  try {
    const headers = signedHeaders({ method: "GET", url, credential });
    const { status, ok, payload } = await requestJson(
      call,
      url,
      { method: "GET", headers, signal: timeoutSignal() },
      "projects"
    );
    if (!ok) return "";
    const projects = Array.isArray(payload?.projects) ? payload.projects : [];
    const match = projects.find(
      (project) =>
        trim(project?.name) === OFFICEACE_LOGIN_CONFIG.region &&
        project?.enabled !== false &&
        trim(project?.id)
    );
    return match ? trim(match.id) : "";
  } catch {
    // Missing project_id only drops one signed header — validate still passes.
    return "";
  }
}

// ── ⑥ permission validation ──────────────────────────────────────────────
async function fetchPermission(call, credential) {
  const url = `${OFFICEACE_LOGIN_CONFIG.cloudBase}${OFFICEACE_LOGIN_CONFIG.paths.permission}`;
  const { name, value } = OFFICEACE_LOGIN_CONFIG.subscriptionTypeHeader;
  const headers = signedHeaders({
    method: "GET",
    url,
    headers: { [name]: value },
    credential,
  });
  const { status, ok, payload } = await requestJson(
    call,
    url,
    { method: "GET", headers, signal: timeoutSignal() },
    "validate"
  );
  if (!ok) {
    const detail = trim(payload?.error_msg) || trim(payload?.error_code);
    throw new OfficeAceLoginError(
      `权限校验失败（HTTP ${status}）${detail ? `：${detail}` : ""}`,
      { stage: "validate", status }
    );
  }
  const modelInfo = [
    payload?.model_info,
    payload?.subscription?.model_info,
    payload?.modelInfo,
  ].find(isNonEmptyObject) || null;
  return {
    accountId: trim(payload?.account_id),
    principalId: trim(payload?.principal_id),
    modelInfo,
  };
}

// ── ⑥b provisioning ──────────────────────────────────────────────────────
const PROMOTION_HINTS = {
  "AgentArts.11000008": "邀请码无效",
  "AgentArts.11000009": "邀请码不存在或今日配额已用完",
  "AgentArts.00000104": "当前账号权限不足",
  "common.01010003": "当前账号权限不足",
  "common.01010004": "账号可能未实名认证或处于欠费状态",
};

async function subscribeModelInfo(call, credential, promotionCode = "") {
  const url = `${OFFICEACE_LOGIN_CONFIG.cloudBase}${OFFICEACE_LOGIN_CONFIG.paths.subscription}`;
  const code = trim(promotionCode);
  const body = code ? JSON.stringify({ promotion_code: code }) : "{}";
  const { name, value } = OFFICEACE_LOGIN_CONFIG.subscriptionTypeHeader;
  const headers = signedHeaders({
    method: "POST",
    url,
    headers: { "Content-Type": "application/json;charset=utf8", [name]: value },
    body,
    credential,
  });
  const { status, ok, payload } = await requestJson(
    call,
    url,
    { method: "POST", headers, body, signal: timeoutSignal() },
    "subscribe"
  );
  if (!ok) {
    const errorCode = trim(payload?.error_code);
    const detail =
      trim(payload?.error_msg) || trim(payload?.error_message) || errorCode || `HTTP ${status}`;
    const hint = PROMOTION_HINTS[errorCode];
    throw new OfficeAceLoginError(
      hint
        ? `该账号尚未开通果办服务（${hint}）：请先在 OfficeAce 客户端完成开通，再回来重新登录`
        : `开通失败（HTTP ${status}）：${detail}`,
      { stage: "subscribe", status }
    );
  }
  const modelInfo = isNonEmptyObject(payload?.model_info) ? payload.model_info : null;
  if (!modelInfo) {
    throw new OfficeAceLoginError("开通成功但云端仍未返回模型网关信息，请稍后重试", {
      stage: "subscribe",
      status,
    });
  }
  return modelInfo;
}

// ── gateway credentials out of `model_info` ──────────────────────────────
function gatewayOf(modelInfo) {
  const authInfo = isPlainObject(modelInfo?.model_auth_info) ? modelInfo.model_auth_info : {};
  const appKey = trim(authInfo.model_app_key);
  const appSecret = trim(authInfo.model_app_secret);
  if (!appKey || !appSecret) {
    throw new OfficeAceLoginError(
      "云端返回了模型信息，但缺少模型网关凭据（model_app_key / model_app_secret）",
      { stage: "gateway" }
    );
  }
  const host = trim(modelInfo?.model_api_url_base)
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  const baseUrl = host
    ? `https://${host}${host.endsWith("/v2") ? "" : "/v2"}`
    : "";
  return { appKey, appSecret, baseUrl };
}

// ── ⑤+⑥+⑦ finish ───────────────────────────────────────────────────────
function resolveLoginContext(state, pkceVerifier, dpopPrivateKeyPem) {
  const verifier = trim(pkceVerifier);
  const pem = trim(dpopPrivateKeyPem);
  if (verifier && pem) return { pkceVerifier: verifier, dpopPrivateKeyPem: pem };
  const session = peekSession(state);
  if (session?.pkceVerifier && session?.dpopPrivateKeyPem) return session;
  throw new OfficeAceLoginError(
    "登录会话已过期或 state 不匹配，请重新发起登录",
    { stage: "session" }
  );
}

/**
 * Steps ⑤–⑦: code → temp AK/SK/STS → (⑥a/⑥b if needed) → gateway Basic pair.
 *
 * @param {{state: string, code: string, pkceVerifier?: string,
 *   dpopPrivateKeyPem?: string}} input
 * @returns {Promise<{accessToken: string, refreshToken: string, expiresAt: number,
 *   expiresIn: number, providerSpecificData: object, uid: string, name: string,
 *   email: string|null}>}
 */
export async function finishLogin(
  { state, code, pkceVerifier, dpopPrivateKeyPem } = {},
  { fetchImpl = fetch, proxyOptions } = {}
) {
  const authCode = trim(code);
  if (!authCode) throw new OfficeAceLoginError("缺少授权码", { stage: "token" });
  const context = resolveLoginContext(state, pkceVerifier, dpopPrivateKeyPem);
  const call = resolveFetch(fetchImpl, proxyOptions);

  const { clientId, redirectUri, tokenUrl } = OFFICEACE_LOGIN_CONFIG;
  const form = new URLSearchParams({
    client_id: clientId,
    code: authCode,
    code_verifier: context.pkceVerifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  }).toString();

  let dpop;
  try {
    dpop = buildDpopProof(context.dpopPrivateKeyPem, "POST", tokenUrl);
  } catch (error) {
    if (error instanceof OfficeAceLoginError) throw error;
    throw new OfficeAceLoginError(
      `生成 DPoP proof 失败：${error?.message || String(error)}`,
      { stage: "token", cause: error }
    );
  }

  const tokenResponse = await requestJson(
    call,
    tokenUrl,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        DPoP: dpop,
      },
      body: form,
      signal: timeoutSignal(),
    },
    "token"
  );
  if (!tokenResponse.ok) {
    // Never echo the form (it carries the one-time code); only the error text.
    const payload = tokenResponse.payload;
    const detail =
      trim(payload?.error_description) || trim(payload?.error_msg) || trim(payload?.error);
    throw new OfficeAceLoginError(
      `令牌端点被拒（HTTP ${tokenResponse.status}）${detail ? `：${detail}` : ""}`,
      { stage: "token", status: tokenResponse.status }
    );
  }

  const payload = tokenResponse.payload || {};
  const temporary = isPlainObject(payload.credentials) ? payload.credentials : {};
  const accessKeyId = trim(temporary.access_key_id);
  const secretAccessKey = trim(temporary.secret_access_key);
  if (!accessKeyId || !secretAccessKey) {
    throw new OfficeAceLoginError(
      `令牌端点没返回临时凭据（HTTP ${tokenResponse.status}）`,
      { stage: "token", status: tokenResponse.status }
    );
  }

  const expiresAt =
    parseRfc3339Ms(temporary.expiration) || Date.now() + 2 * 60 * 60 * 1000;
  const securityToken = trim(temporary.security_token);
  const identity = responseIdentity(payload);
  const refreshToken = trim(payload.refresh_token);

  const credential = { accessKeyId, secretAccessKey, securityToken, projectId: "" };
  let projectId = trim(temporary.project_id);
  if (!projectId) projectId = await resolveProjectId(call, credential);
  credential.projectId = projectId;

  const permission = await fetchPermission(call, credential);
  const modelInfo = permission.modelInfo || (await subscribeModelInfo(call, credential));
  const gateway = gatewayOf(modelInfo);

  const uid = permission.accountId || identity.accountId || permission.principalId || identity.principalId;
  const name = identity.userName || permission.accountId || "";
  const email = identity.email || null;

  const providerSpecificData = {
    authMethod: "oauth",
    region: OFFICEACE_LOGIN_CONFIG.region,
    baseUrl: gateway.baseUrl,
    modelAppKey: gateway.appKey,
    modelAppSecret: gateway.appSecret,
    accessKeyId,
    secretAccessKey,
    securityToken,
    projectId,
    // Control-plane credentials live 2h; the gateway Basic pair does not expire.
    expiresAt,
    refreshToken,
    // Refresh signs its DPoP proof with THIS key — losing it forces a re-login.
    dpopPrivateKeyPem: context.dpopPrivateKeyPem,
    accountId: uid,
    principalId: permission.principalId || identity.principalId || "",
    name,
  };
  if (email) providerSpecificData.email = email;

  forgetLoginSession(state);

  return {
    // `key:secret` — executors/officeace.js turns this into the Basic header.
    accessToken: `${gateway.appKey}:${gateway.appSecret}`,
    refreshToken,
    expiresAt,
    expiresIn: Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)),
    providerSpecificData,
    uid,
    name,
    email,
  };
}

/**
 * Refresh the 2h temporary AK/SK/STS with the rotating refresh token.
 *
 * The STS refresh grant is DPoP-bound to the SAME P-256 key used at login;
 * no PKCE verifier is sent on this grant (unlike the authorization_code call).
 * The gateway Basic pair in `accessToken` never expires and is intentionally
 * not returned — the caller merges `providerSpecificData` over the old row.
 *
 * @param {{refreshToken?: string, dpopPrivateKeyPem?: string}} input
 * @returns {Promise<{refreshToken: string, expiresAt: number, expiresIn: number, providerSpecificData: object}>}
 */
export async function refresh(
  { refreshToken, dpopPrivateKeyPem } = {},
  { fetchImpl = fetch, proxyOptions } = {}
) {
  const token = trim(refreshToken);
  if (!token) {
    throw new OfficeAceLoginError("OfficeAce 账号没有 refresh token，只能重新登录授权", {
      stage: "token",
      status: 400,
    });
  }
  const pem = trim(dpopPrivateKeyPem);
  if (!pem) {
    throw new OfficeAceLoginError("OfficeAce 缺少 DPoP 私钥，无法续期，请重新登录", {
      stage: "token",
      status: 400,
    });
  }

  const { clientId, tokenUrl } = OFFICEACE_LOGIN_CONFIG;
  const form = new URLSearchParams({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: token,
  }).toString();
  const dpop = buildDpopProof(pem, "POST", tokenUrl);
  const call = resolveFetch(fetchImpl, proxyOptions);
  const response = await requestJson(
    call,
    tokenUrl,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        DPoP: dpop,
      },
      body: form,
      signal: timeoutSignal(),
    },
    "token"
  );
  if (!response.ok) {
    const detail = trim(response.payload?.error_description)
      || trim(response.payload?.error_msg)
      || trim(response.payload?.error);
    throw new OfficeAceLoginError(
      `OfficeAce 续期被拒（HTTP ${response.status}）${detail ? `：${detail}` : ""}`,
      { stage: "token", status: response.status }
    );
  }

  const payload = response.payload || {};
  const temporary = isPlainObject(payload.credentials) ? payload.credentials : {};
  const accessKeyId = trim(temporary.access_key_id);
  const secretAccessKey = trim(temporary.secret_access_key);
  if (!accessKeyId || !secretAccessKey) {
    throw new OfficeAceLoginError("OfficeAce 续期没有返回新的临时凭据", {
      stage: "token",
      status: response.status,
    });
  }
  const expiresAt = parseRfc3339Ms(temporary.expiration) || Date.now() + 2 * 60 * 60 * 1000;
  const nextRefresh = trim(payload.refresh_token) || token;
  const securityToken = trim(temporary.security_token);
  const projectId = trim(temporary.project_id);

  return {
    refreshToken: nextRefresh,
    expiresAt,
    expiresIn: Math.max(1, Math.floor((expiresAt - Date.now()) / 1000)),
    providerSpecificData: {
      authMethod: "oauth",
      accessKeyId,
      secretAccessKey,
      securityToken,
      ...(projectId ? { projectId } : {}),
      expiresAt,
      refreshToken: nextRefresh,
      dpopPrivateKeyPem: pem,
    },
  };
}
