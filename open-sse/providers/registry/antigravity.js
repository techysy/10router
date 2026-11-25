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
    { id: "gemini-4-argon-high", name: "Gemini 4 Argon (High)", upstreamModelId: "gemini-4-argon-high(high)" },
    { id: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)", upstreamModelId: "gemini-4-argon-medium(medium)" },
    { id: "gemini-4-argon-low", name: "Gemini 4 Argon (Low)", upstreamModelId: "gemini-4-argon-low(low)" },
    // 4 Hydrogen: same tiered entity family as Argon (IDE picker 2026-11-16,
    // "Gemini 4 Hydrogen Medium" New). Entity ids are pattern-inferred from
    // the Argon family — `*gemini-4*` capability/effort wildcards already
    // cover them. Upstream 9router has no Hydrogen rows yet; no live probe
    // (jio 套餐无权限). Orchestrator (Argon) 亦缺上游实体 id 证据,未收录。
    { id: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (High)", upstreamModelId: "gemini-4-hydrogen-high(high)" },
    { id: "gemini-4-hydrogen-medium", name: "Gemini 4 Hydrogen (Medium)", upstreamModelId: "gemini-4-hydrogen-medium(medium)" },
    { id: "gemini-4-hydrogen-low", name: "Gemini 4 Hydrogen (Low)", upstreamModelId: "gemini-4-hydrogen-low(low)" },
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
