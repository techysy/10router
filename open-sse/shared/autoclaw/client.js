// AutoClaw（智谱澳龙）account-plane + chat shaping helpers.
//
// Pure functions + thin fetch wrappers, no DB access: routes / refresh
// handlers / executors own persistence. Every network helper takes
// `{ fetchImpl, proxyOptions }` so tests can stub the wire.
//
// Envelope rule (official client: `if (envelope.code === 0)`): the account
// plane answers HTTP 200 for business failures too — success is judged on
// body.code, never on the HTTP status.

import crypto from "node:crypto";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import {
  AUTOCLAW_APP_ID,
  AUTOCLAW_APP_KEY,
  AUTOCLAW_PRODUCT,
  AUTOCLAW_SOURCE_ID,
  AUTOCLAW_REGIONS,
  AUTOCLAW_PATHS,
  AUTOCLAW_REFRESH_FALLBACK_CODE,
  AUTOCLAW_DAILY_SIGNIN_TASK,
  AUTOCLAW_OAUTH_HOSTS,
  AUTOCLAW_OAUTH_TRUSTED_DOMAINS,
  AUTOCLAW_OAUTH_VENDORS,
  AUTOCLAW_BUSINESS_CODES,
  AUTOCLAW_HTTP_TIMEOUT_MS,
  AUTOCLAW_FALLBACK_EXPIRES_IN_S,
  AUTOCLAW_BANNER,
  AUTOCLAW_FORBIDDEN_FIELDS,
  AUTOCLAW_STRIP_FIELDS,
  AUTOCLAW_FOREIGN_IDENTITY_PHRASES,
  AUTOCLAW_FOREIGN_IDENTITY_REPLACEMENT,
  AUTOCLAW_FOREIGN_IDENTITY_REPLACEMENTS,
  AUTOCLAW_REASONING_LEVELS,
  AUTOCLAW_DEFAULT_MODEL,
  stripAutoclawModelPrefix,
} from "./constants.js";

export class AutoclawApiError extends Error {
  constructor(message, { code = null, status = null, data = null, signIn = null } = {}) {
    super(message);
    this.name = "AutoclawApiError";
    this.code = code;
    this.status = status;
    this.data = data;
    // "expired" = the login itself is dead (re-authorization required)
    this.signIn = signIn;
  }
}

// ── Token helpers ───────────────────────────────────────────────────────────

/** Strip any (possibly repeated) "Bearer " prefix: desktop-exported tokens carry one. */
export function bareToken(value) {
  let t = String(value ?? "").trim();
  while (t.toLowerCase().startsWith("bearer ")) t = t.slice(7).trim();
  return t;
}

