// 小浣熊（raccoon / xiaohuanxiong.com）网页授权码登录 —— 纯模块。
//
// ── 流程（照 agent2api `providers/raccoon/oauth.rs`）──────────
//   1. 打开 {mainOrigin}/code/authorize?login_source=desktop&appname=…&state=…
//   2. 用户在官方页登录成功后，官方页跳自定义协议：
//        office-raccoon://auth/callback?code=…&state=…
//   3. POST {authApiBase}/login_with_authorization_code
//        body {"authorization_code": code}
//      → data.access_token / data.refresh_token / data.office_*（200035 = 授权码已失效）
//
// ── 为什么 state 要逐字比对 ─────────────────────────────────
// `state` 是一次性随机串，回答的是「这次带着 code 跳回来的地址，是不是本进程
// 刚刚发起的那次登录」。回调落在自定义协议上，任何本机程序都能构造一个
// `office-raccoon://auth/callback?code=…&state=…` 丢进登录窗口；不比 state
// 就等于把「用别人的 code 换来的凭证写进你的账号库」这条口子敞开着。
// 源实现（Rust `parse_callback_code`）同样逐字比对，这里保持一致。
//
// ── state 与 code 的边界 ────────────────────────────────────
// 完整回调 URL 必须带非空 state，且与调用方保存的 expectedState 完全一致；
// 裸 code（用户从页面复制）本身不携带 state，无法比对 —— 这条路径的安全性由
// 「用户亲手粘贴」+ 调用方的会话绑定负责，与 Rust `exchange_code` 的取舍一致。
//
// 本文件不发请求、不落盘、不读全局状态：所有网络动作都通过参数注入的
// `fetchImpl` 完成，便于单测；base URL 复用 `open-sse/config/raccoon.js`，
// 避免与 registry / 刷新器各写一份域名。
import { RACCOON_AUTH_API_BASE, RACCOON_ORIGIN } from "open-sse/config/raccoon.js";

/** 授权页路径（源实现 `new URL('/code/authorize', mainOrigin)`） */
const AUTHORIZE_PATH = "/code/authorize";

/** 登录来源标记：官方页据此走「桌面端登录」分支（源实现固定 desktop） */
const LOGIN_SOURCE = "desktop";

/** 申请授权时上报的客户端名（源实现 `DEFAULT_APP_NAME`） */
const DEFAULT_APP_NAME = "办公小浣熊客户端";

/** 回调的协议 / host / 路径（源实现 `isRaccoonAuthCallbackUrl` 的三个判据） */
const CALLBACK_SCHEME = "office-raccoon";
const CALLBACK_HOST = "auth";
const CALLBACK_PATH = "/callback";

/** state / 授权码长度上限（源实现 `MAX_STATE_LENGTH` / `MAX_CODE_LENGTH`） */
const MAX_STATE_LENGTH = 512;
const MAX_CODE_LENGTH = 8192;

/**
 * 授权码已失效的上游业务码（源实现 `payload.code === 200035`）。
 * 它值得单独识别：这不是「登录服务坏了」，而是「回调链接放太久 / 重复使用」，
 * 文案必须告诉用户重新发起，而不是让他等我们重试。
 */
const CODE_EXPIRED = 200_035;

/** 鉴权 API 是普通短请求，30s 足够（Rust `AUTH_REQUEST_TIMEOUT_MS`）。 */
const LOGIN_REQUEST_TIMEOUT_MS = 30_000;

export const RACCOON_LOGIN_CONFIG = Object.freeze({
  providerId: "raccoon",
  displayName: "小浣熊",
  mainOrigin: RACCOON_ORIGIN,
  authorizePath: AUTHORIZE_PATH,
  authorizeUrl: `${RACCOON_ORIGIN}${AUTHORIZE_PATH}`,
  authApiBase: RACCOON_AUTH_API_BASE,
  exchangeUrl: `${RACCOON_AUTH_API_BASE}/login_with_authorization_code`,
  callbackScheme: CALLBACK_SCHEME,
  callbackHost: CALLBACK_HOST,
  callbackPath: CALLBACK_PATH,
  callbackUrl: `${CALLBACK_SCHEME}://${CALLBACK_HOST}${CALLBACK_PATH}`,
  loginSource: LOGIN_SOURCE,
  defaultAppName: DEFAULT_APP_NAME,
  codeExpiredCode: CODE_EXPIRED,
  requestTimeoutMs: LOGIN_REQUEST_TIMEOUT_MS,
  maxStateLength: MAX_STATE_LENGTH,
  maxCodeLength: MAX_CODE_LENGTH,
});

