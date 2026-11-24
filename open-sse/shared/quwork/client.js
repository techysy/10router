// QuWork（quwork.cn，人人租 QurWork 桌面端）— 账号/推理协议客户端。
//
// 协议事实取自开源 npm 包 quwork-auth@0.1.0（github okdunli/quwork-auth，MIT），
// 该包从 QuWork 0.2.2-rc.1 的 app.asar 读出：
//   账号网关  https://llm.rrzu.com（端点配置 img1.rrzuji.cn/.../quwork-desktop-api-endpoint-config.json）
//   推理网关  https://llm.quwork.cn/v1（OpenAI 兼容：/chat/completions、/models）
//   模型目录  https://img1.rrzuji.cn/qurvis-package/latest/qurvis-desktop-model-config.json
// 公共头 X-QurWork-Env: prod / X-QurWork-Version: 0.2.2-rc.1；账号接口统一包
// {success,data,message,code}。
//
// 凭据：登录返回 llm_token（推理 Bearer，QuWork 不轮换）+ token（账号 access
// token，~2h，/api/user/refresh 续期；积分/签到用）。
//
// 网络：不内置代理。所有函数收可选 proxyOptions（10Router 通用的连接级代理
// 配置，由调用方从 resolveConnectionProxyConfig 解析后传入；为空则走全局
// fetch，即全局出站代理 / 环境变量代理）。
import { createHash, randomBytes } from "node:crypto";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import quworkDefinition from "../../providers/registry/quwork.js";

const OAUTH = quworkDefinition.oauth;
export const QUWORK_AUTH_API = OAUTH.apiBaseUrl;
export const QUWORK_API_URL = OAUTH.inferenceBaseUrl;
export const QUWORK_CLIENT_VERSION = OAUTH.clientVersion;
export const QUWORK_MODEL_CONFIG_URL = OAUTH.modelConfigUrl;
export const QUWORK_CAPTCHA = OAUTH.captcha;
export const QUWORK_HEADERS = { "X-QurWork-Env": "prod", "X-QurWork-Version": QUWORK_CLIENT_VERSION };
export const QUWORK_PHONE_RE = /^1\d{10}$/;
const TIMEOUT_MS = 20_000;

export const QUWORK_FALLBACK_MODELS = [
  { id: "deepseek-flash", name: "DeepSeek-V4.1-Flash" },
  { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro" },
  { id: "kimi-k2.7-code", name: "Kimi-K2.7-Code" },
  { id: "kimi-k2.6", name: "Kimi-K2.6" },
  { id: "glm-5.2", name: "GLM-5.2" },
  { id: "glm-5.3-flash", name: "GLM-5.3 Flash" },
  { id: "qwen3.7-plus", name: "Qwen3.7-Plus" },
  { id: "qwen3.8-max", name: "Qwen3.8-Max" },
  { id: "qwen3.8-flash", name: "Qwen3.8-Flash" },
  { id: "MiniMax-M2.5", name: "MiniMax-M2.5" },
];

const norm = (v) => String(v ?? "").trim();

export class QuworkAuthError extends Error {
  constructor(message, { status = 0, code = "", expired = false } = {}) {
    super(message);
    this.name = "QuworkAuthError";
    this.status = status;
    this.code = code;
    this.expired = expired;
  }
}

/** Call the QuWork account gateway and unwrap {success,data,message,code}. */
export async function quworkApiRequest(path, {
  method = "GET", accessToken, form, json, proxyOptions = null, fetchImpl = proxyAwareFetch, timeoutMs = TIMEOUT_MS,
} = {}) {
  const headers = { Accept: "application/json", ...QUWORK_HEADERS };
  let body;
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(form).toString();
  } else if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  }
  let res;
  try {
    res = await fetchImpl(QUWORK_AUTH_API + path, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) }, proxyOptions);
  } catch (e) {
    throw new QuworkAuthError(`QuWork 网络请求失败：${e?.message || e}`);
  }
  const text = await res.text().catch(() => "");
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text.slice(0, 200) }; }
  if (res.status === 405) {
    throw new QuworkAuthError("QuWork 网关拒绝（HTTP 405，阿里云 WAF 拦截非中国大陆 IP）——请在设置中配置国内出站代理或连接代理", { status: 405 });
  }
  if (res.status === 401 || res.status === 403) {
    throw new QuworkAuthError(norm(payload?.message) || "QuWork 登录已失效，请重新登录", { status: res.status, expired: true });
  }
  if (payload && typeof payload === "object" && "success" in payload && !payload.success) {
    throw new QuworkAuthError(norm(payload.message) || norm(payload.code) || "QuWork 接口返回失败", { status: res.status, code: norm(payload.code) });
  }
  if (!res.ok) throw new QuworkAuthError(`QuWork 接口 HTTP ${res.status}`, { status: res.status });
  return payload && typeof payload === "object" && "data" in payload ? (payload.data ?? {}) : payload;
}