/** Decode a JWT payload without verifying (only our own account's claims). */
export function jwtPayload(token) {
  const part = bareToken(token).split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

export function jwtClaim(token, key) {
  const payload = jwtPayload(token);
  return payload && Object.prototype.hasOwnProperty.call(payload, key) ? payload[key] : undefined;
}

/**
 * Which account system a token belongs to: JWT source_id starting with
 * "agent" = CN (SMS); any other source_id = intl (OAuth); undecodable =
 * null (caller falls back to the connection's provider id).
 */
export function autoclawRegionOfToken(token) {
  const sid = jwtClaim(token, "source_id");
  if (typeof sid !== "string" || !sid) return null;
  return /^agent/i.test(sid) ? "cn" : "intl";
}

/** Region for a connection: token claim first (refresh, then access), provider id second. */
export function autoclawRegionFor(provider, credentials = {}) {
  return (
    autoclawRegionOfToken(credentials?.refreshToken) ||
    autoclawRegionOfToken(credentials?.accessToken) ||
    (provider === "autoclaw-cn" ? "cn" : "intl")
  );
}

export function autoclawRegionConfig(region) {
  return AUTOCLAW_REGIONS[region === "cn" ? "cn" : "intl"];
}

/** Account hosts to try, home region first (refresh host matching rule). */
export function autoclawHostOrder(region) {
  return region === "cn"
    ? [AUTOCLAW_REGIONS.cn.accountHost, AUTOCLAW_REGIONS.intl.accountHost]
    : [AUTOCLAW_REGIONS.intl.accountHost, AUTOCLAW_REGIONS.cn.accountHost];
}

/** epoch-ms expiry from the access JWT; falls back to expires_in / 5h. */
export function autoclawExpiresIn(data) {
  const exp = jwtClaim(data?.access_token, "exp");
  if (typeof exp === "number" && Number.isFinite(exp) && exp > 0) {
    return Math.max(1, Math.floor(exp - Date.now() / 1000));
  }
  const ei = Number(data?.expires_in);
  return Number.isFinite(ei) && ei > 0 ? ei : AUTOCLAW_FALLBACK_EXPIRES_IN_S;
}

/**
 * Stable per-install device id (64 hex, the official client's shape). The
 * account plane binds device_id into the JWT and re-checks it on refresh, so
 * oauth-url / oauth-login / sms-login / refresh must all send the same one.
 */
export async function autoclawDeviceId() {
  // Lazy: this module sits on DefaultExecutor's import chain (via the refresh
  // handlers) — a static node-machine-id import would load the native-id
  // probe into every executor consumer.
  const { getConsistentMachineId } = await import("../machineId.js");
  const seed = await getConsistentMachineId("autoclaw-device-id");
  return crypto.createHash("sha256").update(`autoclaw:${seed}`).digest("hex");
}

// ── Headers ─────────────────────────────────────────────────────────────────

/** Official client X-Tm: win | mac | linux-x64 (bare "linux" → overseas 403). */
export function autoclawPlatformTm(platform = process.platform) {
  if (platform === "win32") return "win";
  if (platform === "darwin") return "mac";
  return "linux-x64";
}

export function autoclawUserAgent(region) {
  return `AutoClaw/${autoclawRegionConfig(region).version}`;
}

/** X-Auth-* managed-layer signature: md5(appId&ts&appKey), recomputed per call. */
export function autoclawSignHeaders(nowMs = Date.now()) {
  const ts = String(Math.floor(nowMs / 1000));
  return {
    "X-Auth-Appid": AUTOCLAW_APP_ID,
    "X-Auth-TimeStamp": ts,
    "X-Auth-Sign": crypto.createHash("md5").update(`${AUTOCLAW_APP_ID}&${ts}&${AUTOCLAW_APP_KEY}`).digest("hex"),
  };
}

/** Client identity headers (managed layer). Never X-Harness-Type: 406 on 2.x. */
export function autoclawIdentityHeaders(region) {
  const cfg = autoclawRegionConfig(region);
  return {
    "User-Agent": autoclawUserAgent(region),
    "X-Version": cfg.version,
    "X-Tm": autoclawPlatformTm(),
    "X-Product": AUTOCLAW_PRODUCT,
    "X-Channel": cfg.channel,
    "X-Lang": "zh-CN",
    "X-Client-Type": "pc",
  };
}

/** Account-plane headers (login / refresh / wallets / tasks). */
export function autoclawBizHeaders(region, accessToken = null) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "*/*",
    ...autoclawIdentityHeaders(region),
    ...autoclawSignHeaders(),
    "X-Trace-Id": crypto.randomBytes(8).toString("hex"),
    Origin: "http://localhost:18432",
    Referer: "http://localhost:18432/",
  };
  if (accessToken) headers.Authorization = `Bearer ${bareToken(accessToken)}`;
  return headers;
}

// ── Envelope ────────────────────────────────────────────────────────────────

function defaultFetch(proxyOptions) {
  return (url, init) => proxyAwareFetch(url, init, proxyOptions);
}

export function explainAutoclawCode(code) {
  const n = Number(code);
  return Number.isInteger(n) ? AUTOCLAW_BUSINESS_CODES[n] || null : null;
}

/**
 * POST an account-plane endpoint with source_id + device_id merged into the
 * body. Returns `data` on code===0; throws AutoclawApiError otherwise.
 */
