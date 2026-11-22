// QwenWork （千问办公） China — the qwenwork.cn deployment of the same
// product as `qwenwork` (international). Identical protocol, endpoints and
// COSY scheme; only the gateway host, client_id and redirect_uri differ
// (see shared/qwenwork/constants.js). Sign-in is via DingTalk / phone /
// Alibaba Cloud account on the gateway's /device/selectAccounts page, and
// the authorization step asks for an account AND a team — the selected
// team's credits are what calls are charged to.
export default {
  id: "qwenwork-cn",
  priority: 36,
  alias: "qwc",
  uiAlias: "qwc",
  display: {
    name: "QwenWork CN",
    icon: "work",
    color: "#E11D48",
    website: "https://qwenwork.cn",
    notice: {
      text: "使用您自己的千问办公账号通过设备码登录。授权页上请选择要使用的团队——调用将消耗所选团队的积分。",
      signupUrl: "https://qwenwork.cn",
    },
  },
  category: "oauth",
  authModes: ["oauth"],
  hasOAuth: true,
  transport: {
    baseUrl: "https://gateway.qwenwork.cn/algo/api/v2/service/pro/sse/agent_chat_generation",
    headers: {},
    timeoutMs: 120000,
    stallTimeoutMs: 120000,
    usage: {
      url: "https://gateway.qwenwork.cn/api/v1/adapter/user/account-context?include=user,plan,quota,page,data_sharing",
    },
  },
  // Static fallback roster — the live "qwork" scene catalog (fetched via
  // qwenworkModels) is authoritative and plan-gated; passthroughModels lets
  // any catalog key route. Tier keys are the short names the current
  // desktop client actually offers; the qwork-* spellings are the same
  // tiers' long names.
  models: [
    { id: "flash", name: "标准" },
    { id: "pro", name: "高级" },
    { id: "qwen4-max", name: "Qwen4-Max" },
    { id: "qwen3.8-max-preview", name: "Qwen3.8-Max" },
    { id: "qwen3.8-flash", name: "Qwen3.8-Flash" },
    { id: "ling-3.1-flash", name: "Ling-3.1-Flash" },
    { id: "deepseek-flash", name: "DeepSeek-V4.1-Flash" },
    { id: "deepseek-v4-pro", name: "Deepseek-V4-Pro" },
    { id: "glm-5.3", name: "GLM-5.3" },
    { id: "glm-5.3-flash", name: "GLM-5.3-Flash" },
    { id: "kimi-k3.1-pro", name: "Kimi-K3.1-Pro" },
    { id: "minimax-m3.1-flash", name: "MiniMax-M3.1-Flash" },
    { id: "step-5-preview", name: "Step-5-Preview" },
  ],
  passthroughModels: true,
  oauth: {
    gatewayBaseUrl: "https://gateway.qwenwork.cn",
    deviceTokenUrl: "https://gateway.qwenwork.cn/api/v1/deviceToken/poll",
    refreshUrl: "https://gateway.qwenwork.cn/api/v1/deviceToken/refresh",
    userInfoUrl: "https://gateway.qwenwork.cn/api/v1/adapter/user/account-context?include=user,plan,quota,page,data_sharing",
    quotaUsageUrl: "https://gateway.qwenwork.cn/api/v1/adapter/user/account-context?include=user,plan,quota,page,data_sharing",
    loginUrl: "https://gateway.qwenwork.cn/device/selectAccounts",
    clientId: "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb",
    redirectUri: "qwenwork-cn://",
  },
  features: {
    usage: true,
  },
};
