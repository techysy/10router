// LobsterAI（网易有道龙虾）上游常量。
//
// ── 两个域都在有道名下，但用途分开 ─────────────────────────────
//   portal  https://lobsterai.youdao.com         浏览器授权页（手机号 / 微信）
//   api     https://lobsterai-server.youdao.com  换码 / 续期 / 目录 / 对话 / 积分 / 活动
//
// 对话端点是 OpenAI 兼容协议，但**只收 SSE**：`stream:false` 上游直接回
// HTTP 500（Rust endpoints/chat 模块头实测）。两个 `X-LobsterAI-Client-*`
// 头是功能性的：能力位决定目录里有没有 kimi-k3，版本头缺了会被当成不认识的
// 客户端（实测直接 500），所以本模块把它们集中在一处，executor / 签到 / 登录
// 三条链路共用，避免任何一处发空版本头。

const trimBase = (value) => String(value || "").trim().replace(/\/+$/, "");

/** API 主机（换码 / 续期 / 目录 / 对话 / 积分 / 活动都在它下面） */
export const LOBSTERAI_API_BASE =
  trimBase(process.env.LOBSTERAI_API_BASE) || "https://lobsterai-server.youdao.com";

/** 浏览器登录门户主机 */
export const LOBSTERAI_PORTAL_BASE =
  trimBase(process.env.LOBSTERAI_PORTAL_BASE) || "https://lobsterai.youdao.com";

/** 客户端版本查询接口（第三方主机；响应不是业务信封，版本在 data.value.version） */
export const LOBSTERAI_CLIENT_VERSION_API =
  "https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/update";

/** 查不到版本时的兜底值（缺版本头会被上游按「不认识的客户端」对待） */
export const LOBSTERAI_FALLBACK_CLIENT_VERSION = "2026.9.4";

/** `User-Agent` 固定不跟随真实版本；动态版本只由 `X-LobsterAI-Client-Version` 承载 */
export const LOBSTERAI_USER_AGENT = "LobsterAI/0.1.0";

/** 功能头：缺它目录里少 kimi-k3（25 vs 26），也是 agentic 请求的准入位 */
export const LOBSTERAI_CLIENT_CAPABILITIES = "kimi-k3-agentic-v1";

export const LOBSTERAI_PATHS = {
  exchange: "/api/auth/exchange",
  refresh: "/api/auth/refresh",
  models: "/api/models/available",
  chat: "/api/proxy/v1/chat/completions",
  profileSummary: "/api/user/profile-summary",
  activitySlot: "/api/client-activities/slot",
  activityContext: "/api/client-activities",
};

/** 对话端点完整 URL（registry transport 与 executor 共用） */
export const LOBSTERAI_CHAT_URL = `${LOBSTERAI_API_BASE}${LOBSTERAI_PATHS.chat}`;

/** 积分余额端点 */
export const LOBSTERAI_PROFILE_SUMMARY_URL =
  `${LOBSTERAI_API_BASE}${LOBSTERAI_PATHS.profileSummary}`;

/** 换码 / 续期端点 */
export const LOBSTERAI_EXCHANGE_URL = `${LOBSTERAI_API_BASE}${LOBSTERAI_PATHS.exchange}`;
export const LOBSTERAI_REFRESH_URL = `${LOBSTERAI_API_BASE}${LOBSTERAI_PATHS.refresh}`;

/** 活动位查询的三个固定参数（照抄桌面客户端形态，与宿主系统无关） */
export const LOBSTERAI_SLOT = {
  placement: "desktop_sidebar",
  containerApiVersion: "2",
  platform: "win32",
};

/** 活动上下文里表示「今天可签」的动作名 */
export const LOBSTERAI_CHECK_IN_ACTION = "check_in";

/** 版本缓存时长：1 小时（任务规格；Rust 取 12h，实现按 1h 更保守） */
export const LOBSTERAI_VERSION_TTL_MS = 60 * 60 * 1000;

/** 控制面 / 签到请求超时（毫秒） */
export const LOBSTERAI_REQUEST_TIMEOUT_MS = 30 * 1000;

/** 首帧 SSE 窥探窗口：错误帧总在流首（参考实现实测 < 200 字节） */
export const LOBSTERAI_SSE_PEEK_MAX_BYTES = 8 * 1024;

// ── 200 假成功 marker 表 ────────────────────────────────────────
// 上游会把余额耗尽藏在 HTTP 200 的 `event:error` 帧里。marker 表照抄参考
// 实现（MIT lobsterai2api `internal/upstream/classify.go`）并补上 Rust 版
// 的两条真实文案（「额度已用完」「升级套餐」—— 漏判会让用完的账号一直不换）。
// 中英双通道：英文走小写比对，中文走原文比对。
export const LOBSTERAI_HARD_CREDIT_MARKERS = [
  "insufficient credit",
  "no credit",
  "credit exhausted",
  "out of credit",
  "quota exceeded",
  "quota exhaust",
  "payment required",
  "credit not enough",
  "not enough credit",
  "freecreditsused",
  "free credits used",
  "free quota",
  "quota used up",
  "upgrade your plan",
  "upgrade to continue",
  // 200 流内错误帧（code 40201）的实测原文
  "\"code\":40201",
  "\"code\": 40201",
  // 中文实际文案：免费额度已用完 / 请升级套餐
  "积分不足",
  "额度不足",
  "余额不足",
  "积分用完",
  "额度用尽",
  "没有积分",
  "积分耗尽",
  "额度已用完",
  "免费额度",
  "升级套餐",
];

/** 会话已死 marker（40100 / 40101 是刷新被拒的业务码，终态） */
export const LOBSTERAI_SESSION_DEAD_MARKERS = [
  "40100",
  "40101",
  "token rejected",
  "refresh token was rejected",
];

/** 40201：余额耗尽业务码（200 假成功的核心判据） */
export const LOBSTERAI_HARD_CREDIT_CODE = 40201;
export const LOBSTERAI_SESSION_DEAD_CODES = [40100, 40101];

/** 签到/余额接口里「已签到」的文案特征（中性结果，不算失败） */
export const LOBSTERAI_ALREADY_CHECKED_IN_MARKERS = [
  "已签到",
  "已经签到",
  "今日已领取",
  "already checked",
  "already claimed",
  "claimed today",
  "duplicate",
];