export async function autoclawPost(host, path, payload, {
  region = "intl",
  accessToken = null,
  deviceId = null,
  fetchImpl = null,
  proxyOptions = null,
} = {}) {
  const doFetch = fetchImpl || defaultFetch(proxyOptions);
  const body = {
    ...(payload || {}),
    source_id: AUTOCLAW_SOURCE_ID,
    device_id: deviceId || (await autoclawDeviceId()),
  };
  let res;
  let text = "";
  try {
    res = await doFetch(`${host}${path}`, {
      method: "POST",
      headers: autoclawBizHeaders(region, accessToken),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(AUTOCLAW_HTTP_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (e) {
    throw new AutoclawApiError(`AutoClaw 账号面请求失败: ${e?.message || e}`);
  }
  let env = null;
  try { env = text ? JSON.parse(text) : null; } catch { env = null; }
  if (!env || typeof env !== "object") {
    const dead = res.status === 401 || res.status === 403;
    throw new AutoclawApiError(
      `AutoClaw 账号面返回非 JSON（HTTP ${res.status}）: ${String(text).slice(0, 120)}`,
      { status: res.status, signIn: dead ? "expired" : null },
    );
  }
  if (env.code !== 0) {
    const reason = explainAutoclawCode(env.code);
    const msg = reason ? `${reason}${env.msg ? `（上游：${env.msg}）` : ""}` : env.msg || `AutoClaw 业务失败 (code ${env.code})`;
    throw new AutoclawApiError(msg, { code: env.code ?? null, status: res.status, data: env });
  }
  return env.data && typeof env.data === "object" ? env.data : {};
}

/** Login / refresh response → normalized pair (snake_case upstream). */
export function autoclawTokenFields(data, fallbackRefresh = null) {
  const accessToken = bareToken(data?.access_token);
  if (!accessToken) throw new AutoclawApiError("AutoClaw 响应里没有 access_token", { data });
  const refreshToken = bareToken(data?.refresh_token || fallbackRefresh || "");
  if (!refreshToken) throw new AutoclawApiError("AutoClaw 响应里没有 refresh_token", { data });
  return {
    accessToken,
    refreshToken,
    expiresIn: autoclawExpiresIn(data),
    userId: data?.user_id != null ? String(data.user_id) : null,
    userPhone: typeof data?.user_phone === "string" ? data.user_phone : null,
    userName: typeof data?.user_name === "string" ? data.user_name : null,
  };
}

// ── CN: phone SMS login ─────────────────────────────────────────────────────

/** All-digit codes go out as a NUMBER — the endpoint type-checks (string → 400001). */
export function autoclawSmsCodeValue(code) {
  const s = String(code ?? "").trim();
  return /^\d+$/.test(s) ? Number(s) : s;
}

export async function sendAutoclawSmsCode(phone, opts = {}) {
  await autoclawPost(AUTOCLAW_REGIONS.cn.accountHost, AUTOCLAW_PATHS.smsSend, { phone }, { ...opts, region: "cn" });
  return { sent: true };
}

export async function loginAutoclawBySms({ phone, code }, opts = {}) {
  const data = await autoclawPost(
    AUTOCLAW_REGIONS.cn.accountHost,
    AUTOCLAW_PATHS.smsLogin,
    { phone, code: autoclawSmsCodeValue(code) },
    { ...opts, region: "cn" },
  );
  const fields = autoclawTokenFields(data);
  if (!fields.userId) throw new AutoclawApiError("登录响应不完整（需要 access_token / refresh_token / user_id）", { data });
  return fields;
}

// ── Intl: web OAuth ─────────────────────────────────────────────────────────

export function normalizeAutoclawVendor(vendor) {
  return AUTOCLAW_OAUTH_VENDORS.includes(vendor) ? vendor : AUTOCLAW_OAUTH_VENDORS[0];
}

/** https + no credentials + no port + vendor's trusted domain (exact or subdomain). */
export function isTrustedAutoclawAuthorizeUrl(url, vendor) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
    const host = u.hostname.toLowerCase();
    const domains = AUTOCLAW_OAUTH_TRUSTED_DOMAINS[normalizeAutoclawVendor(vendor)] || [];
    return domains.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

/**
 * Aliyun slider-captcha config for the intl OAuth start ({ enabled, region,
 * prefix, scene_id, captcha_supplier }). When enabled (live-observed
 * 2026-11-24: enabled:true, scene 18vhnjxl), oauth-url without an
 * ali_captcha_verify_param receipt answers 400001 — the receipt can only be
 * produced by the Aliyun SDK running in the user's browser.
 */
export async function getAutoclawCaptchaConfig(opts = {}) {
  const data = await autoclawPost(AUTOCLAW_REGIONS.intl.accountHost, AUTOCLAW_PATHS.captchaConfig, {}, { ...opts, region: "intl" });
  return {
    enabled: data?.enabled === true,
    region: typeof data?.region === "string" ? data.region : null,
    prefix: typeof data?.prefix === "string" ? data.prefix : null,
    sceneId: typeof data?.scene_id === "string" ? data.scene_id : null,
    supplier: typeof data?.captcha_supplier === "string" ? data.captcha_supplier : null,
  };
}

/**
 * Step 1 — ask the account plane for the vendor authorize URL. The returned
 * URL carries the upstream `state`; the callback echoes it back and
 * oauth-login re-checks it.
 */
export async function getAutoclawOAuthUrl({ vendor, navigateUri, captchaVerifyParam = null }, opts = {}) {
  const v = normalizeAutoclawVendor(vendor);
  const payload = { navigate_uri: navigateUri };
  if (captchaVerifyParam) payload.ali_captcha_verify_param = captchaVerifyParam;
  const data = await autoclawPost(AUTOCLAW_REGIONS.intl.accountHost, AUTOCLAW_PATHS.oauthUrl(v), payload, { ...opts, region: "intl" });
  const authorizeUrl = String(data.oauth_url || data.url || data.login_url || data.auth_url || data.verify_url || "").trim();
  if (!authorizeUrl) throw new AutoclawApiError("AutoClaw 未返回授权页地址", { data });
  if (!isTrustedAutoclawAuthorizeUrl(authorizeUrl, v)) {
    let got = "?";
    try { got = new URL(authorizeUrl).hostname; } catch { /* unparsable */ }
    throw new AutoclawApiError(`授权链接 host（${got}）不在 ${v} 的可信域名（${AUTOCLAW_OAUTH_TRUSTED_DOMAINS[v].join(" / ")}）内，已拒绝`, { data });
  }
  let state = null;
  try { state = new URL(authorizeUrl).searchParams.get("state"); } catch { /* checked above */ }
  if (!state) throw new AutoclawApiError("授权链接缺少 state，已拒绝（防回调劫持）", { data });
  return { authorizeUrl, state, vendor: v };
}

/** Step 2 — callback code + state → token pair. */
export async function exchangeAutoclawOAuthCode({ vendor, code, state, navigateUri }, opts = {}) {
  if (!code || !state) throw new AutoclawApiError("回调里没有 code 或 state（授权被取消？）");
  const v = normalizeAutoclawVendor(vendor);
  const data = await autoclawPost(
    AUTOCLAW_REGIONS.intl.accountHost,
    AUTOCLAW_PATHS.oauthLogin(v),
    { code, state, navigate_uri: navigateUri },
    { ...opts, region: "intl" },
  );
  const fields = autoclawTokenFields(data);
  if (!fields.userId) throw new AutoclawApiError("登录响应不完整（需要 access_token / refresh_token / user_id）", { data });
  return fields;
}

// ── Refresh ─────────────────────────────────────────────────────────────────

const DEAD_LOGIN_RE = /invalid_grant|revoked|expired|登录已失效|未登录|重新登录|token\s*失效/i;
// 400000 "用户未登录，请重新登录" is what /refresh answers (HTTP 200) for a
// dead or foreign refresh token (live-observed 2026-11-24).
const DEAD_LOGIN_CODES = new Set([400000, 631016]);

export function isAutoclawDeadLogin(e) {
  return e?.signIn === "expired"
    || e?.status === 401
    || e?.status === 403
    || DEAD_LOGIN_CODES.has(Number(e?.code))
    || DEAD_LOGIN_RE.test(String(e?.message || ""));
}

/**
 * Refresh with host matching: SMS accounts (source_id agent*) try the CN host
 * first, OAuth accounts the global host first. Per host: /refresh, then
 * /agent-refresh when the first hop answers code 400002. The response's
 * `refresh` field is a BOOL — the new token is `refresh_token`. Treat the
 * refresh token as single-use rotation (the caller persists the returned
 * one atomically), even though AutoClaw2api observed the old one staying
 * valid: persisting the newest is correct either way.
 *
 * Returns { accessToken, refreshToken, expiresIn } on success;
 * { error: "invalid_grant" } only when EVERY host declared the login dead
 * (a token is foreign on the other region's host, so one dead verdict is not
 * enough); null for transient failures.
 */
export async function refreshAutoclawCredentials(refreshToken, { region = null, fetchImpl = null, proxyOptions = null, log = null } = {}) {
  const rt = bareToken(refreshToken);
  if (!rt) return null;
  // The token's own source_id wins; `region` (the connection's card) is the
  // fallback for an undecodable token.
  const home = autoclawRegionOfToken(rt) || region || "intl";
  const deviceId = (typeof jwtClaim(rt, "device_id") === "string" && jwtClaim(rt, "device_id")) || (await autoclawDeviceId());
  let allDead = true;
  let lastError = null;
  for (const host of autoclawHostOrder(home)) {
    let hostDead = false;
    for (const path of [AUTOCLAW_PATHS.refresh, AUTOCLAW_PATHS.refreshAlt]) {
      try {
        const data = await autoclawPost(host, path, { refresh_token: rt }, {
          region: home, deviceId, fetchImpl, proxyOptions,
        });
        const fields = autoclawTokenFields(data, rt);
        return { accessToken: fields.accessToken, refreshToken: fields.refreshToken, expiresIn: fields.expiresIn };
      } catch (e) {
        lastError = e;
        hostDead = isAutoclawDeadLogin(e);
        // Only a 400002 on the first hop earns the /agent-refresh second hop.
        if (path === AUTOCLAW_PATHS.refresh && Number(e?.code) === AUTOCLAW_REFRESH_FALLBACK_CODE) continue;
        break;
      }
    }
    if (!hostDead) allDead = false;
  }
  log?.warn?.("TOKEN_REFRESH", `autoclaw refresh failed: ${lastError?.message || "unknown"}`);
  return allDead && lastError ? { error: "invalid_grant" } : null;
}

// ── Account plane: profile / wallets / daily sign-in ─────────────────────────

async function autoclawGet(host, path, accessToken, { region, fetchImpl, proxyOptions } = {}) {
  const doFetch = fetchImpl || defaultFetch(proxyOptions);
  const res = await doFetch(`${host}${path}`, {
    method: "GET",
    headers: autoclawBizHeaders(region, accessToken),
    signal: AbortSignal.timeout(AUTOCLAW_HTTP_TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) {
    throw new AutoclawApiError(`AutoClaw 登录已失效（HTTP ${res.status}）`, { status: res.status, signIn: "expired" });
  }
  const env = await res.json().catch(() => null);
  // The task-list endpoint answers a bare `{ data: [...] }` with no `code`
  // (live-verified 2026-11-24 on the CN managed host); the asset plane uses
  // the usual `{ code: 0, data }` envelope. Accept both, reject any explicit
  // non-zero code.
  const bareData = env && !("code" in env) && "data" in env;
  if (!env || (!bareData && env.code !== 0)) {
    throw new AutoclawApiError(env?.msg || `AutoClaw ${path.split("?")[0]} 失败（HTTP ${res.status}）`, { code: env?.code ?? null, status: res.status });
  }
  return env.data;
}

export async function fetchAutoclawProfile(accessToken, { region = "intl", ...opts } = {}) {
  try {
    return await autoclawPost(autoclawRegionConfig(region).accountHost, AUTOCLAW_PATHS.userProfile, {}, { ...opts, region, accessToken });
  } catch {
    return null;
  }
}

/** Display name: nickname → masked phone → fallback. */
export function autoclawDisplayName(profile, fallback) {
  const name = String(profile?.user_name || profile?.nickname || "").trim();
  if (name) return name;
  const phone = String(profile?.user_phone || "").trim();
  if (phone.length >= 7) return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
  return fallback;
}

/** Wallet snapshot { total_balance, wallets[] } — null when unreadable (≠ zero). */
export async function fetchAutoclawWallets(accessToken, { region = "intl", ...opts } = {}) {
  return autoclawGet(autoclawRegionConfig(region).accountHost, AUTOCLAW_PATHS.wallets, accessToken, { ...opts, region });
}

export async function fetchAutoclawTasks(accessToken, { region = "intl", ...opts } = {}) {
  const data = await autoclawGet(autoclawRegionConfig(region).accountHost, AUTOCLAW_PATHS.taskList, accessToken, { ...opts, region });
  return Array.isArray(data) ? data : [];
}

/**
 * Daily sign-in (idempotent server-side). The task endpoint, not the
 * documented /userapi/v1/user-info claim, is the one that actually pays.
 * Returns { claimed, already, points, streak, message }.
 */
export async function claimAutoclawDailySignin(accessToken, { region = "intl", fetchImpl = null, proxyOptions = null } = {}) {
  const doFetch = fetchImpl || defaultFetch(proxyOptions);
  const res = await doFetch(`${autoclawRegionConfig(region).accountHost}${AUTOCLAW_PATHS.taskComplete}`, {
    method: "POST",
    headers: autoclawBizHeaders(region, accessToken),
    body: JSON.stringify({ task_id: AUTOCLAW_DAILY_SIGNIN_TASK, source_id: AUTOCLAW_SOURCE_ID }),
    signal: AbortSignal.timeout(AUTOCLAW_HTTP_TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) {
    throw new AutoclawApiError(`AutoClaw 登录已失效（HTTP ${res.status}）`, { status: res.status, signIn: "expired" });
  }
  const env = await res.json().catch(() => null);
  const d = env?.data || {};
  const points = Number(d.reward_points) || 0;
  const streak = Number(d.continuous_days) || 0;
  if (d.success) {
    return { claimed: true, already: false, points, streak, message: `已签到 +${points}${streak ? ` · 连续 ${streak} 天` : ""}` };
  }
  if (d.already_completed) return { claimed: false, already: true, points, streak, message: "今日已签到" };
  return { claimed: false, already: false, points: 0, streak: 0, message: String(d.message || env?.msg || "签到失败") };
}

// ── Chat body shaping ───────────────────────────────────────────────────────

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Neutralize foreign harness identities (2.x denylist → 406). Returns { text, hits }. */
export function neutralizeForeignIdentity(text) {
  if (typeof text !== "string" || !text) return { text, hits: [] };
  const hits = [];
  let out = text;
  for (const phrase of AUTOCLAW_FOREIGN_IDENTITY_PHRASES) {
    if (!out.toLowerCase().includes(phrase)) continue;
    hits.push(phrase);
    const repl = AUTOCLAW_FOREIGN_IDENTITY_REPLACEMENTS[phrase] || AUTOCLAW_FOREIGN_IDENTITY_REPLACEMENT;
    out = out.replace(new RegExp(escapeRegExp(phrase), "gi"), repl);
  }
  return { text: out, hits };
}

/**
 * Ensure every system message carries the 2.x banner (prepended) with foreign
 * identities neutralized; add a banner-only system message when there is none.
 * Never mutates the caller's messages.
 */
export function ensureAutoclawBanner(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let hasSystem = false;
  const out = list.map((m) => {
    if (!m || typeof m !== "object" || m.role !== "system") return m;
    hasSystem = true;
    const cp = { ...m };
    if (typeof cp.content === "string") {
      const { text } = neutralizeForeignIdentity(cp.content);
      cp.content = text.includes(AUTOCLAW_BANNER) ? text : `${AUTOCLAW_BANNER}\n\n${text}`;
    } else if (Array.isArray(cp.content)) {
      let bannered = false;
      cp.content = cp.content.map((part) => {
        if (!part || part.type !== "text" || typeof part.text !== "string") return part;
        const { text } = neutralizeForeignIdentity(part.text);
        if (text.includes(AUTOCLAW_BANNER)) bannered = true;
        return { ...part, text };
      });
      if (!bannered) {
        const i = cp.content.findIndex((p) => p?.type === "text");
        if (i >= 0) cp.content[i] = { ...cp.content[i], text: `${AUTOCLAW_BANNER}\n\n${cp.content[i].text}` };
        else cp.content = [{ type: "text", text: AUTOCLAW_BANNER }, ...cp.content];
      }
    }
    return cp;
  });
  return hasSystem ? out : [{ role: "system", content: AUTOCLAW_BANNER }, ...out];
}

/** Map any client effort onto the upstream's low / high / max variants. */
export function normalizeAutoclawEffort(effort) {
  const e = String(effort || "").toLowerCase();
  if (!e) return null;
  if (AUTOCLAW_REASONING_LEVELS.includes(e)) return e;
  if (e === "none" || e === "minimal") return "low";
  if (e === "medium") return "high";
  if (e === "xhigh" || e === "ultra") return "max";
  return null;
}

/**
 * OpenAI chat body → AutoClaw upstream body: banner + identity
 * neutralization, forbidden/unsupported fields stripped, model prefix
 * stripped, reasoning effort clamped. Returns a new object.
 */
export function sanitizeAutoclawBody(body, model) {
  const src = body && typeof body === "object" ? body : {};
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (AUTOCLAW_STRIP_FIELDS.includes(k) || AUTOCLAW_FORBIDDEN_FIELDS.includes(k)) continue;
    out[k] = v;
  }
  out.messages = ensureAutoclawBanner(src.messages);
  out.model = stripAutoclawModelPrefix(autoclawRouteModel(model || src.model));
  if (out.reasoning_effort !== undefined) {
    const eff = normalizeAutoclawEffort(out.reasoning_effort);
    if (eff) out.reasoning_effort = eff;
    else delete out.reasoning_effort;
  }
  return out;
}

/** X-Request-Model must be the FULL upstream route id (zai_auto, not auto). */
export function autoclawRouteModel(model) {
  const m = String(model || "").trim();
  return m || AUTOCLAW_DEFAULT_MODEL;
}
