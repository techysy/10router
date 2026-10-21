// Loomy（科大讯飞）短信验证码登录 — **纯模块**：不带路由、不带 UI、不落库。
//
// 逐字移植自 agent2api Rust `providers/loomy/{login,sign,endpoints,client}.rs`
// （逆向来源：Loomy 桌面端 `app.asar` 的 `electron/xfyun/account-service.js`）。
//
// ── 两步链路（没有窗口、没有轮询）──────────────────────────────
//   POST {xfyun}/login/phone/sendMsgCode  {base, param:{ccode, phone, expire:300}}
//     → data.msgid
//   POST {xfyun}/login/phone/checkCode    {base, param:{ccode, phone, mcode, msgid,
//                                           expire:1209600}}   ← 14 天
//     → data.session / data.userid
//
// `msgid` 由前端在两步之间带回：上游把「刚发的码」绑在发码响应的 msgid 上，
// 登录必须带同一个。本模块不保存这个中间态（一次登录可以跨多次 HTTP 请求、
// 也可以被放弃），由调用方把 `{msgid}` 原样透传给 `verifySmsCode`。
//
// ── 签名（HMAC-SHA1，客户端内置 AccessKey 对）─────────────────
// 待签串 9 段，`\n` 连接（与客户端 `generateSignature` 同构）：
//   METHOD / ESCAPED_PATH / ESCAPED_QUERY(空) / CONTENT_MD5 /
//   CONTENT_TYPE("application/json") / DATE / NONCE / SIGNED_HEADERS(空) /
//   CANONICALIZED_HEADERS(空)
// 注意末两段是空串 ⇒ 拼接结果在 nonce 之后以两个 `\n` 结尾。
// Content-MD5 = base64(md5(实际发出的 UTF-8 body 字节))，所以本模块只
// `JSON.stringify` 一次，签名与发送共用同一个字符串。
//
// ── 会话 ──────────────────────────────────────────────────────
// 14 天，上游**没有 refresh 接口**（Rust credentials.rs 已实测）。`expiresAt`
// 只能按登录时间 + 14 天估算；过期后只能重新短信登录，不要假装能续期。
//
// ── 错误分类 ──────────────────────────────────────────────────
// HTTP 401/403 → kind "auth"；HTTP 200 + `{code,desc}` 里
// `020002` / `100002` → kind "auth"，其余业务码 → kind "business"。
// 路由层按 kind 映射 HTTP：auth → 401、invalid_input → 400、protocol → 502。

import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";

/**
 * 登录链路的固定常量。三个平面里只有账号（CAccount）平面参与登录：
 *   CAccount     https://account.xfinfr.com   （HMAC-SHA1 签名头）
 *   集成网关      https://loomyad.xunfei.cn    （session 放 token 头，登录后使用）
 * AccessKey 对随安装包分发、**不是用户凭证**，与 Rust endpoints.rs 的内置默认值
 * 完全一致（Rust 允许 LOOMY_XFYUN_* 环境变量覆盖；纯模块阶段先只保留常量）。
 */
export const LOOMY_LOGIN_CONFIG = Object.freeze({
  provider: "loomy",
  baseUrl: "https://account.xfinfr.com",
  sendCodePath: "/login/phone/sendMsgCode",
  verifyCodePath: "/login/phone/checkCode",
  // base 信封（客户端 `_makeBase()`）
  appId: "GM3LOOMY",
  modelId: "Web",
  clientVersion: "1.0.0",
  deviceId: "web",
  userAgent: "Loomy|Desktop|Electron|macOS",
  // 客户端内置签名对（Rust DEFAULT_ACCESS_KEY_ID / _SECRET）
  accessKeyId: "2thryby66wxi53sk",
  accessKeySecret: "zsak6eadrbawz683wf5r3m2snrwj868r",
  contentType: "application/json",
  defaultCcode: "86",
  // 发码有效期（请求 body 的 expire，秒）
  sendCodeExpireSeconds: 300,
  // 登录会话有效期（请求 body 的 expire，秒）：14 天，无 refresh
  sessionTtlSeconds: 14 * 24 * 3600,
  requestTimeoutMs: 20_000,
});

const SUCCESS_CODE = "000000";
/** 登录态失效业务码（Rust client.rs `AUTH_ERROR_CODES`）。 */
const AUTH_ERROR_CODES = new Set(["020002", "100002"]);

