import crypto from "crypto";
import { TRAE_CONFIG } from "../constants/oauth.js";
import { generateDeviceKeyPair, buildDeviceInfo } from "../utils/traeDevice.js";
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
function buildTraeVerificationUrl(loginHost, loginTraceId, callbackUrl, ctx) {
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
  url.search = p.toString();
  return url.toString();
}

// Parse the Trae OAuth callback (query string or full URL).
// Expected: ?isRedirect=true&refreshToken=...&loginHost=...[&x-cloudide-token=...]
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
  const refreshToken = pick(["refreshToken", "refresh_token", "RefreshToken"]);
  if (!refreshToken) throw new Error("Trae callback missing refreshToken");
  const loginHost = pick(["loginHost", "login_host", "LoginHost", "host", "consoleHost"]);
  if (!loginHost) throw new Error("Trae callback missing loginHost");
  const cloudideToken = pick(["x-cloudide-token", "xCloudideToken", "accessToken", "access_token", "token"]);
  return { refreshToken, loginHost, cloudideToken };
}

// Allowed API origins for ExchangeToken/GetUserInfo — hardcoded HTTPS allowlist only.
// loginHost from the callback is intentionally NOT honored (SSRF guard: a callback
// attacker could otherwise point this at internal hosts/cloud metadata).
// 两个站点各自一份白名单；选错站点换 token 会 20101，所以 region 必须一路带下来。
function traeApiOrigins(region = "intl") {
  return normalizeTraeRegion(region) === "cn" ? [...TRAE_CONFIG.cnApiOrigins] : [...TRAE_CONFIG.apiOrigins];
}

// POST ExchangeToken {ClientID, RefreshToken, ClientSecret, UserID} → {Result:{AccessToken,RefreshToken,ExpiresAt}}
async function fetchTraeExchangeToken(refreshToken, cloudideToken, region = "intl", device = null) {
  const body = JSON.stringify({
    ClientID: TRAE_CONFIG.clientId,
    RefreshToken: refreshToken,
    ClientSecret: TRAE_CONFIG.clientSecret,
    UserID: "",
    // Required by the device-binding check (20405 when empty).
    ...(device ? { DeviceInfo: buildDeviceInfo(device) } : {}),
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
        _device: device || null,
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
  prepareConfig: async (config) => {
    const loginTraceID = crypto.randomUUID();
    // 站点由前端 meta.region（或 redirect_uri 里带 ?region=）决定，缺省国际站。
    // 拿到的 LoginHost 再反推一次，作为最终站点的权威来源。
    const requested = normalizeTraeRegion(config?.region);
    const loginHost = await fetchTraeLoginGuidance(loginTraceID, requested);
    const site = traeRegionFromHost(loginHost, requested);
    return { ...config, loginTraceID, loginHost, region: site };
  },
  buildAuthUrl: (config, redirectUri, state) => {
    const ctx = buildTraeDeviceContext();
    const traceId = config.loginTraceID || state;
    return buildTraeVerificationUrl(config.loginHost, traceId, redirectUri, ctx);
  },
  exchangeToken: async (config, code) => {
    const trimmed = String(code || "").trim();
    const fallbackSite = normalizeTraeRegion(config?.region);
    // Paste-token mode: raw Cloud-IDE-JWT (no refresh exchange)
    const looksCallback = /[?=&]/.test(trimmed) && (trimmed.includes("refreshToken") || trimmed.includes("refresh_token"));
    if (!looksCallback) {
      // Strip "Cloud-IDE-JWT " / "Bearer " prefix users paste from the Authorization header
      const clean = trimmed.replace(/^(Cloud-IDE-JWT|Bearer)\s+/i, "");
      return { accessToken: clean, refreshToken: null, expiresIn: TRAE_CONFIG.tokenLifetimeDays * 24 * 60 * 60, _authMethod: "imported", _site: fallbackSite };
    }
    const { refreshToken, loginHost, cloudideToken } = parseTraeCallback(trimmed);
    // 回调里的 loginHost 决定用哪一端换 token：国内回调带 www.trae.cn，
    // 只贴 token 没带 loginHost 时回落到调用方 meta 里的区域选择，
    // 国际回调带 www.trae.ai。拿错端必 20101，因此这里以回调为准。
    const site = traeRegionFromHost(loginHost, fallbackSite);
    // Fresh pair per login, mirroring the official client; the private half is
    // persisted in mapTokens so the SOLO DeviceProof refresh can use it.
    const device = generateDeviceKeyPair();
    return { ...(await fetchTraeExchangeToken(refreshToken, cloudideToken, site, device)), _authMethod: "oauth", _site: site };
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
        // Persisted so tokenRefresh/trae-solo.js can sign DeviceProof with the
        // same key the login was bound to.
        ...(tokens._device ? {
          devicePublicKeyPem: tokens._device.publicPem,
          devicePrivateKeyPem: tokens._device.privatePem,
        } : {}),
      },
    };
  },
};

export default trae;