// ─── 小工具（与 Rust `jwt.rs` 的取值口径一致）─────────────────

/** 去 `Bearer ` 前缀（大小写不敏感，至少一个空白），不匹配时原样返回。 */
function stripBearer(value) {
  return String(value ?? "")
    .trim()
    .replace(/^Bearer\s+/i, "");
}

/** JS `String(x)`：null/undefined 给空串，对象按 JSON 文本。 */
function jsText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** 解码 JWT payload（不验签：网关不做鉴权判定，token 好不好用由上游说了算）。 */
function decodeJwtClaims(token) {
  const raw = stripBearer(token);
  const payloadPart = raw.split(".")[1];
  if (!payloadPart) return null;
  try {
    const claims = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    return claims && typeof claims === "object" && !Array.isArray(claims) ? claims : null;
  } catch {
    return null;
  }
}

/** token 过期时间（毫秒）；没有 `exp` 或 token 不可解析时 null。 */
function jwtExpiryMs(token) {
  const claims = decodeJwtClaims(token);
  const exp = Number(claims?.exp);
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
}

/** 十六进制字符串 → 十进制字符串（源实现 `hexIdToDecimalString`，用 BigInt 免溢出）。 */
function hexIdToDecimal(value) {
  const raw = jsText(value).trim();
  if (!raw) return "";
  const normalized = raw.replace(/^0x/i, "");
  if (!normalized || !/^[0-9a-f]+$/i.test(normalized)) return "";
  return BigInt(`0x${normalized}`).toString(10);
}

/**
 * 用户 ID（源实现 `extractRaccoonUserId`）：
 * `sid`（十六进制）→ `iss`（十六进制）→ `sub` / `id` / `user_id`。
 *
 * 实测 `sid` 形如 `web65aa393e65a6b6d446a51dde22c-a6d6-48e2`，不是纯十六进制，
 * 真正命中的通常是 `iss`（如 `6d446a` → `7160938`）；两条路径都要保留。
 */
function extractUserId(claims) {
  for (const key of ["sid", "iss"]) {
    const value = hexIdToDecimal(claims?.[key]);
    if (value) return value;
  }
  for (const key of ["sub", "id", "user_id"]) {
    const value = jsText(claims?.[key]).trim();
    if (value) return value;
  }
  return "";
}

/** 展示用名字（JWT 的 `name`）。 */
function displayNameOf(claims) {
  return jsText(claims?.name).trim();
}

/** 邮箱：上游 JWT 通常不带，带的时候原样用；缺省 null（连接去重由 uid 承担）。 */
function emailOf(claims) {
  const email = jsText(claims?.email).trim();
  return email || null;
}

function loginTimeoutSignal() {
  try {
    return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(LOGIN_REQUEST_TIMEOUT_MS)
      : undefined;
  } catch {
    return undefined;
  }
}

// ─── ① 授权地址 ─────────────────────────────────────────────

/**
 * 构造授权地址（源实现 `buildRaccoonAuthorizeUrl`）。
 *
 * 用 `URL` 拼而不是字符串相加：`appname` 是中文、`state` 是随机串，两者都必须
 * 正确百分号编码，手拼一个 `&` 或空格就会让官方页面拿到半个参数。
 *
 * `state` 缺失时**抛错**而不是用空串/占位符：没有 state 的登录无法在回调时
 * 校验来源，生成这样的地址等于主动关掉唯一的 CSRF 防线。
 */
export function buildAuthorizeUrl({ state, appName = DEFAULT_APP_NAME } = {}) {
  const cleanState = typeof state === "string" ? state.trim() : "";
  if (!cleanState) throw new Error("小浣熊网页登录缺少 state，拒绝生成授权地址");
  if (cleanState.length > MAX_STATE_LENGTH) throw new Error("小浣熊网页登录 state 过长");

  const cleanAppName =
    typeof appName === "string" && appName.trim() ? appName.trim() : DEFAULT_APP_NAME;
  const url = new URL(AUTHORIZE_PATH, RACCOON_ORIGIN);
  url.searchParams.set("login_source", LOGIN_SOURCE);
  url.searchParams.set("appname", cleanAppName);
  url.searchParams.set("state", cleanState);
  return url.toString();
}

