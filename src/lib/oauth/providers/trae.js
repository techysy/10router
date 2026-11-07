import crypto from "crypto";
import { TRAE_CONFIG } from "../constants/oauth.js";
import { extractJsonPath } from "./_shared.js";

// ───────────────────────────────────────────────────────────────────────────
// Trae (ByteDance marscode) OAuth helpers
// ───────────────────────────────────────────────────────────────────────────

// Per-login device context. No IDE access in 10router, so use stable defaults.
function buildTraeDeviceContext() {
  return {
    plugin_version: TRAE_CONFIG.defaultPluginVersion,
    machine_id: crypto.randomUUID(),
    device_id: TRAE_CONFIG.defaultDeviceId,
    x_device_brand: "unknown",
    x_device_type: "unknown",
    x_os_version: "unknown",
    x_env: "",
    x_app_version: TRAE_CONFIG.defaultAppVersion,
    x_app_type: TRAE_CONFIG.defaultAppType,
  };
}

// PKCE S256（新版授权，muskke 考古）：verifier 只留服务端 pending 表，
// authorize URL 只带 challenge。
function generateTraePKCE() {
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// v3 AuthCode 换票的 DevicePublicKey：官方客户端每次换票生成一把临时 EC P-256
// 公钥（SPKI PEM）随 DeviceInfo 上送，服务端只存不用，照抄生成即可。
function generateDevicePublicKey() {
  const { publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return publicKey.export({ type: "spki", format: "pem" }).toString();
}

// prepareConfig 时登记、exchangeToken 时按 loginTraceID 消费——PKCE verifier 必须跨
// authorize → exchange 两步一致，而 exchangeTokens 会重跑 prepareConfig（verifier
// 不能放 config 里传过去）。10 分钟未消费自动作废（对齐 oauthTimeoutMs）。
const PENDING_TTL_MS = 10 * 60 * 1000;
const pendingTraeLogins = new Map();
function rememberTraePending(loginTraceID, entry) {
  const now = Date.now();
  for (const [k, v] of pendingTraeLogins) {
    if (now - v.createdAt > PENDING_TTL_MS) pendingTraeLogins.delete(k);
  }
  pendingTraeLogins.set(loginTraceID, { ...entry, createdAt: now });
}
function takeTraePending(loginTraceID) {
  if (!loginTraceID) return null;
  const entry = pendingTraeLogins.get(loginTraceID);
  if (!entry) return null;
  pendingTraeLogins.delete(loginTraceID);
  return entry;
}

// ── Ecosystem (intl / cn) ──────────────────────────────────────────────────
// Trae 国内站 (www.trae.cn) 与国际站 (www.trae.ai) 共用同一套 cloudide 接口形态，
// 但**账号不互通**：国内发的 refresh token 拿到国际站换，必回 20101
// "refresh token is invalid"（反之亦然）。所以整条登录链路都按站点分叉。
export function normalizeTraeRegion(value) {
  const v = String(value || "").trim().toLowerCase();
  if (v === "cn" || v === "china" || v === "mainland") return "cn";
  return "intl";
}

// 从一次回调 / 已存的 loginHost 判断站点；判不出时回落到传入的 defaultRegion。
export function traeRegionFromHost(host, defaultRegion = "intl") {
  const h = String(host || "").trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
  if (!h) return normalizeTraeRegion(defaultRegion);
  // 先判 cn：trae.com.cn 同时是 trae.cn / trae.com 的子串陷阱
  if (TRAE_CONFIG.cnHostSuffixes.some((s) => h === s || h.endsWith(`.${s}`))) return "cn";
  if (TRAE_CONFIG.intlHostSuffixes.some((s) => h === s || h.endsWith(`.${s}`))) return "intl";
  return normalizeTraeRegion(defaultRegion);
}

function traeLoginGuidanceUrls(region) {
  return normalizeTraeRegion(region) === "cn"
    ? TRAE_CONFIG.cnLoginGuidanceUrls
    : TRAE_CONFIG.loginGuidanceUrls;
}

// POST GetLoginGuidance → { Result: { LoginHost } }
// region 决定打哪一家的网关；返回的 LoginHost 就是该站点的登录域名
// （intl → www.trae.ai，cn → www.trae.cn），后续 authorize 完全跟着它走。
async function fetchTraeLoginGuidance(loginTraceId, region = "intl") {
  const body = JSON.stringify({ loginTraceID: loginTraceId, login_trace_id: loginTraceId });
  let lastErr = "no successful response";
  for (const url of traeLoginGuidanceUrls(region)) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": TRAE_CONFIG.userAgent,
        },
        body,
      });
      if (!res.ok) { lastErr = `${url} HTTP ${res.status}`; continue; }
      const data = await res.json();
      const loginHost = extractJsonPath(data, [
        ["Result", "LoginHost"], ["Result", "loginHost"], ["Result", "LoginURL"],
        ["result", "loginHost"], ["data", "Result", "LoginHost"], ["data", "loginHost"],
        ["LoginHost"], ["loginHost"],
      ]);
      if (loginHost) return loginHost;
      lastErr = `${url} missing LoginHost`;
    } catch (e) { lastErr = `${url} ${e.message}`; }
  }
  throw new Error(`Trae GetLoginGuidance failed: ${lastErr}`);
}

