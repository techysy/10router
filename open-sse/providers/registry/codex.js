import { withCodexReviewModels } from "../models/helpers.js";

// Codex CLI version the backend sees in the Version / User-Agent identity headers.
// Single source: bump it here when the installed Codex CLI moves on.
// 上游 0.155 起：低于此版本的请求会被 OpenAI 限流拒绝（v0.5.95, ca6e8407）。
const CODEX_CLI_VERSION = "0.159.0";

const GPT_6_LITE_THINKING_LEVELS = ["low", "medium", "high", "xhigh", "max"];

export default {
  id: "codex",
  priority: 20,
  alias: "cx",
  uiAlias: "cx",
  display: {
    name: "OpenAI Codex",
    icon: "code",
    color: "#3B82F6",
    website: "https://chatgpt.com/codex",
    notice: {
      signupUrl: "https://chatgpt.com/codex",
    },
    deprecated: true,
    deprecationNotice: "RISK_NOTICE",
    kindNotice: {
      image: "Requires a ChatGPT Plus (or higher) account. Free accounts are not supported for image generation.",
    },
  },
  category: "oauth",
  thinkingConfig: {
    options: [
      "auto",
      "none",
      "low",
      "medium",
      "high",
    ],
    defaultMode: "auto",
  },
  transport: {
    baseUrl: "https://chatgpt.com/backend-api/codex/responses",
    format: "openai-responses",
    forceStream: true,
    cliVersion: CODEX_CLI_VERSION,
    headers: {
      originator: "codex_cli_rs",
      "User-Agent": `codex_cli_rs/${CODEX_CLI_VERSION}`,
    },
    usage: {
      url: "https://chatgpt.com/backend-api/wham/usage",
      resetCreditsUrl: "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
      resetCreditsConsumeUrl: "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
    },
  },
  models: [
    { id: "gpt-6-astra", name: "GPT 6.0 Astra" },
    // [1m] 长上下文变体（上游 v0.5.95, 9f41ee75）：同一上游模型，872k 窗口
    // （capabilities 的 CODEX_EXTENDED_CAPS），upstreamModelId 指向基础 id——
    // 请求被剥掉标记后按基础模型发出，变体 id 只用于账号 enabledModels 勾选
    // 与能力发布。
    { id: "gpt-6-astra[1m]", name: "GPT 6.0 Astra (extended context)", upstreamModelId: "gpt-6-astra" },
    // 6.0 lite pair + 6.1 (upstream v0.5.91/v0.5.104): Responses Lite transport,
    // five thinking levels (no "minimal"; codex-ultra maps to max).
    { id: "gpt-6.1-sol", name: "GPT 6.1 Sol", responsesLite: true, thinkingLevels: GPT_6_LITE_THINKING_LEVELS },
    { id: "gpt-6.1-terra", name: "GPT 6.1 Terra", responsesLite: true, thinkingLevels: GPT_6_LITE_THINKING_LEVELS },
    { id: "gpt-6-sol", name: "GPT 6.0 Sol", responsesLite: true, thinkingLevels: GPT_6_LITE_THINKING_LEVELS },
    { id: "gpt-6-sol[1m]", name: "GPT 6.0 Sol (extended context)", upstreamModelId: "gpt-6-sol", responsesLite: true, thinkingLevels: GPT_6_LITE_THINKING_LEVELS },
    { id: "gpt-6-luna", name: "GPT 6.0 Luna", responsesLite: true, thinkingLevels: GPT_6_LITE_THINKING_LEVELS },
    { id: "gpt-6-luna[1m]", name: "GPT 6.0 Luna (extended context)", upstreamModelId: "gpt-6-luna", responsesLite: true, thinkingLevels: GPT_6_LITE_THINKING_LEVELS },
    { id: "gpt-5.6-sol", name: "GPT 5.6 Sol" },
    { id: "gpt-5.6-sol[1m]", name: "GPT 5.6 Sol (extended context)", upstreamModelId: "gpt-5.6-sol" },
    { id: "gpt-5.6-sol-review", name: "GPT 5.6 Sol Review", upstreamModelId: "gpt-5.6-sol", quotaFamily: "review" },
    { id: "gpt-5.6-terra", name: "GPT 5.6 Terra" },
    { id: "gpt-5.6-terra[1m]", name: "GPT 5.6 Terra (extended context)", upstreamModelId: "gpt-5.6-terra" },
    { id: "gpt-5.6-terra-review", name: "GPT 5.6 Terra Review", upstreamModelId: "gpt-5.6-terra", quotaFamily: "review" },
    { id: "gpt-5.6-luna", name: "GPT 5.6 Luna" },
    { id: "gpt-5.6-luna[1m]", name: "GPT 5.6 Luna (extended context)", upstreamModelId: "gpt-5.6-luna" },
    { id: "gpt-5.6-luna-review", name: "GPT 5.6 Luna Review", upstreamModelId: "gpt-5.6-luna", quotaFamily: "review" },
    // gpt-5.5 / gpt-5.5-review removed: absent from backend-api/codex/models for
    // ChatGPT accounts and return HTTP 400 (#4202, #4848, 上游 7878f53b).
    // gpt-5.4 / gpt-5.4-mini / gpt-5.3-codex-spark 已移除：不在 backend-api/codex/models 里，
    // 后端一律 400 "model is not supported"（上游 v0.5.95, 8f9ff44f）。
    // gpt-daybreak-blue-latest / gpt-reserve 已由 backend-api/codex/models 确认在线。
    { id: "gpt-daybreak-blue-latest", name: "GPT Daybreak Blue" },
    { id: "gpt-reserve", name: "GPT Reserve" },
    { id: "gpt-image-2.5", name: "GPT Image 2.5", capabilities: ["text2img","edit","multiImage"], params: ["size","quality","background","image_detail","output_format"], kind: "image" },
    { id: "gpt-image-2.5-flare", name: "GPT Image 2.5 Flare", capabilities: ["text2img","edit","multiImage"], params: ["size","quality","background","image_detail","output_format"], kind: "image" },
    { id: "gpt-image-2.5-sunburst", name: "GPT Image 2.5 Sunburst", capabilities: ["text2img","edit","multiImage"], params: ["size","quality","background","image_detail","output_format"], kind: "image" },
    { id: "gpt-image-2", name: "GPT Image 2", capabilities: ["text2img","edit","multiImage"], params: ["size","quality","background","image_detail","output_format"], kind: "image" },
    { id: "gpt-image-1.5", name: "GPT Image 1.5", capabilities: ["text2img","edit","multiImage"], params: ["size","quality","background","image_detail","output_format"], kind: "image" },
    { id: "gpt-6-sol-image", name: "GPT 6.0 Sol Image", capabilities: ["text2img","edit"], params: ["size","quality","background","image_detail","output_format"], kind: "image" },
    // gpt-5.5-image removed alongside gpt-5.5 (dead on the backend).
    // gpt-5.4-image 随 gpt-5.4 一并移除（后端同样已下线）。

  ],
  serviceKinds: ["llm","image"],
  oauth: {
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    scope: "openid profile email offline_access",
    codeChallengeMethod: "S256",
    fixedPort: 1455,
    callbackPath: "/auth/callback",
    extraParams: {
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: "codex_cli_rs",
    },
    // 访问令牌寿命约 1 小时；5 天的 lead 会让每次调用都轮换 refresh token，
    // 而旧 refresh token 一旦被复用，OpenAI 会吊销整个 session（账号被登出）。
    // 因此只在临近真实过期前刷新（10 分钟）——上游 v0.5.95, 0bc7f86e。
    refreshLeadMs: 600000,
    refresh: {
      encoding: "form",
      scope: "openid profile email offline_access",
    },
    maxRefreshAgeMs: 691200000,
    trackRefreshAt: true,
  },
  features: {
    usage: true,
  },
};
