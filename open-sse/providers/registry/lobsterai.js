// LobsterAI（网易有道「有道龙虾」）— OpenAI 兼容但只收 SSE 的 oauth provider。
//
// 关键点（细节见 open-sse/executors/lobsterai.js 与 shared/lobsterai/）：
//   - 上游 `stream:false` 直接 500 ⇒ transport.forceStream 让会话层恒以流式
//     请求，非流式客户端由 10Router 本地聚合（chatCore 的 forced-SSE-to-JSON）。
//   - 模型目录是参考实现（MIT lobsterai2api / 我们的 Rust provider）的 19 条
//     静态清单；远程 `/api/models/available` 会按能力头返回更多（含 kimi-k3），
//     这里只广告静态兜底里经过验证的那一批。
//   - 登录是「门户授权 → 本机 loopback 回调 → /api/auth/exchange」；回调端口
//     由调用方给定（fixedPort: 0 = 动态端口），见 src/lib/oauth/providers/lobsterai.js。
import {
  LOBSTERAI_CHAT_URL,
  LOBSTERAI_EXCHANGE_URL,
  LOBSTERAI_PORTAL_BASE,
  LOBSTERAI_REFRESH_URL,
  LOBSTERAI_USER_AGENT,
} from "../../shared/lobsterai/constants.js";

export default {
  id: "lobsterai",
  alias: "lobster",
  aliases: ["lobster-ai", "youdao-lobster"],
  uiAlias: "lobster",
  display: {
    name: "LobsterAI",
    icon: "pets",
    color: "#F97316",
    textIcon: "LA",
    website: LOBSTERAI_PORTAL_BASE,
    notice: {
      signupUrl: LOBSTERAI_PORTAL_BASE,
    },
  },
  category: "oauth",
  authModes: ["oauth"],
  hasOAuth: true,
  features: { usage: true },
  transport: {
    baseUrl: LOBSTERAI_CHAT_URL,
    format: "openai",
    // 上游只收 SSE；非流式由会话层聚合回 JSON。
    forceStream: true,
    timeoutMs: 180000,
    headers: {
      "User-Agent": LOBSTERAI_USER_AGENT,
    },
  },
  oauth: {
    authorizeUrl: `${LOBSTERAI_PORTAL_BASE}/portal#/login`,
    tokenUrl: LOBSTERAI_EXCHANGE_URL,
    refreshUrl: LOBSTERAI_REFRESH_URL,
    // loopback 回调路径跟随参考实现的裸 `/auth/callback`；端口 0 = 由调用方
    // 绑定动态端口（门户会把 redirect_uri 原样回落）。
    callbackPath: "/auth/callback",
    fixedPort: 0,
    // 续期是 JSON 体 + 自定义载荷件（uuid / keyfrom），由 executor 的
    // refreshCredentials 与 tokenRefresh 的专用 handler 实现。
    refresh: { encoding: "json" },
    refreshLeadMs: 60 * 60 * 1000,
  },
  models: [
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "MiniMax-M3", name: "MiniMax M3" },
    { id: "MiniMax-M2.7", name: "MiniMax M2.7" },
    { id: "qwen3.7-max", name: "Qwen3.7 Max" },
    { id: "qwen3.7-plus", name: "Qwen3.7 Plus" },
    { id: "qwen3.6-plus", name: "Qwen3.6 Plus" },
    { id: "qwen3.5-plus-2026-04-20", name: "Qwen3.5 Plus (2026-04-20)" },
    { id: "kimi-k2.7-code", name: "Kimi K2.7 Code" },
    { id: "kimi-k2.7-code-highspeed", name: "Kimi K2.7 Code Highspeed" },
    { id: "kimi-k2.6", name: "Kimi K2.6" },
    { id: "kimi-k2.5", name: "Kimi K2.5" },
    { id: "doubao-seed-2-1-pro-260628", name: "Doubao Seed 2.1 Pro" },
    { id: "doubao-seed-2-1-turbo-260628", name: "Doubao Seed 2.1 Turbo" },
    { id: "doubao-seed-2-0-code-preview-260215", name: "Doubao Seed 2.0 Code Preview" },
    { id: "glm-5.2", name: "GLM-5.2" },
    { id: "glm-5.1", name: "GLM-5.1" },
    { id: "glm-5v-turbo", name: "GLM-5V Turbo" },
    { id: "glm-5", name: "GLM-5" },
  ],
};
