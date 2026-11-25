export default {
  id: "minimax-code-global",
  priority: 84,
  alias: "minimax-code-global",
  aliases: ["mmg", "mmcode"],
  uiAlias: "mmg",
  display: {
    name: "MiniMax Code (Global)",
    icon: "smart_toy",
    color: "#FF4D4F",
    textIcon: "MM",
    website: "https://agent.minimax.io",
  },
  category: "oauth",
  authModes: ["oauth"],
  hasOAuth: true,
  features: { usage: true },
  transport: {
    baseUrl: "https://agent.minimax.io/mavis/api/v1/llm/v1/messages",
    format: "claude",
    thinkingFormat: "claude-adaptive",
    headers: {
      "User-Agent": "MiniMaxAgent",
      "X-Mavis-Agent-Id": "main",
    },
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
      anthropicVersion: true,
    },
  },
  oauth: {
    clientId: "mcode-public",
    deviceUrl: "https://account.minimax.io/oauth2/device/code",
    tokenUrl: "https://account.minimax.io/oauth2/token",
    scope: "agent.default",
    audience: "agent-backend",
    refreshLeadMs: 10 * 60 * 1000,
  },
  models: [
    // 同 minimax-code：`-Preview` 过渡期已结束（issue #70），2026-11-25 下架，
    // 只留正式 id。注册表不做请求闸，写过旧 id 的请求仍原样透传。
    { id: "MiniMax-M3.1-Flash", name: "MiniMax M3.1 Flash" },
    { id: "MiniMax-M3", name: "MiniMax M3" },
    { id: "MiniMax-M2.7", name: "MiniMax M2.7" },
    { id: "MiniMax-M2.7-highspeed", name: "MiniMax M2.7 Highspeed" },
  ],
};