// Build the browser verification URL the user opens to sign in.
function buildTraeVerificationUrl(loginHost, loginTraceId, callbackUrl, ctx, codeChallenge) {
  const url = new URL(loginHost.startsWith("http") ? loginHost : `https://${loginHost.replace(/^\/+/, "")}`);
  url.pathname = TRAE_CONFIG.authorizationPath;
  const p = new URLSearchParams();
  p.set("login_version", "1");
  p.set("auth_from", "trae");
  p.set("login_channel", "native_ide");
  p.set("plugin_version", ctx.plugin_version);
  p.set("auth_type", "local");
  p.set("client_id", TRAE_CONFIG.clientId);
  p.set("redirect", "0");
  p.set("login_trace_id", loginTraceId);
  p.set("auth_callback_url", callbackUrl);
  p.set("machine_id", ctx.machine_id);
  p.set("device_id", ctx.device_id);
  p.set("x_device_id", ctx.device_id);
  p.set("x_machine_id", ctx.machine_id);
  p.set("x_device_brand", ctx.x_device_brand);
  p.set("x_device_type", ctx.x_device_type);
  p.set("x_os_version", ctx.x_os_version);
  p.set("x_env", ctx.x_env);
  p.set("x_app_version", ctx.x_app_version);
  p.set("x_app_type", ctx.x_app_type);
  // 新版授权：PKCE S256。老客户端忽略这两个参数，无害双发。
  if (codeChallenge) {
    p.set("code_challenge", codeChallenge);
    p.set("code_challenge_method", "S256");
  }
  url.search = p.toString();
  return url.toString();
}

