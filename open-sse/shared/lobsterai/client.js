// LobsterAI 共享客户端逻辑：版本解析、信封解包、200 假成功分类、积分读数。
//
// 这一层只做纯逻辑 + 一次版本查询，不碰对话转发（那是 executors/lobsterai.js
// 的事）。签到、余额、登录续期都从这里取同一套判据，避免三个调用点各写一份
// marker 表后慢慢漂移。

import crypto from "node:crypto";
import {
  LOBSTERAI_ALREADY_CHECKED_IN_MARKERS,
  LOBSTERAI_CLIENT_VERSION_API,
  LOBSTERAI_FALLBACK_CLIENT_VERSION,
  LOBSTERAI_HARD_CREDIT_CODE,
  LOBSTERAI_HARD_CREDIT_MARKERS,
  LOBSTERAI_SESSION_DEAD_CODES,
  LOBSTERAI_SESSION_DEAD_MARKERS,
  LOBSTERAI_USER_AGENT,
  LOBSTERAI_VERSION_TTL_MS,
} from "./constants.js";

/** 业务码归一：数字与数字字符串都认，其余 undefined */
export function numericCode(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** marker 命中：英文小写比对，中文原文比对（与 Rust errors.rs 同口径） */
function markersHit(text, markers) {
  if (!text) return false;
  const lower = String(text).toLowerCase();
  return markers.some((marker) => lower.includes(marker.toLowerCase()) || text.includes(marker));
}

/** 正文是否在说「余额耗尽」（含 200 假成功帧里的 `"code":40201`） */
export function isHardCreditText(text) {
  if (!text) return false;
  if (markersHit(text, LOBSTERAI_HARD_CREDIT_MARKERS)) return true;
  // 单测 JSON 里空格形态不固定（`"code":40201` / `"code": 40201`）
  return /"?code"?\s*:\s*40201\b/.test(String(text));
}

/** 正文里是否含会话已死标记（40100 / 40101 也是文本，按文本判） */
export function isSessionDeadText(text) {
  return markersHit(text, LOBSTERAI_SESSION_DEAD_MARKERS);
}

/**
 * 上游失败分类（HTTP 状态 + 正文）。
 *
 * 判定顺序是契约：402 / 余额关键词 → 会话已死 → 429 → 404 → 5xx → 其余 4xx。
 * 关键词**先于**状态码（402 除外）：实测上游用 HTTP 400 + 中文「积分不足」
 * 表达余额耗尽，只按状态码会把它当成可重试的客户端错误。
 *
 * @returns {"hard-credit"|"session-dead"|"rate-limit"|"not-found"|"server"|"client"}
 */
export function classifyFailure(status, text) {
  const raw = String(text || "");
  if (status === 402) return "hard-credit";
  if (isHardCreditText(raw)) return "hard-credit";
  if (isSessionDeadText(raw)) return "session-dead";
  if (status === 401 || status === 403) return "session-dead";
  if (status === 429) return "rate-limit";
  if (status === 404) return "not-found";
  if (status >= 500) return "server";
  return "client";
}

/** 分类 → 交给编排层的 HTTP 状态（200 假成功也走这里，未知 marker 归 400 不罚账号） */
export function statusForFailure(kind) {
  switch (kind) {
    case "hard-credit":
      return 402;
    case "session-dead":
      return 401;
    case "rate-limit":
      return 429;
    case "not-found":
      return 404;
    case "server":
      return 502;
    default:
      return 400;
  }
}

/** 从业务信封 / 错误体里取一行可读文案 */
export function messageOf(payload) {
  if (!payload || typeof payload !== "object") return "";
  const direct = payload.message || payload.msg || payload.error_description;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const error = payload.error;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object") {
    const nested = error.message || error.msg;
    if (typeof nested === "string" && nested.trim()) return nested.trim();
  }
  return "";
}

/**
 * 解 `{code, msg, data}` 业务信封。
 *
 * `code === 0` 且 `data` 非 null 才算成功 —— `data: null` 配 `code: 0` 是
 * 「登录态失效」的形态（参考实现实测），把它当成功会让上层拿空数据继续跑。
 * 没有 `code` 字段的裸对象按 data 放行（少数接口直接回对象）。
 */
