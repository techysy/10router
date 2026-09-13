export default {
  id: "codebuddy-cn",
  // Short model prefix (cbcn/glm-5.2). "cbcn" = CodeBuddy CN; reserve "cbai"
  // for a future codebuddy-ai (intl) provider. The full id still resolves.
  alias: "cbcn",
  uiAlias: "cbcn",
  hidden: false,
  priority: 90,
  display: {
    name: "CodeBuddy CN",
    icon: "smart_toy",
    color: "#006EFF",
    website: "https://copilot.tencent.com",
    notice: {
      signupUrl: "https://copilot.tencent.com",
      // 网页版 = 在线 agent 页面(WorkBuddy 工作台);积分/用量控制台仍在
      // signupUrl(copilot.tencent.com)——provider 页右上角按钮指向 webUrl,
      // 替代默认的 "Get API Key"(该渠道的密钥本来就不走自动认证引导)。
      webUrl: "https://www.workbuddy.cn/app",
    },
  },
  category: "oauth",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  transport: {
    baseUrl: "https://copilot.tencent.com/v2/chat/completions",
    forceStream: true,
    // CodeBuddy is a unified OpenAI-compatible gateway: every model (GLM, Kimi,
    // MiniMax, DeepSeek, Hunyuan) takes reasoning via OpenAI-style reasoning_effort,
    // not its vendor-native thinking shape. Force the openai thinking format.
    thinkingFormat: "openai",
    headers: {
      "User-Agent": "CLI/2.108.1 CodeBuddy/2.108.1",
      "X-Product": "SaaS",
      "X-IDE-Type": "CLI",
      "X-IDE-Name": "CLI",
      "x-requested-with": "XMLHttpRequest",
      "x-codebuddy-request": "1",
    },
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
    },
    // Quota endpoint differs from the chat gateway: POST returns nested Tencent
    // billing payload (data.Response.Data.Accounts[]). See services/usage/codebuddy-cn.js.
    usage: {
      url: "https://copilot.tencent.com/v2/billing/meter/get-user-resource",
    },
  },
  // Catalog mirrors the model/credit list published on copilot.tencent.com.
  // Models the server no longer lists are removed even when the chat endpoint
  // still answers them — the published list is the contract. Drop log:
  // glm-5.0 / glm-4.7 and hy4-preview-x (endpoint returns 11102 "model service
  // info not found", see docs/zh-CN/codebuddy-cn-error-codes.md), plus
  // glm-5.0-turbo / minimax-m2.7 / kimi-k2.5 / hy3-preview / deepseek-v3-2-volc
  // (absent from the server list, though still answering 200), hy3-x (paid
  // tier, not used here), kimi-k3-1 (spurious duplicate slot — the server lists
  // only kimi-k3) and deepseek-v4-flash (superseded by deepseek-v4.1-flash).
  // "-x" suffix = paid tier of the same model (free id rides the promo quota).
  // rateMultiplier = credit cost multiplier published on the CN credit page
  // (0 = rides the free quota). CN and intl share one credit system, so models
  // present on both carry identical multipliers. Rendered as a badge by ModelRow.
  models: [
    // CN hy4-preview: free quota is NIGHT-ONLY (23:00–08:00 local, user-verified
    // 2026-09-13) — intl's hy4-preview is free ALL DAY, the two are different.
    // Daytime multiplier is unpublished: nightFree makes the badge show "free"
    // inside the window and nothing outside it (no misleading 0x all day).
    { id: "hy4-preview", name: "Hy4-Preview", nightFree: { from: 23, to: 8 } },
    { id: "hy3", name: "Hy3", rateMultiplier: 0 },
    { id: "glm-5v-turbo", name: "GLM-5v-Turbo", rateMultiplier: 0.71 },
    { id: "glm-5.3", name: "GLM-5.3", rateMultiplier: 0.79 },
    { id: "glm-5.3-flash", name: "GLM-5.3-Flash", rateMultiplier: 0.06 },
    { id: "glm-5.2", name: "GLM-5.2", rateMultiplier: 0.79 },
    { id: "glm-5.1", name: "GLM-5.1", rateMultiplier: 0.79 },
    { id: "minimax-m3", name: "MiniMax-M3", rateMultiplier: 0.25 },
    { id: "kimi-k3", name: "Kimi-K3", rateMultiplier: 1.62 },
    { id: "kimi-k2.7", name: "Kimi-K2.7-Code", rateMultiplier: 0.57 },
    { id: "kimi-k2.6", name: "Kimi-K2.6", rateMultiplier: 0.52 },
    { id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash", rateMultiplier: 0.03 },
    { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", rateMultiplier: 0.51 },
    // NOTE: the GPT/Gemini family (gpt-5.6-sol/terra/luna, gpt-5.5, gpt-5.4,
    // gpt-5.3-codex, gemini-3.5-flash) belongs to CodeBuddy *international*
    // (codebuddy.ai) ONLY — copilot.tencent.com never published them, and the
    // CN capabilities map below has no entry for them either. Do not re-add
    // them here; they live in registry/codebuddy-intl.js.
  ],
  oauth: {
    baseUrl: "https://copilot.tencent.com",
    stateUrl: "https://copilot.tencent.com/v2/plugin/auth/state",
    tokenUrl: "https://copilot.tencent.com/v2/plugin/auth/token",
    refreshUrl: "https://copilot.tencent.com/v2/plugin/auth/token/refresh",
    userAgent: "CLI/2.63.2 CodeBuddy/2.63.2",
    platform: "CLI",
    pollInterval: 5000,
  },
  features: {
    usage: true,
    usageApikey: true,
  },
};