// Parse the Trae OAuth callback (query string or full URL).
// 两种形态（#99 情报一）：
//   旧：?isRedirect=true&refreshToken=...&loginHost=...[&x-cloudide-token=...]
//   新：?authCode=... / ?authCodeInfo={"AuthCode":"...","ExpireAt":...}&loginHost=...
//       （附 userRegion / userTag / userInfo JSON 等元数据，站点推断用）
function parseTraeCallback(raw) {
  const text = String(raw || "").trim();
  let queryStr = text;
  if (text.includes("?")) queryStr = text.slice(text.indexOf("?") + 1);
  if (text.startsWith("#")) queryStr = text.slice(1);
  const params = Object.fromEntries(new URLSearchParams(queryStr));
  const pick = (keys) => {
    for (const k of keys) { const v = params[k]; if (v && String(v).trim()) return String(v).trim(); }
    return null;
  };
  const err = pick(["error", "error_code", "errorCode"]);
  if (err) {
    const desc = pick(["error_description", "error_desc", "message"]);
    throw new Error(desc ? `Trae auth failed: ${err} (${desc})` : `Trae auth failed: ${err}`);
  }
  // authCodeInfo 是 URL 编码的 JSON（AuthCode + ExpireAt 毫秒时间戳）
  let authCode = pick(["authCode", "auth_code", "AuthCode", "authorization_code", "code"]);
  const authCodeInfoRaw = pick(["authCodeInfo", "auth_code_info", "AuthCodeInfo"]);
  if (!authCode && authCodeInfoRaw) {
    let info;
    try { info = JSON.parse(authCodeInfoRaw); } catch { info = null; }
    const code = info && String(info.AuthCode || info.authCode || info.auth_code || info.code || "").trim();
    if (!code) throw new Error("Trae authCodeInfo missing AuthCode");
    const expireAt = Number(info.ExpireAt || info.expireAt || info.expiresAt || 0);
    if (expireAt > 0 && expireAt < Date.now()) throw new Error("Trae login callback authCodeInfo is expired");
    authCode = code;
  }
  const refreshToken = pick(["refreshToken", "refresh_token", "RefreshToken"]);
  if (!refreshToken && !authCode) throw new Error("Trae callback missing authCodeInfo/AuthCode and refreshToken");
  const loginHost = pick(["loginHost", "login_host", "LoginHost", "host", "consoleHost"]);
  const userRegion = pick(["userRegion", "user_region", "UserRegion", "loginRegion", "login_region", "LoginRegion"]);
  const userTag = pick(["userTag", "user_tag", "UserTag"]);
  const traceId = pick(["loginTraceID", "login_trace_id", "loginTraceId"]);
  const cloudideToken = pick(["x-cloudide-token", "xCloudideToken", "accessToken", "access_token", "token"]);
  return { refreshToken, authCode, loginHost, userRegion, userTag, traceId, cloudideToken };
}

// Allowed API origins for ExchangeToken/GetUserInfo — hardcoded HTTPS allowlist only.
// loginHost from the callback is intentionally NOT honored (SSRF guard: a callback
// attacker could otherwise point this at internal hosts/cloud metadata).
// 两个站点各自一份白名单；选错站点换 token 会 20101，所以 region 必须一路带下来。
function traeApiOrigins(region = "intl") {
  return normalizeTraeRegion(region) === "cn" ? [...TRAE_CONFIG.cnApiOrigins] : [...TRAE_CONFIG.apiOrigins];
}

