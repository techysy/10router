// CodeBuddy international (codebuddy.ai) — mirrors codebuddy-cn registry shape,
// swapping the Tencent CN domain for the .ai endpoint set. All OAuth/plugin URLs
// use the /v2/plugin prefix with platform=ide (CN uses platform=CLI).
export default {
  id: "codebuddy-intl",
  alias: "cbai",
  uiAlias: "cbai",
  hidden: false,
  priority: 90,
  display: {
    name: "CodeBuddy",
    icon: "smart_toy",
    color: "#006EFF",
    website: "https://www.codebuddy.ai",
    notice: {
      signupUrl: "https://www.codebuddy.ai",
      // 网页版 = 在线 agent 页面(/agents);积分/用量控制台仍在 signupUrl。
      webUrl: "https://www.codebuddy.ai/agents",
    },
  },
  category: "oauth",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  transport: {
    // Chat gateway is OpenAI-compatible SSE (same /v2/chat/completions path as CN).
    baseUrl: "https://www.codebuddy.ai/v2/chat/completions",
    forceStream: true,
    // CodeBuddy intl speaks the same unified OpenAI reasoning_effort shape as CN.
    thinkingFormat: "openai",
    headers: {
      // 2026-11-05 对齐官方 CLI 2.180.0（与 CN 侧同一份包）：版本信息改走
      // X-IDE-Version / X-Client-Version / X-Product-Version 独立头，旧 UA
      // 过渡期双发（同 CN 侧注释）。
      "User-Agent": "IDE/2.180.0 CodeBuddy/2.180.0",
      "X-Product": "SaaS",
      "X-IDE-Type": "IDE",
      "X-IDE-Name": "IDE",
      "X-IDE-Version": "2.180.0",
      "X-Client-Version": "2.180.0",
      "X-Product-Version": "2.180.0",
      "x-requested-with": "XMLHttpRequest",
      "x-codebuddy-request": "1",
    },
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
    },
    // Intl billing endpoint mirrors CN shape (data.Response.Data.Accounts[]).
    usage: {
      url: "https://www.codebuddy.ai/v2/billing/meter/get-user-resource",
    },
  },
  // The intl gateway publishes no model-catalog endpoint, so this list is
  // static. Two rules keep it honest:
  //  (1) a model is only advertised after the live gateway answers it with a
  //      real request. The gateway is an OpenAI passthrough, so an unlisted id
  //      can be probed straight through it; ids the service rejects with 11102
  //      ("model service info not found") are never listed here.
  //  (2) rateMultiplier is read off the CN credit page: CN and intl share one
  //      credit system, so a model present on both carries an identical
  //      multiplier (holds for every currently overlapping id).
  //      Re-confirmed against the intl credit page itself on 2026-10-09:
  //      gpt-5.6-terra 1.39 / gpt-5.6-luna 0.14 / gpt-5.5 3.31 / gpt-5.4 1.65 /
  //      gpt-5.3-codex 1.25 / gemini-3.5-flash 0.99 / glm-5.3 0.79 / glm-5.2 0.79 /
  //      kimi-k3 1.62 / kimi-k2.6 0.52 — all ten matched what CN had published.
  //
  //      That page is NOT a complete catalog for a given account: it is filtered
  //      by subscription tier, so a free account never sees the newer models
  //      (2026-10-09: Space-Bunny / Grok-4.7 / Gemini-3.8-Flash / GPT-6.1-Sol /
  //      Kimi-K2.8-Preview all absent from it) even though the API answers 200
  //      for every one of them on that same account. Absence there is therefore
  //      not evidence a model is gone — do not retire a row on it (kimi-k2.7 was
  //      briefly dropped for exactly that reason, and answers 200).
  //
  //      The page does list five agent presets the models do not cover: Auto
  //      0.79 / Fast 0.34 / Balanced 0.59 / Primary 3.31 / Deep 3.33. They are
  //      not model ids — Fast/Balanced/Primary/Deep answer 11102 across 20
  //      spellings (title case, auto-xxx, xxx-mode, cb-xxx), so the chat app
  //      resolves them before sending. `auto` IS a real gateway id (it answers
  //      200 and echoes the model it picked) but is deliberately not advertised:
  //      five probe prompts all landed on glm-5.2, and a router whose target can
  //      move has no stable capability row or stable credit cost to record.
  //  (3) no multiplier here is a guess any more. gpt-6-astra was the one
  //      exception: v1.1.0 shipped 17.35, derived by ratio from the OpenCode Go
  //      price table, and that estimate is now superseded by the measured 6.67
  //      — see the note on that row.
  // Kept out on purpose even though a probe answers 200: kimi-k2.5 (absent from
  // the published credit list — the CN catalog drops it for the same reason).
  // Re-probed 2026-09-30, still 11102: deepseek-v4-pro / deepseek-v4-flash,
  // kimi-k2-thinking, glm-4.6 / glm-4.5, gpt-5.2 / gpt-5.1 / gpt-5.6,
  // gemini-3.5-pro / gemini-3-flash, deepseek-v3.2, qwen3-max,
  // claude-sonnet-4.5, hy4. glm-5.3-flash LEFT that list — the same re-probe
  // saw it answer 200, so it is advertised below now.
  // A listed model may still fail for one account (gemini-3.5-flash answers the
  // live 429 / code 14003 "too many requests" on a rate-limited account) — that
  // is an account/quota state, not a catalog error, so it stays advertised.
  // Same rule for gpt-6-astra, which answers 11134 "the model provider is
  // temporarily unavailable, please retry later or switch" (HTTP 500) while the
  // very same id has answered 200 — an upstream availability flap, not a catalog
  // error. Only 11102 ("model service info not found") means the id is wrong.
  // Error-code reference: docs/zh-CN/codebuddy-cn-error-codes.md.
  // 2026-11-05（第三版）：用户从 WorkBuddy 国际版客户端取得**带徽章**的完整
  // 清单，取代同日早先那版无徽章的网页版截图。与前两版的关键差异：
  //   · GPT-6 家族回归且首次公布倍率（6.1-Sol 1.33 / 6-Sol 1.33 / 6-Luna 0.07，
  //     Astra 仍是实测 6.67）；5.5 / 5.4 / 5.3-Codex / Gemini-3.5-Flash / GLM-5.2 /
  //     Kimi-K2.6 消失；GLM-5.3 与 CN 同步降到 0.69；glm-5.3-flash 0.08 回归；
  //     新增 Kimi-K3.1-Pro(0.97) 与 -Highspeed(1.56，id 拼写按命名惯例推断，
  //     ⚠️ 待凭据恢复后现网复核)、MiniMax-M3.1-Flash(0.08)、DeepSeek-V4.1-Flash(0.11)。
  //   · 徽章三类：Free now（Hy4 11月4-15 / Hy3 7月6-11月15，每日赠送免费额度，
  //     订阅用户更高额度）、Pro Only（模型仅向 Pro 用户开放）、无徽章（人人可用）。
  models: [
    { id: "auto", name: "自动", rateMultiplier: 0.15 },
    // 「Free now」= 限时免费窗口（每日赠送额度，非无限量）。
    { id: "hy4-preview", name: "Hy4", rateMultiplier: 0, promoFreeUntil: "2026-11-15T00:00:00+08:00", promoFreeNote: "Nov 4-15 每日赠送免费额度，订阅用户更高额度" },
    { id: "hy3", name: "Hy3", rateMultiplier: 0, promoFreeUntil: "2026-11-15T00:00:00+08:00", promoFreeNote: "Jul 6–Nov 15 每日赠送免费额度，订阅用户更高额度" },
    { id: "deepseek-v4.1-flash", name: "Deepseek-V4.1-Flash", rateMultiplier: 0.11 },
    // 「Pro Only」= 模型仅向 Pro 订阅开放，免费账号请求会被拒。
    { id: "gpt-6-astra", name: "GPT-6-Astra", rateMultiplier: 6.67, proOnly: true },
    { id: "gpt-6.1-sol", name: "GPT-6.1-Sol", rateMultiplier: 1.33, proOnly: true },
    { id: "gpt-6-sol", name: "GPT-6-Sol", rateMultiplier: 1.33, proOnly: true },
    { id: "gpt-6-luna", name: "GPT-6-Luna", rateMultiplier: 0.07, proOnly: true },
    { id: "gpt-5.6-sol", name: "GPT-5.6-Sol", rateMultiplier: 3.47, proOnly: true },
    { id: "gpt-5.6-terra", name: "GPT-5.6-Terra", rateMultiplier: 1.39, proOnly: true },
    { id: "gpt-5.6-luna", name: "GPT-5.6-Luna", rateMultiplier: 0.14, proOnly: true },
    { id: "grok-4.7", name: "Grok-4.7", rateMultiplier: 1.90, proOnly: true },
    { id: "gemini-3.8-flash", name: "Gemini-3.8-Flash", rateMultiplier: 0.95, proOnly: true },
    { id: "glm-5.3", name: "GLM-5.3", rateMultiplier: 0.69 },
    { id: "glm-5.3-flash", name: "GLM-5.3-Flash", rateMultiplier: 0.08 },
    { id: "kimi-k3.1-pro", name: "Kimi-K3.1-Pro", rateMultiplier: 0.97, proOnly: true },
    // 完整拼写由客户端 tooltip 印证（Kimi-K3.1-Pro-Highspeed，卡面 1.56x/300K）。
    // ⚠️ 可达性未验证：无 Pro 账号，全部 proOnly 行都只在客户端可见、未经
    // 现网请求确认（与当年 Claude paidTier 行同一处境）——免费账号请求预期被拒。
    { id: "kimi-k3.1-pro-highspeed", name: "Kimi-K3.1-Pro-Highspeed", rateMultiplier: 1.56, proOnly: true },
    { id: "kimi-k3", name: "Kimi-K3", rateMultiplier: 1.62 },
    { id: "minimax-m3.1-flash", name: "MiniMax-M3.1-Flash", rateMultiplier: 0.08 },
  ],
  // 预设档（自动/快速/均衡/优选）不是模型 id —— 11102 across 20 spellings，
  // 聊天应用发送前自行解析；倍率随档位浮动（本版 Auto 已从 0.79 变 0.15），
  // 不建目录行。
  presets: [
    { id: "auto", label: "自动", rateMultiplier: 0.15 },
    { id: "fast", label: "快速", rateMultiplier: 0.34 },
    { id: "balanced", label: "均衡", rateMultiplier: 0.59 },
    { id: "primary", label: "优选", rateMultiplier: 3.31 },
  ],
  oauth: {
    baseUrl: "https://www.codebuddy.ai",
    stateUrl: "https://www.codebuddy.ai/v2/plugin/auth/state",
    tokenUrl: "https://www.codebuddy.ai/v2/plugin/auth/token",
    refreshUrl: "https://www.codebuddy.ai/v2/plugin/auth/token/refresh",
    // OAuth 轮询的 UA 与 transport 同步升到 2.180.0。
    userAgent: "IDE/2.180.0 CodeBuddy/2.180.0",
    platform: "ide",
    pollInterval: 5000,
  },
  features: {
    usage: true,
    usageApikey: true,
  },
};
