export default {
  id: "minimax-code",
  priority: 82,
  alias: "mcode",
  aliases: ["mm", "mcode"],
  uiAlias: "mcode",
  display: {
    name: "MiniMax Code",
    icon: "smart_toy",
    color: "#FF4D4F",
    textIcon: "MM",
    website: "https://agent.minimax.cn",
  },
  category: "oauth",
  authModes: ["oauth"],
  hasOAuth: true,
  features: { usage: true },
  transport: {
    baseUrl: "https://agent.minimax.cn/mavis/api/v1/llm/v1/messages",
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
    deviceUrl: "https://account.minimax.cn/oauth2/device/code",
    tokenUrl: "https://account.minimax.cn/oauth2/token",
    scope: "agent.default",
    audience: "agent-backend",
    refreshLeadMs: 10 * 60 * 1000,
  },
  models: [
    // 正式 id（2026-10 上架）为唯一入口。`-Preview` 的过渡保留期（issue #70）
    // 已结束，2026-11-25 按用户口径下架（上游目录当时未能核实：本机 CreditDaddy
    // MiniMax 线未开启，无凭据可探）。
    // 摘行只影响选择器与 `/v1/models`：注册表不是请求闸（`isValidModel` 无调用方，
    // `getModelUpstreamId` 对未登记 id 原样透传），所以仍写着 `-Preview` 的存量连接 /
    // 组合照旧把原 id 发给上游——我们不改写、也不静默回落成正式 id，能否仍出字由上游决定。
    { id: "MiniMax-M3.1-Flash", name: "MiniMax M3.1 Flash" },
    { id: "MiniMax-M3", name: "MiniMax M3" },
    { id: "MiniMax-M2.7", name: "MiniMax M2.7" },
    { id: "MiniMax-M2.7-highspeed", name: "MiniMax M2.7 Highspeed" },
  ],
};