// POST ExchangeToken {ClientID, RefreshToken, ClientSecret, UserID} → {Result:{AccessToken,RefreshToken,ExpiresAt}}
async function fetchTraeExchangeToken(refreshToken, cloudideToken, region = "intl") {
  const body = JSON.stringify({
    ClientID: TRAE_CONFIG.clientId,
    RefreshToken: refreshToken,
    ClientSecret: TRAE_CONFIG.clientSecret,
    UserID: "",
  });
  let lastErr = "no successful response";
  let wrongSide = false;
  for (const origin of traeApiOrigins(region)) {
    const url = `${origin.replace(/\/$/, "")}${TRAE_CONFIG.exchangeTokenPath}`;
    try {
      const headers = {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": TRAE_CONFIG.userAgent,
      };
      if (cloudideToken) headers["x-cloudide-token"] = cloudideToken;
      const res = await fetch(url, { method: "POST", headers, body });
      const text = await res.text();
      if (!res.ok) {
        // 20101 = refresh token 不归这一端管。多半是用户在国际站登录却贴了国内
        // 回调（或反之），值得给一句人话而不是干巴巴的 HTTP 401。
        if (text.includes("20101") || /refresh token is invalid|Token 无效/i.test(text)) wrongSide = true;
        lastErr = `${url} HTTP ${res.status}`;
        continue;
      }
      let data; try { data = JSON.parse(text); } catch { lastErr = `${url} invalid JSON`; continue; }
      const accessToken = extractJsonPath(data, [
        ["Result", "AccessToken"], ["Result", "accessToken"], ["result", "access_token"], ["accessToken"],
      ]);
      if (!accessToken) {
        const msg = extractJsonPath(data, [["message"], ["msg"], ["error"], ["Result", "Message"]]) || "missing AccessToken";
        lastErr = `${url} ${msg}`;
        continue;
      }
      return {
        accessToken,
        refreshToken: extractJsonPath(data, [["Result", "RefreshToken"], ["result", "refresh_token"], ["refreshToken"]]) || refreshToken,
        expiresIn: null, // ExchangeToken returns ExpiresAt (absolute), converted below
        expiresAt: extractJsonPath(data, [["Result", "ExpiresAt"], ["Result", "expiresAt"], ["result", "expires_at"], ["expiresAt"]]),
      };
    } catch (e) { lastErr = `${url} ${e.message}`; }
  }
  if (wrongSide) {
    const want = normalizeTraeRegion(region) === "cn" ? "国内站 (trae.cn)" : "国际站 (trae.ai)";
    throw new Error(
      `Trae 登录站点不匹配：这个 refresh token 不是${want}签发的（20101）。` +
      `国内站与国际站账号不互通，请在登录弹窗里选对「站点」后重新登录。` +
      `连的是 ${traeApiOrigins(region)[0]}。`
    );
  }
  throw new Error(`Trae ExchangeToken failed (${region}): ${lastErr}`);
}