/** 64-hex device identifier (QuWork-shaped). Random per login unless a seed is given. */
export function quworkDeviceIdentifier(seed) {
  const value = norm(seed) || randomBytes(32).toString("hex");
  return createHash("sha256").update(JSON.stringify({
    ns: "quwork.device-identifier", version: 1, platform: "other", source: "generated", value,
  })).digest("hex");
}

export async function quworkSendLoginCode(phone, captchaToken, opts = {}) {
  const p = norm(phone);
  if (!QUWORK_PHONE_RE.test(p)) throw new QuworkAuthError("请输入 11 位中国大陆手机号");
  const q = captchaToken ? `?${new URLSearchParams({ aliyun_captcha: captchaToken }).toString()}` : "";
  return quworkApiRequest(`/api/sendVerifyCode${q}`, { ...opts, method: "POST", form: { phone: p, type: "login" } });
}

export function quworkCredentialFromLogin(data, meta = {}) {
  const llm = norm(data?.llm_token || data?.llmToken);
  const access = norm(data?.token);
  const user = data?.user && typeof data.user === "object" ? data.user : {};
  if (!llm) throw new QuworkAuthError("登录响应缺少 llm_token（账号可能未激活）");
  const expiresAt = Number(data?.expire) > 0 ? Number(data.expire) * 1000 : Date.now() + 2 * 3600_000;
  const nickname = norm(user.display_name || user.nickname || user.nickName || user.username);
  return {
    llmToken: llm,
    accessToken: access,
    accessExpiresAt: expiresAt,
    nickname,
    uid: user.id === undefined || user.id === null ? "" : String(user.id),
    phone: norm(meta.phone || user.phone),
  };
}

export async function quworkLoginByCode(phone, code, { deviceId, proxyOptions = null, fetchImpl } = {}) {
  const json = {
    phone: norm(phone),
    verification_code: norm(code),
    platform: OAUTH.platform,
    device_identifier: deviceId || quworkDeviceIdentifier(),
    device_uuid: "",
  };
  const data = await quworkApiRequest("/api/user/client/login", { method: "POST", json, proxyOptions, fetchImpl });
  return quworkCredentialFromLogin(data, { phone });
}

export async function quworkSelfInfo(accessToken, opts = {}) {
  return quworkApiRequest("/api/user/self", { ...opts, accessToken });
}

/** Renew the account token. llm_token is not rotated by QuWork. */
export async function quworkRefreshAccess(accessToken, opts = {}) {
  const data = await quworkApiRequest("/api/user/refresh", { ...opts, accessToken });
  const next = norm(data?.token) || accessToken;
  const expiresAt = Number(data?.expire) > 0 ? Number(data.expire) * 1000 : Date.now() + 2 * 3600_000;
  return { accessToken: next, accessExpiresAt: expiresAt };
}

export async function quworkDailyRewardStatus(accessToken, opts = {}) {
  return quworkApiRequest("/api/user/daily-reward/status", { ...opts, accessToken });
}

export async function quworkDailyRewardClaim(accessToken, opts = {}) {
  return quworkApiRequest("/api/user/daily-reward/claim", { ...opts, method: "POST", accessToken, json: {} });
}