export function unwrapEnvelope(payload, what = "请求") {
  if (!payload || typeof payload !== "object") {
    return { ok: false, status: 502, message: `LobsterAI ${what}响应不是 JSON 对象` };
  }
  if (!Object.prototype.hasOwnProperty.call(payload, "code")) {
    return { ok: true, data: payload };
  }
  const code = numericCode(payload.code);
  if (code !== 0) {
    const detail = messageOf(payload) || `code=${payload.code ?? "?"}`;
    return { ok: false, status: 502, code, message: `LobsterAI ${what}失败：${detail}` };
  }
  if (payload.data === null || payload.data === undefined) {
    return {
      ok: false,
      status: 401,
      message: `LobsterAI ${what}未返回数据（登录态可能已失效），请重新登录`,
    };
  }
  return { ok: true, data: payload.data };
}

/**
 * 识别 200 SSE 正文里的错误帧。
 *
 * 形态：`event:error` + `data: {...}`，或 data JSON 里带 `error` / 非零业务码
 * （参考实现 `isSSEErrorFrame` + `errFromFrame`）。返回 `{message, code, kind}`
 * 或 null（正常帧 / 空正文）。
 */
export function parseSseErrorFrame(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const isEventError = /(?:^|\n)event:\s*error\b/i.test(raw);
  const dataLines = raw
    .split(/\r?\n/)
    .filter((line) => /^data:\s*/i.test(line))
    .map((line) => line.replace(/^data:\s*/i, "").trim())
    .filter((line) => line && line !== "[DONE]");

  let frame = null;
  for (const line of dataLines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") {
        frame = parsed;
        break;
      }
    } catch {
      // 非 JSON 的 data 行：只有 event:error 时才当错误处理
    }
  }

  // 整个正文就是 JSON（没有 data: 前缀的错误体）
  if (!frame && !dataLines.length) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") frame = parsed;
    } catch {
      // 纯文本错误帧（event:error + 人类可读正文）
    }
  }

  const hasErrorField =
    !!frame && typeof frame === "object" && !!frame.error;
  const frameCode = frame ? numericCode(frame.code) : undefined;
  const frameIsError = isEventError || hasErrorField || (frameCode !== undefined && frameCode !== 0);

  if (!frameIsError) return null;

  const message = messageOf(frame) || raw.slice(0, 500);
  const code = frameCode ?? numericCode(frame?.error?.code);
  const markerText = `${raw}\n${message}`;
  const kind = isHardCreditText(markerText)
    ? "hard-credit"
    : isSessionDeadText(markerText)
      ? "session-dead"
      : "client";

  return {
    message: code !== undefined ? `code=${code} ${message}`.trim() : message,
    code,
    kind,
    status: statusForFailure(kind),
  };
}

/** 会话已死业务码（数值形态，信封解析用） */
export function isSessionDeadCode(code) {
  const value = numericCode(code);
  return value !== undefined && LOBSTERAI_SESSION_DEAD_CODES.includes(value);
}

/** 已签到 / 重复领取的中性文案 */
export function isAlreadyCheckedInText(text) {
  return markersHit(text, LOBSTERAI_ALREADY_CHECKED_IN_MARKERS);
}

/** 读数字（数字或数字字符串都认） */
export function readNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** 保留两位小数并夹到非负（服务端浮点噪声 / 计量回滚会报负数） */
export function roundCredits(value) {
  const number = readNumber(value);
  if (number === undefined) return undefined;
  return Math.round(Math.max(0, number) * 100) / 100;
}

/**
 * 从 `profile-summary` 的 data 里读积分：
 *   totalCreditsRemaining（权威）→ creditItems[].creditsRemaining 求和（真实读数）
 *
 * 读不到时 available 为 null（**不要写 0**：那会被限额判定当成「余额为 0」）。
 */
export function parseCredits(data) {
  const payload = data && typeof data === "object" ? data : {};
  const items = Array.isArray(payload.creditItems)
    ? payload.creditItems
        .filter((item) => item && typeof item === "object")
        .map((item) => ({
          type: typeof item.type === "string" && item.type.trim() ? item.type.trim() : "积分包",
          remaining: roundCredits(item.creditsRemaining) ?? 0,
          expiresAt: typeof item.expiresAt === "string" ? item.expiresAt.trim() : "",
        }))
    : [];

  const total = roundCredits(payload.totalCreditsRemaining);
  let available = total ?? null;
  if (available === null && items.length) {
    available = roundCredits(items.reduce((sum, item) => sum + item.remaining, 0)) ?? null;
  }
  return { available, items };
}

