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
    quirks: {
      // Root-level tool `parameters` must be a concrete type:"object"; the
      // upstream answers 400 {code:11129 "invalid function call parameters"}
      // for a root anyOf/oneOf/allOf/$ref/type-array/missing-type. chatCore
      // downgrades tool schemas for providers declaring this quirk. See
      // translator/concerns/toolCall.js and issue #27.
      sanitizeToolSchema: true,
    },
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
    // Daytime multiplier 0.29x (user-provided); the badge shows "free" inside
    // the window and 0.29x outside it.
    { id: "hy4-preview", name: "Hy4-Preview", rateMultiplier: 0.29, nightFree: { from: 23, to: 8 } },
    { id: "hy3", name: "Hy3", rateMultiplier: 0 },
    // Space-Bunny：2026-10-02 官方应用（WorkBuddy 工作台）上架的"匿名大模型"，
    // 原生多模态输入、1M 上下文、编码向。0.03x 为 10/2–10/7 限时折扣价，窗口
    // 结束后按官方积分页回填正式倍率（deepseek-v4.1-flash 同期从 0.03 回调到
    // 0.11 的先例说明这类新模型首周价会动）。
    { id: "space-bunny", name: "Space-Bunny", rateMultiplier: 0.08 },
    { id: "glm-5v-turbo", name: "GLM-5v-Turbo", rateMultiplier: 0.71 },
    { id: "glm-5.3", name: "GLM-5.3", rateMultiplier: 0.79 },
    { id: "glm-5.3-flash", name: "GLM-5.3-Flash", rateMultiplier: 0.06 },
    // 2026-10-08 现网探测：glm-5.3-flashx 答 200（注意 x 前无连字符，glm-5.3-flash-x
    // 才是 11102）。0.14x 为 2026-10-09 积分页回填——它比同族的 glm-5.3-flash(0.06)
    // 贵一倍以上，"-x = 付费档"在这条线上是成立的。**只属于 CN**：国际线虽有同名
    // 服务条目，但该 id 在那边每个请求都被 11133 拒（model_param_invalid），故
    // codebuddy-intl.js 不收。
    { id: "glm-5.3-flashx", name: "GLM-5.3-FlashX", rateMultiplier: 0.14 },
    { id: "glm-5.2", name: "GLM-5.2", rateMultiplier: 0.79 },
    { id: "glm-5.1", name: "GLM-5.1", rateMultiplier: 0.79 },
    { id: "minimax-m3", name: "MiniMax-M3", rateMultiplier: 0.25 },
    // 2026-10-08 现网探测补一个：minimax-m2.7 返回 200 且回显自身 id（不是 M3 的
    // 别名）；hy5-preview / glm-5.4 / kimi-k2.7-code / muse-spark-1.3 回 11102。
    // deepseek-v4-flash 上游也答 200，但它已被 deepseek-v4.1-flash 取代，
    // 不重复进选择器（见 unit/codebuddy-cn-models.test.js 的 retired-ids 用例）。
    { id: "minimax-m2.7", name: "MiniMax-M2.7" },
    { id: "kimi-k3", name: "Kimi-K3", rateMultiplier: 1.62 },
    { id: "kimi-k2.7", name: "Kimi-K2.7-Code", rateMultiplier: 0.57 },
    // 2026-10-08 积分页列出 Kimi-K2.8-Preview 0.77x，现网探测答 200（kimi-k2.8
    // 与 kimi-k2-8-preview 都是 11102，id 带 .8-preview）。国际线同样有该 id。
    { id: "kimi-k2.8-preview", name: "Kimi-K2.8-Preview", rateMultiplier: 0.77 },
    { id: "kimi-k2.6", name: "Kimi-K2.6", rateMultiplier: 0.52 },
    // 官方积分页 2026-10-02 已将此模型回调至 0.11x（曾为首周 0.03x 尝鲜价）。
    // StepFun 的 Step-5-Preview,2026-10-09 积分页 0.43x + "订阅优先"标签,
    // 上下文 UI 可选 300/600/1M。⚠️ 本机免费账号探测:step-5-preview /
    // step5-preview / step-5 / step5 / stepfun-5-preview / Step-5-Preview(UI 原样)/
    // step-5-preview-x 等 17 种写法**全部回 11102**,与瞎编的对照 id 同判定(同批
    // glm-5.3 / deepseek-v4.1-flash 回 200,判定器正常)。按账号档位差异收录——
    // 与 intl 的 Claude 线同一判断,同样未经本账号验证。
    { id: "step-5-preview", name: "Step-5-Preview", rateMultiplier: 0.43, subPriority: true },
    { id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash", rateMultiplier: 0.11 },
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
