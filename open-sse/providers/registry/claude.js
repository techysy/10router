import { CLAUDE_CLI_VERSION } from "../shared.js";

export default {
  id: "claude",
  priority: 10,
  alias: "cc",
  uiAlias: "cc",
  display: {
    name: "Claude Code",
    icon: "smart_toy",
    color: "#D97757",
    website: "https://claude.ai",
    notice: {
      signupUrl: "https://claude.ai",
    },
    deprecated: true,
    deprecationNotice: "RISK_NOTICE",
  },
  category: "oauth",
  transport: {
    baseUrl: "https://api.anthropic.com/v1/messages",
    format: "claude",
    urlSuffix: "?beta=true",
    headers: {
      "Anthropic-Version": "2023-06-01",
      "Anthropic-Beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advanced-tool-use-2025-11-20,effort-2025-11-24,structured-outputs-2025-12-15,fast-mode-2026-02-01,redact-thinking-2026-02-12,token-efficient-tools-2026-03-28",
      "Anthropic-Dangerous-Direct-Browser-Access": "true",
      // CLI 版本 floor（当前 2.1.322）。注册表 headers 是静态对象，无法 await
      // resolveClaudeCliVersion() —— 异步路径（quotaAutoPing / usage）动态跟随
      // npm latest；chat 路径按 floor 发。floor 升级点：Fable 5.2 拒绝 <2.1.290
      // 时把这里抬到 2.1.322（2026-11-12，借上游 9router v0.5.119）。
      "User-Agent": `claude-cli/${CLAUDE_CLI_VERSION} (external, sdk-cli)`,
      "X-App": "cli",
      "X-Stainless-Helper-Method": "stream",
      "X-Stainless-Retry-Count": "0",
      "X-Stainless-Runtime-Version": "v24.14.0",
      "X-Stainless-Package-Version": "0.80.0",
      "X-Stainless-Runtime": "node",
      "X-Stainless-Lang": "js",
      "X-Stainless-Arch": "arm64",
      "X-Stainless-Os": "MacOS",
      "X-Stainless-Timeout": "600",
    },
    quirks: {
      cloakToolsOnOAuth: true,
    },
    auth: {
      apiKey: {
        header: "x-api-key",
        scheme: "raw",
      },
      oauth: {
        header: "Authorization",
        scheme: "bearer",
      },
    },
    usage: {
      oauthUrl: "https://api.anthropic.com/api/oauth/usage",
      orgUrl: "https://api.anthropic.com/v1/organizations/{org_id}/usage",
      settingsUrl: "https://api.anthropic.com/v1/settings",
      profileUrl: "https://api.anthropic.com/api/oauth/profile",
      resetUrl: "https://api.anthropic.com/api/organizations/{org_id}/reset_rate_limits",
    },
  },
  models: [
    // Upstream added 5.5 (2026-09-23); same subscription lane as opus-5.
    { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
    { id: "claude-opus-5", name: "Claude Opus 5" },
    { id: "claude-fable-5", name: "Claude Fable 5" },
    { id: "claude-fable-5-1", name: "Claude Fable 5.1" },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
    // sonnet-5.5：翻译器归一化由自己的任务负责，此处只登记注册表；
    // capabilities 精确键 `claude-sonnet-5-5` 已同步（1M + adaptive）。
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
    { id: "claude-haiku-4-5-20251001", name: "Claude 4.5 Haiku" },
  ],
  oauth: {
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    authorizeUrl: "https://claude.ai/oauth/authorize",
    tokenUrl: "https://api.anthropic.com/v1/oauth/token",
    scopes: [
      "org:create_api_key",
      "user:profile",
      "user:inference",
    ],
    codeChallengeMethod: "S256",
    refreshLeadMs: 14400000,
    refresh: {
      encoding: "json",
    },
  },
  features: {
    usage: true,
  },
};
