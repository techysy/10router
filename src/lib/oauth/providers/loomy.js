/**
 * 讯飞 Loomy 手机验证码直登（CreditDaddy loomyAuth 同源移植）。
 *
 * 逆向自 Loomy 生产客户端的统一账号体系（account.xfinfr.com，HMAC-SHA1 请求签名）：
 *   POST /login/phone/sendMsgCode  → { msgid }
 *   POST /login/phone/checkCode    → { session, userid }（expire=14 天）
 *
 * 与 CD 端 src/loomyAuth.js 保持同一签名实现——两边升级签名时需同步修改。
 * 纯函数无 DB 依赖：路由层负责把登录结果落成 providerConnection。
 */

import crypto from "crypto";

export const LOOMY_AUTH_CONFIG = {
  baseUrl: "https://account.xfinfr.com",
  accessKeyId: "2thryby66wxi53sk",
  accessKeySecret: "zsak6eadrbawz683wf5r3m2snrwj868r",
  appId: "GM3LOOMY",
};

const PHONE_RE = /^1[3-9]\d{9}$/;

function contentMD5(body) {
  const hash = crypto.createHash("md5").update(body, "utf8").digest();
  return hash.toString("base64");
}

function buildEscapedPath(path) {
  // RFC3986 §3.3 path 段转义（与客户端 sign.js 一致）
  const clean = path.startsWith("/") ? path : "/" + path;
  return clean
    .split("/")
    .map((seg) => (seg ? encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`) : ""))
    .join("/");
}

function sign({ method, path, body, date, nonce }) {
  // StringToSign = method \n path \n query \n contentMD5 \n contentType \n date \n nonce \n signedHeaders \n canonicalHeaders
  const parts = [
    method.toUpperCase(),
    buildEscapedPath(path),
    "",
    contentMD5(body),
    "application/json",
    date,
    nonce,
    "",
    "",
  ];
  return crypto.createHmac("sha1", LOOMY_AUTH_CONFIG.accessKeySecret).update(parts.join("\n"), "utf8").digest("base64");
}

function makeBase() {
  return {
    appid: LOOMY_AUTH_CONFIG.appId,
    modelid: "Web",
    version: "1.0.0",
    devid: "web",
    ua: "Loomy|Desktop|Electron|Windows",
    traceid: crypto.randomUUID().replace(/-/g, ""),
  };
}

async function requestLoomy(path, param) {
  const body = JSON.stringify({ base: makeBase(), param });
  const date = new Date().toUTCString();
  const nonce = crypto.randomUUID();
  const res = await fetch(`${LOOMY_AUTH_CONFIG.baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `account ${LOOMY_AUTH_CONFIG.accessKeyId}:${sign({ method: "POST", path, body, date, nonce })}`,
      Date: date,
      Nonce: nonce,
      "Content-Type": "application/json",
      "Content-MD5": contentMD5(body),
      Accept: "application/json",
    },
    body,
    signal: AbortSignal.timeout(15000),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json?.desc || `讯飞认证接口 HTTP ${res.status}`);
  }
  if (json.code && json.code !== "000000") {
    throw new Error(json.desc || `讯飞账号错误 (${json.code})`);
  }
  return json.data || {};
}

/** 发送登录验证码 → { msgid }（msgid 5 分钟有效） */
export async function sendLoomySms(phone) {
  const clean = String(phone || "").trim();
  if (!PHONE_RE.test(clean)) throw new Error("手机号格式不正确");
  const data = await requestLoomy("/login/phone/sendMsgCode", { ccode: "86", phone: clean, expire: 300 });
  if (!data?.msgid) throw new Error("讯飞接口未返回 msgid");
  return { msgid: data.msgid };
}

/** 验证码换 14 天 session → { session, userid, phone } */
export async function loginLoomyBySms({ phone, code, msgid }) {
  const cleanPhone = String(phone || "").trim();
  const cleanCode = String(code || "").trim();
  if (!PHONE_RE.test(cleanPhone)) throw new Error("手机号格式不正确");
  if (!cleanCode || !String(msgid || "").trim()) throw new Error("缺少验证码或 msgid");
  const data = await requestLoomy("/login/phone/checkCode", {
    ccode: "86",
    phone: cleanPhone,
    mcode: cleanCode,
    msgid: String(msgid).trim(),
    expire: 14 * 24 * 3600,
  });
  if (!data?.session) throw new Error("登录未返回 session 凭据");
  return { session: data.session, userid: data.userid || data.uid, phone: cleanPhone };
}

/** 连接展示名（手机号脱敏） */
export function loomyConnectionName(phone, userid) {
  if (phone && phone.length >= 7) return `Loomy (${phone.slice(0, 3)}****${phone.slice(-4)})`;
  if (userid) return `Loomy (${String(userid).slice(-6)})`;
  return "Loomy";
}