/**
 * 带分类信息的登录错误。调用方按 `kind` 决定响应码，不要把上游文案直接
 * 当成 HTTP 语义（业务错误常常是 HTTP 200）。
 *
 * kind:
 *   invalid_input — 本地参数不合法，未发请求
 *   network       — 连不上 / 超时
 *   http          — 非 2xx 且不是 401/403
 *   auth          — 401/403 或登录态失效业务码
 *   business      — 其余业务码
 *   protocol      — 2xx 但响应缺字段 / 不是 JSON
 */
export class LoomyLoginError extends Error {
  constructor(message, { kind = "protocol", status = 0, code = "", cause } = {}) {
    super(message);
    this.name = "LoomyLoginError";
    this.kind = kind;
    this.status = Number(status) || 0;
    this.code = code == null ? "" : String(code);
    if (cause) this.cause = cause;
  }
}

/** 业务码字符串化（缺省为空串）。 */
function businessCode(payload) {
  const code = payload?.code;
  if (code === undefined || code === null) return "";
  return String(code).trim();
}

/** 上游文案：`desc` → `message` → `msg`。 */
function upstreamMessage(payload) {
  for (const value of [payload?.desc, payload?.message, payload?.msg]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** 业务码是否代表登录态失效。 */
export function isLoomyAuthErrorCode(code) {
  return AUTH_ERROR_CODES.has(String(code ?? "").trim());
}

/** 手机号脱敏（保留前 3 后 4；与 Rust credentials::mask_phone 同口径）。 */
export function maskPhone(phone) {
  const text = String(phone ?? "");
  if (text.length < 7) return text;
  return `${text.slice(0, 3)}****${text.slice(-4)}`;
}

/**
 * 手机号归一化。`ccode` 默认 86；中国大陆号码与客户端
 * `^1[3-9]\d{9}$` 同口径，容忍 `+86` / `86` 前缀、空格与连字符。
 * 返回 `{phone, ccode}`，两者都是字符串（上游 param 期望字符串）。
 */
export function normalizePhone(raw, ccode = LOOMY_LOGIN_CONFIG.defaultCcode) {
  const cc = String(ccode ?? LOOMY_LOGIN_CONFIG.defaultCcode)
    .trim()
    .replace(/^\+/, "");
  if (!/^\d{1,4}$/.test(cc)) {
    throw new LoomyLoginError("国家区号格式不正确", { kind: "invalid_input" });
  }
  if (typeof raw !== "string" && typeof raw !== "number") {
    throw new LoomyLoginError("请填写手机号", { kind: "invalid_input" });
  }
  let digits = String(raw).replace(/[\s-]/g, "");
  if (cc === "86") {
    // 与 Rust 一致：先容忍 +86，再在剩余 11 位时去掉裸 86
    digits = digits.replace(/^\+/, "");
    if (digits.length === 13 && digits.startsWith("86")) digits = digits.slice(2);
    if (!/^1[3-9]\d{9}$/.test(digits)) {
      throw new LoomyLoginError("请填写 11 位中国大陆手机号", { kind: "invalid_input" });
    }
  } else if (!/^\d{5,15}$/.test(digits)) {
    throw new LoomyLoginError("手机号格式不正确（5–15 位数字）", { kind: "invalid_input" });
  }
  return { phone: digits, ccode: cc };
}

/** 6 位数字验证码（客户端把 mcode 当字符串传；这里保持字符串形态）。 */
export function normalizeSmsCode(raw) {
  const text = typeof raw === "string" || typeof raw === "number" ? String(raw).trim() : "";
  if (!/^\d{6}$/.test(text)) {
    throw new LoomyLoginError("请填写 6 位数字验证码", { kind: "invalid_input" });
  }
  return text;
}

/** 从候选路径里取第一个非空字符串（上游字段名/层级有过多种形态）。 */
function pickString(root, paths) {
  for (const path of paths) {
    let cur = root;
    for (const key of path) {
      if (cur == null || typeof cur !== "object") {
        cur = undefined;
        break;
      }
      cur = cur[key];
    }
    if (typeof cur === "string" && cur.trim()) return cur.trim();
    if (typeof cur === "number" && Number.isFinite(cur)) return String(cur);
  }
  return "";
}

/** 发码响应里的 msgid：`data.msgid` / `data.msgId` / `data.data.*`。 */
function extractMsgid(payload) {
  return pickString(payload, [
    ["data", "msgid"],
    ["data", "msgId"],
    ["data", "data", "msgid"],
    ["data", "data", "msgId"],
  ]);
}

/** 请求信封 base（客户端 `_makeBase()`；traceid 为 16 字节随机十六进制）。 */
function makeBase(traceid) {
  const id = typeof traceid === "string" && traceid.trim()
    ? traceid.trim()
    : randomBytes(16).toString("hex");
  return {
    appid: LOOMY_LOGIN_CONFIG.appId,
    modelid: LOOMY_LOGIN_CONFIG.modelId,
    version: LOOMY_LOGIN_CONFIG.clientVersion,
    devid: LOOMY_LOGIN_CONFIG.deviceId,
    ua: LOOMY_LOGIN_CONFIG.userAgent,
    traceid: id,
  };
}

/** RFC3986 转义一个路径段（等价于 JS encodeURIComponent 后再替换 !'()*）。 */
function escapePathSegment(segment) {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** 构建 ESCAPED_PATH：补前导 `/`、去尾部 `/`、逐段转义后以 `/` 连接。 */
export function buildEscapedPath(path) {
  let clean = String(path || "");
  if (!clean.startsWith("/")) clean = `/${clean}`;
  if (clean.length > 1 && clean.endsWith("/")) clean = clean.slice(0, -1);
  return clean.split("/").map(escapePathSegment).join("/");
}

/** base64(md5(UTF-8 字节))；空 body 返回空串（客户端 contentMD5('') 同款）。 */
function contentMd5(bodyText) {
  if (!bodyText) return "";
  return createHash("md5").update(bodyText, "utf8").digest("base64");
}

/** 时间注入：数字 / Date / 可解析字符串，缺省取当前时刻。 */
function resolveNow(now) {
  if (now === undefined || now === null) return Date.now();
  const value = now instanceof Date ? now.getTime() : typeof now === "number" ? now : Date.parse(now);
  return Number.isFinite(value) ? value : Date.now();
}

/**
 * 生成一次签名请求的头集合（`Authorization` / `Date` / `Nonce` /
 * `Content-MD5` / `Content-Type`）。
 *
 * `bodyText` 必须是**实际发送的字节串**（本模块先 JSON.stringify 一次再共用）；
 * 任何重新序列化都可能让 Content-MD5 对不上，而上游不会指出是哪一段错了。
 * `date` / `nonce` 可注入，供固定向量测试；缺省用当前 UTC 时间与 UUID v4。
 */
export function buildLoomySigningHeaders({
  method = "POST",
  path,
  bodyText = "",
  date,
  nonce,
  accessKeyId = LOOMY_LOGIN_CONFIG.accessKeyId,
  accessKeySecret = LOOMY_LOGIN_CONFIG.accessKeySecret,
} = {}) {
  if (!path) {
    throw new LoomyLoginError("缺少签名路径", { kind: "invalid_input" });
  }
  const httpDate = date || new Date().toUTCString();
  const requestNonce = nonce || randomUUID();
  const md5 = contentMd5(bodyText);
  // 9 段；末两段恒空 ⇒ nonce 之后两个 "\n"。用数组 join 固定段数。
  const stringToSign = [
    String(method).toUpperCase(),
    buildEscapedPath(path),
    "",
    md5,
    LOOMY_LOGIN_CONFIG.contentType,
    httpDate,
    requestNonce,
    "",
    "",
  ].join("\n");
  const signature = createHmac("sha1", accessKeySecret)
    .update(stringToSign, "utf8")
    .digest("base64");

  const headers = {
    Authorization: `account ${accessKeyId}:${signature}`,
    Date: httpDate,
    Nonce: requestNonce,
    "Content-Type": LOOMY_LOGIN_CONFIG.contentType,
    Accept: "application/json",
  };
  if (md5) headers["Content-MD5"] = md5;
  return headers;
}

/** 业务码 → 分类错误（登录链路专用文案，照 Rust describe_login_error）。 */
function businessFailure(payload, what) {
  const code = businessCode(payload);
  const desc = upstreamMessage(payload);
  if (AUTH_ERROR_CODES.has(code)) {
    return new LoomyLoginError("登录态已失效，请重新登录", { kind: "auth", code });
  }
  const detail = desc
    ? `登录失败：${desc}`
    : code
      ? `登录失败（上游 code=${code}）`
      : `${what}失败（上游没有返回业务码）`;
  return new LoomyLoginError(detail, { kind: "business", code });
}

/**
 * 签名 POST。返回解析后的响应体；HTTP / 业务码的**业务判定留给调用方**
 * （发码与登录对 msgid/session 的缺字段处置不同）。
 */
async function signedPost(path, body, what, options = {}) {
  const fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new LoomyLoginError("运行环境不支持 fetch", { kind: "network" });
  }
  // 只序列化一次：签名里的 Content-MD5 与真正发出去的 body 必须逐字节一致。
  const bodyText = JSON.stringify(body);
  const headers = buildLoomySigningHeaders({
    method: "POST",
    path,
    bodyText,
    date: options.date,
    nonce: options.nonce,
  });
  const url = `${LOOMY_LOGIN_CONFIG.baseUrl}${path}`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: bodyText,
      signal:
        typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
          ? AbortSignal.timeout(LOOMY_LOGIN_CONFIG.requestTimeoutMs)
          : undefined,
    });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    throw new LoomyLoginError(
      timedOut ? `${what}超时，请稍后重试` : `${what}失败：${error?.message || error}`,
      { kind: "network", cause: error },
    );
  }

  let text = "";
  try {
    if (typeof response?.text === "function") text = await response.text();
    else if (typeof response?.json === "function") text = JSON.stringify(await response.json());
  } catch {
    text = "";
  }
  const status = Number(response?.status) || 0;

  if (status === 401 || status === 403) {
    throw new LoomyLoginError(
      `${what}被拒绝（HTTP ${status}）：登录态已失效或签名被拒，请重新获取验证码`,
      { kind: "auth", status, code: "HTTP_401" },
    );
  }
  if (!response?.ok && !(status >= 200 && status < 300)) {
    throw new LoomyLoginError(
      `${what}返回 HTTP ${status}${text ? `：${text.slice(0, 300)}` : ""}`,
      { kind: "http", status },
    );
  }

  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new LoomyLoginError(`${what}响应不是 JSON（HTTP ${status}）`, {
      kind: "protocol",
      status,
    });
  }
  if (!payload || typeof payload !== "object") {
    throw new LoomyLoginError(`${what}响应为空`, { kind: "protocol", status });
  }
  return payload;
}

