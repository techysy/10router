// Loomy（讯飞）executor — OpenAI-compatible chat with a deceptively successful
// error plane.
//
// Three provider-specific things (all verified against our Rust provider,
// agent2api loomy/{mod,client,balance}.rs):
//   1. **Dual auth headers.** The model gateway prefers `Authorization: Bearer`,
//      the points/business gateway prefers `token`. Sending both is what the
//      official client does and what the Rust adapter does.
//   2. **`max_tokens` defaults to 32768.** Without it the upstream silently
//      truncates long answers at roughly 7k tokens (a 200 with a short answer —
//      no error to inspect).
//   3. **Business errors arrive as HTTP 200 + `{code,desc}`.** `000000` is
//      success; `020002` / `100002` are dead sessions. A 200 envelope must become
//      a real non-2xx here, otherwise account fallback records a success and the
//      client sees an empty answer.
//
// A bare HTTP 429 is rate limiting, NOT quota exhaustion: confusing the two
// once cooled healthy accounts for 6 hours. `QUOTA_STRONG_RE` is deliberately
// strict — only explicit "points/quota exhausted" copy may take the quota path.

import { DefaultExecutor } from "./default.js";
import { errorResponse } from "../utils/error.js";

const DEFAULT_MAX_TOKENS = 32768;
const MESSAGE_LIMIT = 500;

/** Business success codes: `000000` (documented) and the numeric forms some
 * gateways emit. An absent code is a plain OpenAI body, not an envelope. */
const SUCCESS_CODES = new Set(["", "0", "000000"]);

/** Session-dead business codes (`AUTH_ERROR_CODES` in Rust client.rs). */
const AUTH_ERROR_CODES = new Set(["020002", "100002"]);

/**
 * Strong quota-exhaustion copy only. Must not match a plain rate limit
 * ("too many requests" / "请求过于频繁"), otherwise a burst on a healthy
 * account is cooled down as if its balance were empty.
 */
export const QUOTA_STRONG_RE =
  /(积分|点数|额度|余额)\s*(已)?\s*(不足|用完|耗尽|用尽|超限|扣光)|insufficient\s+(quota|points|credits|balance)|quota\s+(exceeded|exhausted|depleted)|no\s+points\s+left|out\s+of\s+(points|credits)/i;

export function tokenOf(credentials) {
  return String(credentials?.accessToken || credentials?.apiKey || "").trim();
}

/** Business code as a trimmed string (`code` may be a string or a number). */
export function businessCode(payload) {
  const code = payload?.code;
  if (code === undefined || code === null) return "";
  return String(code).trim();
}

export function isSuccessCode(code) {
  return SUCCESS_CODES.has(String(code ?? "").trim());
}

export function isAuthErrorCode(code) {
  return AUTH_ERROR_CODES.has(String(code ?? "").trim());
}

/** `desc` → `message` → `msg` → `error.message`; never returns the raw body. */
export function upstreamMessage(payload) {
  if (!payload || typeof payload !== "object") return "";
  const candidates = [
    payload.desc,
    payload.message,
    payload.msg,
    payload.error?.message,
    payload.data?.desc,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      return value.trim().slice(0, MESSAGE_LIMIT);
    }
  }
  return "";
}

/**
 * Turn any Loomy failure (HTTP status, JSON envelope, plain text) into the
 * `{status,message,kind}` the pipeline understands.
 *
 * `kind`: auth | quota | rate-limit | upstream.
 */
export function classifyLoomyFailure({ status = 0, payload = null, text = "" } = {}) {
  const code = businessCode(payload);
  const message = upstreamMessage(payload) || String(text || "").trim().slice(0, MESSAGE_LIMIT);
  const readable = message || "上游未返回错误文案";

  if (status === 401 || status === 403 || isAuthErrorCode(code)) {
    return {
      status: 401,
      kind: "auth",
      message: `Loomy 登录态已失效（会话 14 天且无续期接口，请重新导入 session）：${readable}`,
    };
  }
  if (QUOTA_STRONG_RE.test(readable) || QUOTA_STRONG_RE.test(String(code))) {
    return {
      status: 429,
      kind: "quota",
      message: `Loomy 积分已耗尽：${readable}。签到/兑换后重试，或改用其他账号。`,
    };
  }
  if (status === 429) {
    return {
      status: 429,
      kind: "rate-limit",
      message: `Loomy 请求被限流（HTTP 429，额度未必耗尽）：${readable}`,
    };
  }
  if (status >= 400) {
    return {
      status,
      kind: "upstream",
      message: `Loomy 上游返回 HTTP ${status}：${readable}`,
    };
  }
  return {
    status: 502,
    kind: "upstream",
    message: `Loomy 上游返回业务错误${code ? `（code=${code}）` : ""}：${readable}`,
  };
}

/** 200-with-error-envelope detector. SSE bodies are left untouched. */
export async function detectLoomyEnvelope(response) {
  if (!response || !response.ok) return null;
  const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
  if (contentType.includes("text/event-stream")) return null;

  let text = "";
  try {
    text = await response.clone().text();
  } catch {
    return null;
  }
  if (!text.trim()) return null;

  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

  const code = businessCode(payload);
  const hasChoices = Array.isArray(payload.choices) && payload.choices.length > 0;

  // Plain OpenAI success (no envelope) — pass through byte-for-byte.
  if (!code && hasChoices) return null;
  if (isSuccessCode(code)) return null;
  // No code and no choices: only treat an explicit error object as a failure.
  if (!code && !payload.error) return null;

  return classifyLoomyFailure({ status: 200, payload });
}

export class LoomyExecutor extends DefaultExecutor {
  constructor(provider = "loomy") {
    super(provider);
  }

  transformRequest(model, body) {
    const base = super.transformRequest(model, body);
    if (!base || typeof base !== "object") return base;
    const payload = { ...base };
    if (!payload.model && typeof model === "string" && model.trim()) {
      payload.model = model;
    }
    // Without an explicit cap Loomy truncates around 7k tokens and still
    // answers 200 — the caller cannot tell a short answer from a cut one.
    if (payload.max_tokens == null && payload.max_completion_tokens == null) {
      payload.max_tokens = DEFAULT_MAX_TOKENS;
    }
    return payload;
  }

  buildHeaders(credentials, stream = true) {
    const headers = {
      "Content-Type": "application/json",
      Accept: stream ? "text/event-stream" : "application/json",
    };
    const token = tokenOf(credentials);
    if (token) {
      // Chat only honours Bearer; the points/business plane only honours
      // `token`. Both are sent so one connection serves both planes.
      headers.token = token;
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  async execute(options) {
    const result = await super.execute(options);
    const failure = await detectLoomyEnvelope(result?.response);
    if (!failure) return result;
    // A 200 envelope is not a generation. Present it as a real failure so the
    // fallback loop moves on instead of recording an empty success.
    return { ...result, response: errorResponse(failure.status, failure.message) };
  }

  parseError(response, bodyText) {
    let payload = null;
    try {
      payload = JSON.parse(String(bodyText || ""));
    } catch {
      payload = null;
    }
    const failure = classifyLoomyFailure({
      status: response?.status || 502,
      payload,
      text: payload ? "" : bodyText,
    });
    return { status: failure.status, message: failure.message };
  }
}

export { DEFAULT_MAX_TOKENS };

export default LoomyExecutor;