// POST {origin}/trae/api/v3/oauth/ExchangeToken — AuthCode + PKCE + DeviceInfo
// （新版授权，muskke exchangeAuthCode 考古）。DevicePublicKey 每次换票现生成。
async function fetchTraeAuthCodeExchange(authCode, codeVerifier, region = "intl", device = {}) {
  const deviceName = String(process.env.USERNAME || process.env.USER || process.env.HOSTNAME || "PC").trim() || "PC";
  const body = JSON.stringify({
    ClientID: TRAE_CONFIG.clientId,
    AuthCode: authCode,
    CodeVerifier: codeVerifier || "",
    IDEVersion: TRAE_CONFIG.defaultAppVersion,
    DeviceInfo: {
      DeviceID: device.device_id || TRAE_CONFIG.defaultDeviceId,
      MachineID: device.machine_id || crypto.randomUUID(),
      PlatformCode: "IDE_PC",
      DeviceType: "PC",
      DeviceName: deviceName,
      DeviceModel: device.x_device_brand || "unknown",
      ClientVersion: TRAE_CONFIG.defaultAppVersion,
      DevicePublicKey: generateDevicePublicKey(),
      DeviceBrand: device.x_device_brand || "unknown",
      DeviceCPU: "",
      OSInfo: device.x_device_type || "unknown",
      OSVersion: device.x_os_version || "unknown",
    },
  });
  const origins = normalizeTraeRegion(region) === "cn" ? [...TRAE_CONFIG.cnAuthCodeOrigins] : [...TRAE_CONFIG.authCodeOrigins];
  let lastErr = "no successful response";
  let wrongSide = false;
  for (const origin of origins) {
    const url = `${origin.replace(/\/$/, "")}${TRAE_CONFIG.authCodeExchangePath}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": TRAE_CONFIG.userAgent },
        body,
      });
      const text = await res.text();
      if (!res.ok) {
        if (text.includes("20101") || /refresh token is invalid|Token 无效/i.test(text)) wrongSide = true;
        lastErr = `${url} HTTP ${res.status}`;
        continue;
      }
      let data; try { data = JSON.parse(text); } catch { lastErr = `${url} invalid JSON`; continue; }
      const accessToken = extractJsonPath(data, [
        ["Result", "AccessToken"], ["Result", "accessToken"], ["data", "AccessToken"], ["data", "accessToken"],
        ["accessToken"], ["access_token"],
      ]);
      if (!accessToken) {
        const msg = extractJsonPath(data, [["message"], ["msg"], ["error"], ["Result", "Message"], ["data", "Message"]]) || "missing AccessToken";
        lastErr = `${url} ${msg}`;
        continue;
      }
      return {
        accessToken,
        refreshToken: extractJsonPath(data, [
          ["Result", "RefreshToken"], ["Result", "refreshToken"], ["data", "RefreshToken"], ["data", "refresh_token"], ["refreshToken"],
        ]) || null,
        expiresIn: null,
        expiresAt: extractJsonPath(data, [
          ["Result", "ExpiresAt"], ["Result", "expiresAt"], ["data", "ExpiresAt"], ["data", "expires_at"], ["expiresAt"],
        ]),
      };
    } catch (e) { lastErr = `${url} ${e.message}`; }
  }
  if (wrongSide) {
    const want = normalizeTraeRegion(region) === "cn" ? "国内站 (trae.cn)" : "国际站 (trae.ai)";
    throw new Error(
      `Trae 登录站点不匹配：这个授权码不是${want}签发的（20101）。` +
      `国内站与国际站账号不互通，请用对应站点的供应商条目重新登录。` +
      `连的是 ${origins[0]}。`
    );
  }
  throw new Error(`Trae AuthCode ExchangeToken failed (${region}): ${lastErr}`);
}

// POST GetUserInfo with x-cloudide-token → identity fields used by SOLO common_params.
async function fetchTraeUserInfo(accessToken, region = "intl") {
  for (const origin of traeApiOrigins(region)) {
    const url = `${origin.replace(/\/$/, "")}${TRAE_CONFIG.getUserInfoPath}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": TRAE_CONFIG.userAgent,
          "x-cloudide-token": accessToken,
        },
        body: JSON.stringify({}),
      });
      if (!res.ok) continue;
      const data = await res.json();
      return {
        email: extractJsonPath(data, [
          ["Result", "NonPlainTextEmail"], ["Result", "Email"], ["Result", "email"],
          ["email"], ["data", "email"],
        ]),
        name: extractJsonPath(data, [
          ["Result", "ScreenName"], ["Result", "Nickname"], ["Result", "Name"],
          ["result", "nickname"], ["nickname"], ["name"],
        ]),
        aiRegion: extractJsonPath(data, [["Result", "AIRegion"], ["Result", "aiRegion"], ["aiRegion"]]),
        region: extractJsonPath(data, [["Result", "Region"], ["Result", "region"], ["region"]]),
        tenant: extractJsonPath(data, [["Result", "TenantID"], ["Result", "tenantId"], ["tenantId"]]),
        userId: extractJsonPath(data, [["Result", "UserID"], ["Result", "userId"], ["userId"]]),
      };
    } catch { /* try next origin */ }
  }
  return { email: null, name: null };
}

// Map AIRegion (e.g. "SG", "US", "CN") → SOLO scope used in common_params.
// 站点（site）优先：国内账号无论 AIRegion 回什么都只能落在 marscode-cn。
function traeScopeForRegion(aiRegion, site = "intl") {
  if (normalizeTraeRegion(site) === "cn") return "marscode-cn";
  const r = (aiRegion || "").toLowerCase();
  if (r === "sg" || r.includes("singapore")) return "marscode-sg";
  if (r === "cn" || r.includes("cn") || r.includes("china")) return "marscode-cn";
  return "marscode-us";
}

// 登录站点决定的一整组落地值：region / userRegion 也一并跟着走，
// 否则国内 token 会带着 x-user-region: US 打上官方的 SOLO 网关。
function traeRegionDefaults(site) {
  if (normalizeTraeRegion(site) === "cn") {
    return { region: "CN", aiRegion: "CN", userRegion: "CN", appLanguage: "zh" };
  }
  return { region: "US-East", aiRegion: "US-East", userRegion: "US", appLanguage: "en" };
}