/**
 * 第一步：发送短信验证码。
 *
 * @param {{phone: string, ccode?: string}} input
 * @param {{fetchImpl?: Function, now?: number|Date, date?: string, nonce?: string, traceid?: string}} [options]
 *   `now`/`date`/`nonce`/`traceid` 仅用于固定向量测试，生产调用不传。
 * @returns {Promise<{msgid: string}>} msgid 必须原样带回 verifySmsCode
 */
export async function sendSmsCode({ phone, ccode = LOOMY_LOGIN_CONFIG.defaultCcode } = {}, options = {}) {
  const target = normalizePhone(phone, ccode);
  const body = {
    base: makeBase(options.traceid),
    param: {
      ccode: target.ccode,
      phone: target.phone,
      expire: LOOMY_LOGIN_CONFIG.sendCodeExpireSeconds,
    },
  };
  const payload = await signedPost(
    LOOMY_LOGIN_CONFIG.sendCodePath,
    body,
    "发送验证码",
    {
      ...options,
      date: options.date || new Date(resolveNow(options.now)).toUTCString(),
    },
  );

  const code = businessCode(payload);
  if (code !== SUCCESS_CODE) throw businessFailure(payload, "发送验证码");

  const msgid = extractMsgid(payload);
  if (!msgid) {
    throw new LoomyLoginError("验证码已发出但上游没有返回 msgid，请稍后重试", {
      kind: "protocol",
      code: "MISSING_MSGID",
    });
  }
  return { msgid };
}