// ─── ② 回调解析 ─────────────────────────────────────────────

function okResult(code, state) {
  return { code, state, ok: true };
}

/**
 * 失败时 `code` 一律给空串：调用方若忘了看 `ok`，也拿不到可兑换的授权码
 * （深度防御，与 state 校验同一目的）。
 */
function failResult(state, error) {
  return { code: "", state: state || "", ok: false, error };
}

function parseParams(params, expectedState) {
  const state = (params.get("state") || "").trim();
  const code = (params.get("code") || "").trim();
  const errorCode = (params.get("error") || "").trim();
  const errorDescription = (
    params.get("error_description") ||
    params.get("error_message") ||
    ""
  ).trim();

  if (!code) {
    if (errorCode) {
      return failResult(state, errorDescription || `授权失败（${errorCode}）`);
    }
    return failResult(state, "登录回调里没有授权码");
  }
  if (code.length > MAX_CODE_LENGTH) return failResult(state, "授权码过长");
  if (!state) {
    return failResult(
      "",
      "登录回调里没有 state，无法确认这次登录由本机发起，请重新发起网页登录",
    );
  }
  if (state.length > MAX_STATE_LENGTH) return failResult(state, "登录回调 state 过长");
  if (!expectedState) {
    return failResult(state, "缺少本地登录 state，无法校验回调，请重新发起网页登录");
  }
  if (state !== expectedState) {
    return failResult(state, "登录回调 state 校验失败，请重新发起登录");
  }
  return okResult(code, state);
}

/**
 * 解析登录回调（源实现 `isRaccoonAuthCallbackUrl` + `parseRaccoonAuthCallback`）。
 *
 * 接受三种输入：
 *   - 完整自定义协议地址 `office-raccoon://auth/callback?code=…&state=…`；
 *   - 官方页可能的 https 落点（任何 http(s) 地址，只要带 code/state 参数）；
 *   - 裸授权码（用户手动粘贴）—— 此时 `state` 回填 expectedState，无法比对。
 *
 * 自定义协议**逐项比对** scheme / host / path，而不是前缀匹配：
 * `office-raccoon://auth/callback@evil.com?…` 这类字符串用 `startsWith` 会放行。
 * http(s) 落点不限定路径：官方页改过落点路径时，state 比对仍是真正的防线。
 *
 * @param {string} input 回调 URL、`?code=…&state=…` 查询串或裸 code
 * @param {string} expectedState 发起登录时保存的一次性 state
 * @returns {{ code: string, state: string, ok: boolean, error?: string }}
 */
export function parseCallbackUrl(input, expectedState) {
  const raw = typeof input === "string" ? input.trim() : "";
  const expected = typeof expectedState === "string" ? expectedState.trim() : "";
  if (!raw) return failResult("", "缺少登录回调地址或授权码");

  const looksLikeUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);

  // 裸 code / 只粘贴了 query 片段（`?code=…&state=…`）
  if (!looksLikeUrl) {
    if (/^[?&]?code=/.test(raw) || /[?&]code=/.test(raw)) {
      const query = raw.startsWith("?") ? raw.slice(1) : raw;
      return parseParams(new URLSearchParams(query), expected);
    }
    if (raw.length > MAX_CODE_LENGTH) return failResult("", "授权码过长");
    return okResult(raw, expected);
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return failResult("", "登录回调地址无效");
  }

  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (scheme === CALLBACK_SCHEME) {
    // 自定义协议在 WHATWG URL 里走 opaque host：大小写不规范化，host 需不区分大小写比对
    const host = (url.hostname || "").toLowerCase();
    if (host !== CALLBACK_HOST || url.pathname !== CALLBACK_PATH) {
      return failResult((url.searchParams.get("state") || "").trim(), "登录回调地址无效");
    }
  } else if (scheme !== "http" && scheme !== "https") {
    return failResult("", "登录回调地址无效");
  }

  return parseParams(url.searchParams, expected);
}

