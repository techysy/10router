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
      "User-Agent": "IDE/2.108.1 CodeBuddy/2.108.1",
      "X-Product": "SaaS",
      "X-IDE-Type": "IDE",
      "X-IDE-Name": "IDE",
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
  models: [
    { id: "hy4-preview", name: "Hy4-Preview", rateMultiplier: 0 },
    { id: "hy3", name: "Hy3", rateMultiplier: 0 },
    // The GPT-6 ids this gateway answers (live-probed 2026-09-30): astra plus
    // the 6.0 sol/luna pair below. Still 11102: bare gpt-6, gpt-6.0,
    // gpt-6-astra-review|-thinking|-mini|-pro|-high|-codex, gpt-6.1-astra,
    // gpt-6.1-sol, gpt-6.1-luna, gpt-6.5-astra and gpt-5.6-astra.
    //
    // Its multiplier is the measured 6.67. v1.1.0 shipped 17.35, which was an
    // ESTIMATE: no CodeBuddy credit figure for this id was reachable in the
    // repo, in ~/.codebuddy, or on codebuddy.ai (the pricing page is an app
    // shell with no data), so it was derived by ratio from the OpenCode Go
    // price table, where Astra sits at exactly 5x Sol on all four columns
    // (input / output / cache-read / cache-write) and in both the <=272K and
    // >272K tiers, and Sol carries a published 3.47 right below (3.47 x 5 =
    // 17.35). The real credit system does not follow that ratio, so the
    // estimate is dead — and so is the method: do not infer a multiplier for
    // this provider from an external price table again (see the gpt-5.4 /
    // gpt-5.5 rows of open-sse/providers/pricing.js, which share one price but
    // differ 2x in credits).
    { id: "gpt-6-astra", name: "GPT 6.0 Astra", rateMultiplier: 6.67 },
    // gpt-6-sol / gpt-6-luna answered 200 on the 2026-09-30 probe (the OpenAI
    // 6.0 rollout reached this gateway). Both are intl-only — CN answers
    // 11102 — so the shared-credit-system rule has no CN row to inherit from,
    // and rule (3) forbids deriving one from the 5.6 rates: they ship with NO
    // rateMultiplier until the credit page publishes a real number.
    { id: "gpt-6-luna", name: "GPT-6-Luna" },
    { id: "gpt-6-sol", name: "GPT-6-Sol" },
    { id: "gpt-5.6-sol", name: "GPT-5.6-Sol", rateMultiplier: 3.47 },
    { id: "gpt-5.6-terra", name: "GPT-5.6-Terra", rateMultiplier: 1.39 },
    { id: "gpt-5.6-luna", name: "GPT-5.6-Luna", rateMultiplier: 0.14 },
    { id: "gpt-5.5", name: "GPT-5.5", rateMultiplier: 3.31 },
    { id: "gpt-5.4", name: "GPT-5.4", rateMultiplier: 1.65 },
    { id: "gpt-5.3-codex", name: "GPT-5.3-Codex", rateMultiplier: 1.25 },
    // 2026-10-08 现网探测：gpt-6.1-sol / gemini-3.8-flash / grok-4.7 / space-bunny
    // 均返回 200，而 gemini-3.6-flash 与 gemini-3.5-flash-lite 回 11102——Gemini
    // 线从 3.5 直接跳到 3.8。倍率待 CodeBuddy 积分页核对，先按同族留空。
    { id: "gpt-6.1-sol", name: "GPT-6.1-Sol" },
    // ── Claude 线（2026-10-09 积分页,user-provided）──
    //
    // ⚠️ 与本文件 rule (1) 的关系,务必读完再动这些行:
    // 截图上这一整组带锁图标(付费档),且旁边的上线弹窗写着"待上线"——**这些 id
    // 在本机的免费账号上全部回 11102**,包括最直译的 claude-opus-5.5。同一批探测
    // 里 claude-opus-4.6 / claude-sonnet-4.6 / gpt-6-astra / gpt-6-sol / gpt-6.1-sol
    // 都回 200,判定器本身正常。
    //
    // 因此最可能的原因是**账号档位**:截图来自付费账号,本机号看不到这批服务条目。
    // 这与积分页按档位过滤是同一回事(见文件头 (2))。按用户判断先收录,并用 11102
    // 复核过——若哪天某个 id 在**付费**账号上也回 11102,那时才是目录错误,可以下架。
    //
    // id 形式已按本文件既有惯例写成小写点号(claude-opus-5.5 而非 UI 的
    // Claude-Opus-5.5),这是全表唯一验证过能被网关接受的写法。
    { id: "claude-opus-5.5", name: "Claude-Opus-5.5", rateMultiplier: 2.17, paidTier: true },
    { id: "claude-sonnet-5.5", name: "Claude-Sonnet-5.5", rateMultiplier: 1.33, paidTier: true },
    { id: "claude-opus-5", name: "Claude-Opus-5", rateMultiplier: 3.33, paidTier: true },
    { id: "claude-sonnet-5", name: "Claude-Sonnet-5", rateMultiplier: 1.33, paidTier: true },
    { id: "claude-opus-4.8", name: "Claude-Opus-4.8", rateMultiplier: 3.33, paidTier: true },
    { id: "claude-opus-4.7", name: "Claude-Opus-4.7", rateMultiplier: 3.33, paidTier: true },
    // 4.6 是本组唯一在免费账号上探到 200 的(id 与倍率都来自积分页/探测,两处一致)
    { id: "claude-opus-4.6", name: "Claude-Opus-4.6", rateMultiplier: 3.33, paidTier: true },
    { id: "claude-sonnet-4.6", name: "Claude-Sonnet-4.6", paidTier: true },
    { id: "gemini-3.8-flash", name: "Gemini-3.8-Flash" },
    { id: "grok-4.7", name: "Grok-4.7", rateMultiplier: 1.9 },
    { id: "space-bunny", name: "Space-Bunny", rateMultiplier: 0.08 },
    { id: "gemini-3.5-flash", name: "Gemini-3.5-Flash", rateMultiplier: 0.99 },
    { id: "glm-5v-turbo", name: "GLM-5v-Turbo", rateMultiplier: 0.71 },
    { id: "glm-5.3", name: "GLM-5.3", rateMultiplier: 0.79 },
    // 11102 through 2026-09; the 2026-09-30 probe saw it answer 200. The
    // multiplier is the CN credit page value — one credit system, parity test.
    { id: "glm-5.3-flash", name: "GLM-5.3-Flash", rateMultiplier: 0.06 },
    { id: "glm-5.2", name: "GLM-5.2", rateMultiplier: 0.79 },
    { id: "glm-5.1", name: "GLM-5.1", rateMultiplier: 0.79 },
    { id: "minimax-m3", name: "MiniMax-M3", rateMultiplier: 0.25 },
    { id: "kimi-k3", name: "Kimi-K3", rateMultiplier: 1.62 },
    // 0.57 取自 CN 积分页(两线一套积分系统,intl 页无此条目)。
    { id: "kimi-k2.7", name: "Kimi-K2.7-Code", rateMultiplier: 0.57 },
    { id: "kimi-k2.8-preview", name: "Kimi-K2.8-Preview", rateMultiplier: 0.77 },
    { id: "kimi-k2.6", name: "Kimi-K2.6", rateMultiplier: 0.52 },
    // Promo: free for the two weeks after the upstream V4.1-Flash launch
    // (2026-09-10 — DeepSeek's "set your model to deepseek-flash" announcement).
    // The paid multiplier (0.03, CN credit page; CN and intl share one credit
    // system) stays written here on purpose: `promoFreeUntil` only drives the
    // badge, which shows `free` while the window is open and falls back to
    // 0.03x by itself afterwards — no hand cleanup, and the CN/intl parity
    // invariant in tests/unit/codebuddy-intl-models.test.js keeps holding.
    { id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash", rateMultiplier: 0.11 },
  ],
  oauth: {
    baseUrl: "https://www.codebuddy.ai",
    stateUrl: "https://www.codebuddy.ai/v2/plugin/auth/state",
    tokenUrl: "https://www.codebuddy.ai/v2/plugin/auth/token",
    refreshUrl: "https://www.codebuddy.ai/v2/plugin/auth/token/refresh",
    userAgent: "IDE/2.63.2 CodeBuddy/2.63.2",
    platform: "ide",
    pollInterval: 5000,
  },
  features: {
    usage: true,
    usageApikey: true,
  },
};