/**
 * 第二步：手机号 + 验证码登录。返回可直接交给 createProviderConnection 的
 * 凭证 payload（session 14 天、无 refresh）。
 *
 * @param {{phone: string, code: string, msgid: string, ccode?: string}} input
 * @param {{fetchImpl?: Function, now?: number|Date, date?: string, nonce?: string, traceid?: string}} [options]
 * @returns {Promise<{accessToken: string, refreshToken: null, expiresIn: number,
 *   expiresAt: string, providerSpecificData: object, uid: string|null,
 *   name: string|null, email: string|null}>}
 */
export async function verifySmsCode(
  { phone, code, msgid, ccode = LOOMY_LOGIN_CONFIG.defaultCcode } = {},
  options = {},
) {
  const target = normalizePhone(phone, ccode);
  const mcode = normalizeSmsCode(code);
  const messageId = typeof msgid === "string" ? msgid.trim() : "";
  if (!messageId) {
    throw new LoomyLoginError(
      "缺少 msgid：请先点「发送验证码」，用本次发码返回的 msgid 登录",
      { kind: "invalid_input" },
    );
  }

  const body = {
    base: makeBase(options.traceid),
    param: {
      ccode: target.ccode,
      phone: target.phone,
      mcode,
      msgid: messageId,
      // 会话 14 天（客户端 loginBySmsCode 的同款取值）
      expire: LOOMY_LOGIN_CONFIG.sessionTtlSeconds,
    },
  };
  const nowMs = resolveNow(options.now);
  const payload = await signedPost(
    LOOMY_LOGIN_CONFIG.verifyCodePath,
    body,
    "登录",
    { ...options, date: options.date || new Date(nowMs).toUTCString() },
  );

  const status = businessCode(payload);
  if (status !== SUCCESS_CODE) throw businessFailure(payload, "登录");

  const data = payload?.data;
  const session = pickString(data, [["session"]]);
  if (!session) {
    throw new LoomyLoginError("登录成功但上游没有返回 session", {
      kind: "protocol",
      code: "MISSING_SESSION",
    });
  }
  const userId = pickString(data, [["userid"], ["userId"], ["user_id"], ["uid"]]);
  const name = pickString(data, [["name"], ["nickname"], ["userName"], ["displayName"]]);
  const email = pickString(data, [["email"], ["mail"]]);
  const expiresAt = new Date(nowMs + LOOMY_LOGIN_CONFIG.sessionTtlSeconds * 1000).toISOString();

  return {
    accessToken: session,
    // 上游没有 refresh 接口：显式置 null，避免刷新链把它当成可续期凭证。
    refreshToken: null,
    expiresIn: LOOMY_LOGIN_CONFIG.sessionTtlSeconds,
    expiresAt,
    providerSpecificData: {
      authMethod: "sms",
      userId,
      session,
      phone: target.phone,
      phoneTail: maskPhone(target.phone),
      ccode: target.ccode,
    },
    uid: userId || null,
    name: name || null,
    email: email || null,
  };
}