// ─── ③ 授权码换凭证 ─────────────────────────────────────────

/**
 * 用一次性授权码换凭证（源实现 `exchangeRaccoonAuthorizationCode` 的出网部分）。
 *
 * 成功要求 access_token 与 refresh_token **都非空**：refresh 是 30 天轮换的，
 * 只存 access 的账号 2 小时后必然失效（Rust 同样把缺 refresh 视为失败）。
 *
 * 返回的 `expiresAt` 是**毫秒时间戳**（JWT `exp` × 1000，与 Rust `jwt_expiry_ms`
 * 同口径；JWT 解不出时回退 `data.expires_in`，再无则 null）。
 * `uid` / `name` / `email` 从 access token 的 JWT 声明里读（不验签）。
 *
 * @param {string} code 回调里的授权码（可带 `Bearer ` 前缀 / 空白）
 * @param {{ fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<{
 *   accessToken: string,
 *   refreshToken: string,
 *   expiresAt: number|null,
 *   providerSpecificData: object,
 *   uid: string,
 *   name: string,
 *   email: string|null,
 * }>}
 */
export async function exchangeCode(code, { fetchImpl = fetch } = {}) {
  const authCode = typeof code === "string" ? code.trim() : "";
  if (!authCode) throw new Error("小浣熊网页登录缺少授权码");
  if (authCode.length > MAX_CODE_LENGTH) throw new Error("小浣熊授权码过长");
  if (typeof fetchImpl !== "function") throw new Error("小浣熊网页登录缺少 fetch 实现");

  let response;
  try {
    response = await fetchImpl(RACCOON_LOGIN_CONFIG.exchangeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ authorization_code: authCode }),
      signal: loginTimeoutSignal(),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new Error("小浣熊网页登录换取凭证超时，请重试");
    }
    throw new Error(`小浣熊网页登录换取凭证失败：${error?.message || error}`);
  }

  const text = await response.text().catch(() => "");
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  const upstreamCode = Number(payload?.code);
  if (upstreamCode === CODE_EXPIRED) {
    throw new Error("授权码已失效，请重新登录");
  }
  if (!response.ok) {
    const rawMessage = jsText(payload?.message ?? payload?.msg).trim();
    // 上游把「内部异常」原样回下来，这句话对用户没有信息量
    const message =
      rawMessage === "internal_server_error" ? "登录服务异常，请稍后重试" : rawMessage;
    throw new Error(
      message || `小浣熊网页登录换取凭证失败（HTTP ${response.status}）`,
    );
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("小浣熊网页登录换取凭证失败：响应不是 JSON");
  }

  const data = payload.data && typeof payload.data === "object" ? payload.data : {};
  const accessToken = stripBearer(jsText(data.access_token));
  const refreshToken = stripBearer(jsText(data.refresh_token));
  if (!accessToken || !refreshToken) {
    const rawMessage = jsText(payload.message ?? payload.msg).trim();
    throw new Error(
      rawMessage === "internal_server_error"
        ? "登录服务异常，请稍后重试"
        : "小浣熊网页登录换取凭证失败：响应缺少 access_token 或 refresh_token",
    );
  }

  const claims = decodeJwtClaims(accessToken) || {};
  const uid = extractUserId(claims);
  const name = displayNameOf(claims);
  const email = emailOf(claims);

  let expiresAt = jwtExpiryMs(accessToken);
  if (expiresAt === null) {
    const expiresIn = Number(data.expires_in);
    if (Number.isFinite(expiresIn) && expiresIn > 0) expiresAt = Date.now() + expiresIn * 1000;
  }

  // office_* 是组织身份（续期不需要，但账号卡片 / 后续 office 接口会用到）；
  // 空值不落键，避免把 "" 写进 providerSpecificData。
  const office = {};
  for (const [source, key] of [
    ["office_identity", "officeIdentity"],
    ["office_org_name", "officeOrgName"],
    ["office_org_role", "officeOrgRole"],
  ]) {
    const value = jsText(data[source]).trim();
    if (value) office[key] = value;
  }

  return {
    accessToken,
    refreshToken,
    expiresAt,
    providerSpecificData: {
      authMethod: "oauth",
      uid,
      name,
      ...office,
    },
    uid,
    name,
    email,
  };
}
