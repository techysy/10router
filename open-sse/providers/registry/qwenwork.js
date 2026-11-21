// QwenWork （千问办公） International — Alibaba's all-in-one workplace agent
// (qwenwork.ai, public beta 2026-08), the merged successor of QoderWork,
// MuleRun and Wukong. Its desktop client speaks the Qoder protocol family:
// device-token sign-in (PKCE + nonce + machine_id, account + team picked on
// the gateway's /device/selectAccounts page), COSY envelope signing, and
// agent_chat_generation SSE chat — see shared/qwenwork/constants.js.
//
// Differences from Qoder that matter here:
//   - chat runs on the device token directly (no PAT, no job-token layer);
//   - the device token refreshes via /api/v1/deviceToken/refresh with
//     single-use rotating refresh tokens (gateway must be the only
//     refresher; see tokenRefresh refreshQwenWorkToken);
//   - the model catalog is the "qwork" scene of /algo/api/v2/model/list;
//   - sign-in asks the user to pick an account AND a team — the team's
//     wallet is what gets charged, so the notice calls it out.
export default {
  id: "qwenwork",
  priority: 35,
  alias: "qw",
  uiAlias: "qw",
  display: {
    name: "QwenWork",
    icon: "work",
    color: "#FF6A00",
    website: "https://qwenwork.ai",
    notice: {
      text: "Sign in with your own QwenWork account via device code. On the authorization page, pick the team whose plan you want to use — calls are charged to the selected team's credits.",
      signupUrl: "https://qwenwork.ai",
    },
  },
  category: "oauth",
  authModes: ["oauth"],
  hasOAuth: true,
  transport: {
    baseUrl: "https://gateway.qwenwork.ai/algo/api/v2/service/pro/sse/agent_chat_generation",
    headers: {},
    timeoutMs: 120000,
    stallTimeoutMs: 120000,
    usage: {
      url: "https://gateway.qwenwork.ai/api/v1/adapter/user/account-context?include=user,plan,quota,page,data_sharing",
    },
  },
  // Static fallback roster — the live "qwork" scene catalog (fetched via
  // qwenworkModels) is authoritative and plan-gated; passthroughModels lets
  // any catalog key route. Tier keys are the short names the current
  // desktop client actually offers (client 1.3.x+ modelSelector); the
  // qwork-* spellings are the same tiers' long names.
  models: [
    { id: "lite", name: "Economy" },
    { id: "flash", name: "Standard" },
    { id: "pro", name: "Advanced" },
    { id: "flagship", name: "Flagship" },
    { id: "qwork-lite", name: "Economy (qwork)" },
    { id: "qwork-auto", name: "Standard (qwork)" },
    { id: "qwork-advanced", name: "Advanced (qwork)" },
    { id: "qwork-ultimate", name: "Flagship (qwork)" },
    { id: "qwen4-max", name: "Qwen4-Max" },
    { id: "qmodel_latest", name: "Qwen3.8-Max" },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "deepseek-flash", name: "DeepSeek V4 Flash" },
    { id: "glm-5.3", name: "GLM-5.3" },
    { id: "glm-5.3-flash", name: "GLM-5.3-Flash" },
    { id: "kimi-k3.1-pro", name: "Kimi-K3.1-Pro" },
    { id: "minimax-m3.1-flash", name: "MiniMax-M3.1-Flash" },
    { id: "step-5-preview", name: "Step-5-Preview" },
  ],
  passthroughModels: true,
  oauth: {
    gatewayBaseUrl: "https://gateway.qwenwork.ai",
    deviceTokenUrl: "https://gateway.qwenwork.ai/api/v1/deviceToken/poll",
    refreshUrl: "https://gateway.qwenwork.ai/api/v1/deviceToken/refresh",
    userInfoUrl: "https://gateway.qwenwork.ai/api/v1/adapter/user/account-context?include=user,plan,quota,page,data_sharing",
    quotaUsageUrl: "https://gateway.qwenwork.ai/api/v1/adapter/user/account-context?include=user,plan,quota,page,data_sharing",
    loginUrl: "https://gateway.qwenwork.ai/device/selectAccounts",
    clientId: "cc65e5fc-05bd-4f5d-a4e8-0df19aa3d75a",
    redirectUri: "qwenwork://",
  },
  features: {
    usage: true,
  },
};