/**
 * mapTokens：把 verifySmsCode 的 payload 折成连接行字段。
 *
 * createProviderConnection 的 oauth 去重依赖非空 email；上游 checkCode 通常
 * 不返回邮箱，因此用 userId 造一个稳定标识（与 qoder/lobsterai 同款处置），
 * 重登会更新同一行而不是堆出 "Account N"。`displayName` 用脱敏手机号尾号，
 * 便于用户在账号列表里区分。
 */
export function mapTokens(tokens) {
  const source = tokens && typeof tokens === "object" ? tokens : {};
  const psd = source.providerSpecificData && typeof source.providerSpecificData === "object"
    ? source.providerSpecificData
    : {};
  const uid = String(source.uid || psd.userId || "").trim();
  const email = String(source.email || "").trim() || (uid ? `loomy-${uid}` : null);
  const displayName =
    String(source.name || "").trim() ||
    (psd.phoneTail ? `Loomy ${psd.phoneTail}` : uid ? `Loomy ${uid}` : "Loomy");
  return {
    accessToken: source.accessToken,
    refreshToken: null,
    expiresIn: source.expiresIn ?? LOOMY_LOGIN_CONFIG.sessionTtlSeconds,
    expiresAt: source.expiresAt,
    email,
    displayName,
    providerSpecificData: { ...psd, authMethod: "sms" },
  };
}

/**
 * 默认导出：挂进 `src/lib/oauth/providers/index.js` 的 PROVIDERS 时使用。
 * `flowType: "sms_code"` 不是通用 `authorization_code` / `device_code`，
 * 路由与 OAuthModal 需要各自的短信两步分支（见交付报告）。
 */
const loomy = {
  config: {
    ...LOOMY_LOGIN_CONFIG,
    authorizeUrl: null,
    tokenUrl: `${LOOMY_LOGIN_CONFIG.baseUrl}${LOOMY_LOGIN_CONFIG.verifyCodePath}`,
  },
  flowType: "sms_code",
  sendSmsCode,
  verifySmsCode,
  mapTokens,
};

export default loomy;
