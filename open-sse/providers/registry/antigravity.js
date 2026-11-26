import { ANTIGRAVITY_IDE_BASE_URL, ANTIGRAVITY_IDE_USER_AGENT, ANTIGRAVITY_OAUTH_CLIENT } from "../shared.js";

export default {
  id: "antigravity",
  priority: 30,
  alias: "ag",
  uiAlias: "ag",
  display: {
    name: "Antigravity",
    icon: "rocket_launch",
    color: "#F59E0B",
    website: "https://antigravity.google",
    notice: {
      signupUrl: "https://antigravity.google",
    },
    deprecated: true,
    deprecationNotice: "RISK_NOTICE",
  },
  category: "oauth",
  serviceKinds: ["llm", "image"],
  transport: {
    baseUrls: [ANTIGRAVITY_IDE_BASE_URL],
    format: "antigravity",
    // Issue #76: Google cloudcode 端点从被墙网络直连会被静默丢包,代理失败后
    // 回退直连就是数百秒死等。默认 strictProxy 让失败快速抛错进入账号顺位接力;
    // 连接上显式设置过 strictProxy 的用户不受影响。
    strictProxy: true,
    headers: {
      "User-Agent": ANTIGRAVITY_IDE_USER_AGENT,
    },
    retry: {
      "429": {
        attempts: 3,
      },
      "500": {
        attempts: 3,
      },
      "503": {
        attempts: 3,
      },
    },
    usage: {
      // Discovery (quota/project) — daily host now serves these (matches the
      // native IDE client); kept in sync with 9router 70f15aa.
      quotaApiUrl: `${ANTIGRAVITY_IDE_BASE_URL}/v1internal:fetchAvailableModels`,
      // Dual-window quota summary (Antigravity website "Model Quota" UI parity).
      // Tried in order; chat traffic lands on the daily host, and the two
      // environments report different counters, so daily must be queried first
      // or the numbers lag behind what the account actually spent (same order
      // the native IDE client and CLIProxyAPI use).
      quotaSummaryApiUrls: [
        "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
        "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary",
        "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      ],
      loadProjectApiUrl: "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
      tokenUrl: "https://oauth2.googleapis.com/token",
    },
    clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    clientSecret: "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",
  },
  models: [
    // 4 Argon: tiered entity family like 3.8 — bare id 404s, thinking level
    // rides the entity name; effort floor is LOW (no "minimal" tier, see
    // thinkingLevels.js).
    // ⚠️ 2026-11-26 live probe (3 free-tier accounts, NAS): no Argon row appears
    // in fetchAvailableModels and every spelling answers 404 "Requested entity
    // was not found". Kept anyway — ported from upstream on a tier we cannot
    // inspect, so this is evidence of plan gating, not proof the ids are dead
    // (unlike Hydrogen below, whose replacement entity the same catalog does
    // publish). Re-probe on a paid account before retiring these rows.
    { id: "gemini-4-argon-high", name: "Gemini 4 Argon (High)", upstreamModelId: "gemini-4-argon-high(high)" },
    { id: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)", upstreamModelId: "gemini-4-argon-medium(medium)" },
    { id: "gemini-4-argon-low", name: "Gemini 4 Argon (Low)", upstreamModelId: "gemini-4-argon-low(low)" },
    // 4 Hydrogen: the entity the upstream catalog actually publishes on our
    // accounts is `gemini-4-hydrogen-sonar` (NAS live probe 2026-11-26, 3
    // accounts × fetchAvailableModels: one hydrogen row, no tiered ones).
    // The three tier ids this file used to send (pattern-inferred from Argon,
    // never live-probed — see 2089bb78f) answer 404 "Requested entity was not
    // found" both with and without the level suffix, so every request burned a
    // 120s model lock + an account walk (#174). The tier ids stay as aliases
    // onto the live entity with the level carried in the suffix — the same
    // shape the 3.7/3.6 family below uses — so existing combos/locks keep
    // working and now answer. Effort also stays reachable on the single id
    // through the client's own reasoning_effort.
    { id: "gemini-4-hydrogen-sonar", name: "Gemini 4 Hydrogen (Sonar)", upstreamModelId: "gemini-4-hydrogen-sonar" },
    // The un-tiered name routes to the medium tier (gemini-3.8-flash precedent).
    // Users who had set up `ag/gemini-4-hydrogen` hit 404 through passthrough;
    // the alias makes that spelling answer. Same entity as the row above — the
    // only difference is whether a thinking level is stated explicitly.
    { id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", upstreamModelId: "gemini-4-hydrogen-sonar(medium)" },
    { id: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (High)", upstreamModelId: "gemini-4-hydrogen-sonar(high)" },
    { id: "gemini-4-hydrogen-medium", name: "Gemini 4 Hydrogen (Medium)", upstreamModelId: "gemini-4-hydrogen-sonar(medium)" },
    { id: "gemini-4-hydrogen-low", name: "Gemini 4 Hydrogen (Low)", upstreamModelId: "gemini-4-hydrogen-sonar(low)" },
    // 3.8 uses its own tiered entity family — upstream serves
    // `gemini-3.8-flash-<tier>(<level>)` (the bare id 404s "Requested entity
    // was not found"). The un-tiered alias routes to the medium tier.
    { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)", upstreamModelId: "gemini-3.8-flash-high(high)" },
    { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)", upstreamModelId: "gemini-3.8-flash-medium(medium)" },
    { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)", upstreamModelId: "gemini-3.8-flash-low(low)" },
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", upstreamModelId: "gemini-3.8-flash-medium(medium)" },
    // 3.7 tiers share the single `tiered` entity — upstream accepts the bare
    // `gemini-3.7-flash-tiered` family only; the thinking level rides on
    // generationConfig.thinkingConfig.thinkingLevel (applied by the thinking
    // concern), so the registry id keeps its level suffix as the upstream
    // entity's requested tier.
    { id: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)", upstreamModelId: "gemini-3.7-flash-tiered(high)" },
    { id: "gemini-3.7-flash-medium", name: "Gemini 3.7 Flash (Medium)", upstreamModelId: "gemini-3.7-flash-tiered(medium)" },
    { id: "gemini-3.7-flash-low", name: "Gemini 3.7 Flash (Low)", upstreamModelId: "gemini-3.7-flash-tiered(low)" },
    { id: "gemini-3.6-flash-high", name: "Gemini 3.6 Flash (High)", upstreamModelId: "gemini-3.6-flash-tiered(high)" },
    { id: "gemini-3.6-flash-medium", name: "Gemini 3.6 Flash (Medium)", upstreamModelId: "gemini-3.6-flash-tiered(medium)" },
    { id: "gemini-3.6-flash-low", name: "Gemini 3.6 Flash (Low)", upstreamModelId: "gemini-3.6-flash-tiered(low)" },
    { id: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)", upstreamModelId: "gemini-pro-agent" },
    { id: "gemini-pro-agent", name: "Gemini 3.1 Pro (High)", upstreamModelId: "gemini-pro-agent" },
    { id: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)", upstreamModelId: "gemini-3.1-pro-low(low)" },
    // Claude 5.5: tiered entity family like Gemini — bare id routes to the high tier.
    { id: "claude-sonnet-5-5-high", name: "Claude Sonnet 5.5 (High)", upstreamModelId: "claude-sonnet-5-5-high(high)" },
    { id: "claude-sonnet-5-5-medium", name: "Claude Sonnet 5.5 (Medium)", upstreamModelId: "claude-sonnet-5-5-medium(medium)" },
    { id: "claude-sonnet-5-5-low", name: "Claude Sonnet 5.5 (Low)", upstreamModelId: "claude-sonnet-5-5-low(low)" },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5 (Thinking)", upstreamModelId: "claude-sonnet-5-5-high(high)" },
    { id: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High)", upstreamModelId: "claude-opus-5-5-high(high)" },
    { id: "claude-opus-5-5-medium", name: "Claude Opus 5.5 (Medium)", upstreamModelId: "claude-opus-5-5-medium(medium)" },
    { id: "claude-opus-5-5-low", name: "Claude Opus 5.5 (Low)", upstreamModelId: "claude-opus-5-5-low(low)" },
    { id: "claude-opus-5-5", name: "Claude Opus 5.5 (Thinking)", upstreamModelId: "claude-opus-5-5-high(high)" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
    { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" },
    { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
    { id: "gemini-3-flash", name: "Gemini 3 Flash", thinking: false },
    // Image generation models
    { id: "gemini-3.1-flash-image", name: "Gemini 3.1 Flash (Image)", kind: "image", imageGen: true, capabilities: ["textToImage"] },
    { id: "gemini-3-pro-image", name: "Gemini 3 Pro (Image)", kind: "image", imageGen: true, capabilities: ["textToImage"] },
    { id: "gemini-2.5-flash-image", name: "Gemini 2.5 Flash (Image)", kind: "image", imageGen: true, capabilities: ["textToImage"] },
    { id: "imagen-3.0-generate-002", name: "Imagen 3", kind: "image", imageGen: true, capabilities: ["textToImage"] },
  ],
  oauth: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userInfoUrl: "https://www.googleapis.com/oauth2/v1/userinfo",
    scopes: [
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/cclog",
      "https://www.googleapis.com/auth/experimentsandconfigs",
    ],
    apiEndpoint: "https://daily-cloudcode-pa.googleapis.com",
    apiVersion: "v1internal",
    loadCodeAssistEndpoint: "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    onboardUserEndpoint: "https://cloudcode-pa.googleapis.com/v1internal:onboardUser",
    loadCodeAssistUserAgent: ANTIGRAVITY_IDE_USER_AGENT,
    refreshLeadMs: 300000,
  },
  features: {
    usage: true,
  },
};