/** 生成 UUID v4（签到幂等键 / 登录安装标识） */
export function uuidV4() {
  return crypto.randomUUID();
}

/** 从 JWT 里读 `exp`（毫秒）。只解码不验签 —— 本地判过期用，签名由上游校验。 */
export function jwtExpiryMs(token) {
  if (typeof token !== "string") return 0;
  const parts = token.split(".");
  if (parts.length !== 3) return 0;
  try {
    const payload = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const claims = JSON.parse(payload);
    const exp = readNumber(claims?.exp);
    return exp && exp > 0 ? Math.round(exp * 1000) : 0;
  } catch {
    return 0;
  }
}

/** 版本号在 `data.value.version`（**嵌套对象**，不是 `data.value` 标量） */
export function versionFromUpdatePayload(payload) {
  const value = payload?.data?.value;
  if (!value || typeof value !== "object") return "";
  const version = value.version;
  if (typeof version === "string") return version.trim();
  if (typeof version === "number" && Number.isFinite(version)) return String(version);
  return "";
}

// ── 版本缓存（1h + 兜底常量；失败也缓存，避免每请求打第三方接口） ──
let versionCache = { value: "", at: 0 };
let versionInflight = null;

/** 同步取值：给 buildHeaders 这类同步入口用；绝不返回空串 */
export function clientVersionSnapshot() {
  return versionCache.value || LOBSTERAI_FALLBACK_CLIENT_VERSION;
}

async function fetchClientVersion() {
  try {
    const response = await fetch(LOBSTERAI_CLIENT_VERSION_API, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": LOBSTERAI_USER_AGENT },
      signal: AbortSignal.timeout(8 * 1000),
    });
    if (!response.ok) return "";
    const payload = await response.json();
    return versionFromUpdatePayload(payload);
  } catch {
    return "";
  }
}

/**
 * 解析当前客户端版本（异步；1h 缓存，失败退回常量）。
 * 并发调用共享同一次请求（in-flight 单飞）。
 */
export async function resolveClientVersion({ force = false } = {}) {
  const now = Date.now();
  if (!force && versionCache.value && now - versionCache.at < LOBSTERAI_VERSION_TTL_MS) {
    return versionCache.value;
  }
  if (versionInflight) return versionInflight;

  const task = (async () => {
    const resolved = await fetchClientVersion();
    versionCache = {
      value: resolved || LOBSTERAI_FALLBACK_CLIENT_VERSION,
      at: Date.now(),
    };
    return versionCache.value;
  })();

  versionInflight = task;
  try {
    return await task;
  } finally {
    if (versionInflight === task) versionInflight = null;
  }
}

/** 单测用：清掉模块级缓存 */
export function resetClientVersionCache() {
  versionCache = { value: "", at: 0 };
  versionInflight = null;
}

/**
 * keyfrom 载荷（`firstKeyfrom` / `latestKeyfrom` / `version` 恒在，
 * `uuid` / `userId` 非空才带；按 key 排序，与 Go 的 url.Values.Encode 同序）。
 * 续期请求体与目录 query 共用，**绝不含 refresh token**。
 */
export function keyfromFields(providerSpecificData, version) {
  const psd = providerSpecificData && typeof providerSpecificData === "object"
    ? providerSpecificData
    : {};
  const fields = [
    ["firstKeyfrom", String(psd.firstKeyfrom || "").trim()],
    ["latestKeyfrom", String(psd.latestKeyfrom || "").trim()],
    ["version", String(version || "").trim()],
  ];
  if (String(psd.uuid || "").trim()) fields.push(["uuid", String(psd.uuid).trim()]);
  if (String(psd.userId || "").trim()) fields.push(["userId", String(psd.userId).trim()]);
  return fields.sort((a, b) => a[0].localeCompare(b[0]));
}

/** 若 `text` 带 `code=...` 前缀则提取业务码（解析错误文案用） */
export function codeFromMessage(text) {
  const match = /code[=:]\s*(\d+)/i.exec(String(text || ""));
  return match ? Number(match[1]) : undefined;
}

export { LOBSTERAI_HARD_CREDIT_CODE };