/**
 * Status-gated daily reward: never blind-fires claim.
 * outcome: claimed | done | wechat_required | failed
 */
export async function quworkClaimDailyReward(accessToken, opts = {}) {
  const before = await quworkDailyRewardStatus(accessToken, opts);
  if (before?.wechat_required && before?.can_claim) {
    return { outcome: "wechat_required", claimed: false, points: 0, message: "今日签到需要先在 QuWork 客户端绑定微信", status: before };
  }
  if (before?.claimed === true || before?.can_claim === false) {
    return { outcome: "done", claimed: false, points: 0, message: "今日已领取", status: before };
  }
  const after = await quworkDailyRewardClaim(accessToken, opts);
  if (after?.granted) {
    const points = Number(after.points ?? 0) || 0;
    return { outcome: "claimed", claimed: true, points, message: `签到成功，+${points} 积分`, status: after };
  }
  return { outcome: "done", claimed: false, points: 0, message: "今日已领取", status: after };
}

/** Points numbers from /api/user/self (points_entitlement.total_points = current balance). */
export function quworkPointsFromSelf(self) {
  const e = self?.points_entitlement ?? self?.pointsEntitlement ?? {};
  const n = (v) => (v === undefined || v === null || v === "" ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
  const remaining = n(e.remaining_points ?? e.remainingPoints) ?? n(e.total_points ?? e.totalPoints);
  return {
    remaining,
    limited: n(e.limited_points ?? e.limitedPoints),
    permanent: n(e.permanent_points ?? e.permanentPoints),
    nickname: norm(self?.display_name || self?.nickname || self?.username),
  };
}

/** Live model catalog (public JSON), falling back to the bundled list. */
export async function quworkLiveModels({ proxyOptions = null, fetchImpl = proxyAwareFetch } = {}) {
  try {
    const res = await fetchImpl(QUWORK_MODEL_CONFIG_URL, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) }, proxyOptions);
    if (!res.ok) return QUWORK_FALLBACK_MODELS;
    const payload = await res.json();
    const rows = (payload?.providers ?? [])
      .filter((p) => String(p.id ?? "").startsWith("qurwork"))
      .flatMap((p) => p.models ?? [])
      .filter((m) => m?.enabled !== false && norm(m.id))
      .map((m) => ({ id: norm(m.id), name: norm(m.name) || norm(m.id) }));
    return rows.length ? rows : QUWORK_FALLBACK_MODELS;
  } catch {
    return QUWORK_FALLBACK_MODELS;
  }
}

/** Probe the inference gateway with llm_token (GET /v1/models — no credits spent). */
export async function quworkProbeInference(llmToken, { proxyOptions = null, fetchImpl = proxyAwareFetch } = {}) {
  const res = await fetchImpl(`${QUWORK_API_URL}/models`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${llmToken}`, ...QUWORK_HEADERS },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }, proxyOptions);
  const text = await res.text().catch(() => "");
  let data = null;
  try { data = JSON.parse(text); } catch { /* ignore */ }
  const models = Array.isArray(data?.data) ? data.data.map((m) => norm(m?.id)).filter(Boolean) : [];
  return { ok: res.ok, status: res.status, models, error: res.ok ? "" : (norm(data?.error?.message) || `HTTP ${res.status}`) };
}

export function quworkConnectionName({ nickname, phone, uid } = {}) {
  const p = norm(phone);
  const masked = p.length >= 7 ? `${p.slice(0, 3)}****${p.slice(-4)}` : p;
  return norm(nickname) || masked || (uid ? `QuWork ${uid}` : "QuWork");
}

/** Stable identity key stored in the connection's email slot (dedupes re-logins). */
export function quworkIdentity({ uid, phone, llmToken } = {}) {
  if (norm(uid)) return `quwork-user-${norm(uid)}`;
  if (norm(phone)) return `quwork-phone-${createHash("sha256").update(norm(phone)).digest("hex").slice(0, 16)}`;
  return `quwork-key-${createHash("sha256").update(norm(llmToken)).digest("hex").slice(0, 16)}`;
}