// Trae — browser OAuth: GetLoginGuidance → verification URL
// → local callback (refreshToken+loginHost) → ExchangeToken → GetUserInfo.
// state === config.loginTraceID so the proxy can match the callback.
const trae = {
  config: TRAE_CONFIG,
  flowType: "authorization_code",
  callbackPath: TRAE_CONFIG.callbackPath,
  prepareConfig: async (config, meta) => {
    const loginTraceID = crypto.randomUUID();
    // 站点来源优先级：条目钉死的 config.region（trae-cn 固定 cn）→ 前端 meta.region
    // （/authorize?region=，#69 老入口）→ 缺省国际站。此前本函数只收 config，
    // 弹窗传上来的 meta.region 实际从未生效（#99 拆线时修复）；拿到的 LoginHost
    // 再反推一次，作为最终站点的权威来源。
    const requested = normalizeTraeRegion(meta?.region || config?.region);
    const loginHost = await fetchTraeLoginGuidance(loginTraceID, requested);
    const site = traeRegionFromHost(loginHost, requested);
    // PKCE verifier 与设备上下文随本次登录登记进 pending 表（按 loginTraceID 消费），
    // exchangeToken 拿 state / 回调里的 login_trace_id 找回——它们不能放 config，
    // exchangeTokens 会重跑 prepareConfig 把 config 换成新的一轮。
    const deviceCtx = buildTraeDeviceContext();
    const pkce = generateTraePKCE();
    rememberTraePending(loginTraceID, { codeVerifier: pkce.verifier, region: site, loginHost, device: deviceCtx });
    return { ...config, loginTraceID, loginHost, region: site, codeChallenge: pkce.challenge, deviceCtx };
  },
  buildAuthUrl: (config, redirectUri, state) => {
    const traceId = config.loginTraceID || state;
    return buildTraeVerificationUrl(config.loginHost, traceId, redirectUri, config.deviceCtx || buildTraeDeviceContext(), config.codeChallenge);
  },
  exchangeToken: async (config, code, redirectUri, codeVerifier, state) => {
    const trimmed = String(code || "").trim();
    const fallbackSite = normalizeTraeRegion(config?.region);
    // Paste-token mode: raw Cloud-IDE-JWT (no refresh exchange)
    const looksCallback = /[?=&]/.test(trimmed)
      && (trimmed.includes("refreshToken") || trimmed.includes("refresh_token") || trimmed.includes("authCode") || trimmed.includes("auth_code") || trimmed.includes("authCodeInfo"));
    if (!looksCallback) {
      // Strip "Cloud-IDE-JWT " / "Bearer " prefix users paste from the Authorization header
      const clean = trimmed.replace(/^(Cloud-IDE-JWT|Bearer)\s+/i, "");
      return { accessToken: clean, refreshToken: null, expiresIn: TRAE_CONFIG.tokenLifetimeDays * 24 * 60 * 60, _authMethod: "imported", _site: fallbackSite };
    }
    const parsed = parseTraeCallback(trimmed);
    // pending 表（authorize 那一轮）优先：verifier / 站点 / 设备上下文都是它的。
    const pending = takeTraePending(state || parsed.traceId);
    // 回调里的 loginHost 决定用哪一端换 token（#69 起的权威来源）；host 判不出时
    // 依次回落 pending 站点、回调 userRegion、声明 region。拿错端必 20101。
    const hostLower = String(parsed.loginHost || "").toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
    const hostKnown = !!hostLower
      && [...TRAE_CONFIG.intlHostSuffixes, ...TRAE_CONFIG.cnHostSuffixes].some((s) => hostLower === s || hostLower.endsWith(`.${s}`));
    const site = hostKnown
      ? traeRegionFromHost(parsed.loginHost, fallbackSite)
      : normalizeTraeRegion(parsed.userRegion === "cn" || parsed.userRegion === "CN" ? "cn" : (pending?.region || fallbackSite));
    if (parsed.authCode) {
      return {
        ...(await fetchTraeAuthCodeExchange(parsed.authCode, pending?.codeVerifier || codeVerifier, site, pending?.device)),
        _authMethod: "oauth",
        _site: site,
      };
    }
    return { ...(await fetchTraeExchangeToken(parsed.refreshToken, parsed.cloudideToken, site)), _authMethod: "oauth", _site: site };
  },
  postExchange: async (tokens) => {
    const userInfo = await fetchTraeUserInfo(tokens.accessToken, tokens._site);
    // 粘贴的裸 JWT 没有 loginHost、也不经过 ExchangeToken——站点只能靠探测反推：
    // 哪一端的 GetUserInfo 认这个 token，账号就在哪一端。
    let site = normalizeTraeRegion(tokens._site);
    if (!userInfo.aiRegion && !userInfo.email && tokens._authMethod === "imported" && site !== "cn") {
      try {
        const cnInfo = await fetchTraeUserInfo(tokens.accessToken, "cn");
        if (cnInfo.aiRegion || cnInfo.email) {
          site = "cn";
          userInfo.email = userInfo.email || cnInfo.email;
          userInfo.name = userInfo.name || cnInfo.name;
          userInfo.aiRegion = userInfo.aiRegion || cnInfo.aiRegion;
        }
      } catch { /* 探测失败保持原判定 */ }
    }
    return { userInfo, _site: site };
  },
  mapTokens: (tokens, extra) => {
    const expiresIn = tokens.expiresIn
      || (tokens.expiresAt ? Math.max(60, Number(tokens.expiresAt) - Math.floor(Date.now() / 1000)) : TRAE_CONFIG.tokenLifetimeDays * 24 * 60 * 60);
    const ui = extra?.userInfo || {};
    // postExchange 的探测结论优先（裸 JWT 粘贴时它才最准）。
    const site = normalizeTraeRegion(extra?._site || tokens._site);
    const defaults = traeRegionDefaults(site);
    const aiRegion = ui.aiRegion || defaults.aiRegion;
    // SOLO common_params defaults — identity fields web_id/biz_user_id are not
    // exposed by GetUserInfo; empty strings are accepted upstream (verified).
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn,
      email: ui.email || undefined,
      displayName: ui.name || undefined,
      providerSpecificData: {
        authMethod: tokens._authMethod || "oauth",
        // 站点：刷新 token（refresh.js）与 SOLO 作用域都按它分叉。
        site,
        region: site === "cn" ? "CN" : (ui.region || aiRegion),
        aiRegion,
        tenant: ui.tenant || "marscode",
        userId: ui.userId || "",
        scope: traeScopeForRegion(aiRegion, site),
        webId: "",
        bizUserId: "",
        userUniqueId: "",
        appLanguage: defaults.appLanguage,
        appVersion: TRAE_CONFIG.defaultAppVersion,
        userRegion: site === "cn" ? "CN" : (aiRegion === "SG" ? "SG" : "US"),
        userIdentity: "Free",
      },
    };
  },
};

// trae-cn — 国内站独立条目（#99 拆线，方案 A）。整条链路钉死 cn：GetLoginGuidance
// 只打国内白名单，换票 / GetUserInfo 落在 cn origins。回调里的 loginHost 仍是
// 最终权威——贴错端的 token 会拿到 20101「站点不匹配」人话提示，不会静默串端。
const traeCn = {
  ...trae,
  config: { ...TRAE_CONFIG, region: "cn" },
  prepareConfig: async (config, meta) => trae.prepareConfig({ ...config, region: "cn" }, meta),
  // state 必须透传——pending 表按 loginTraceID 发 PKCE verifier / 站点 / 设备上下文
  exchangeToken: async (config, code, redirectUri, codeVerifier, state, meta) =>
    trae.exchangeToken({ ...config, region: "cn" }, code, redirectUri, codeVerifier, state, meta),
};

export { traeCn };
export default trae;
