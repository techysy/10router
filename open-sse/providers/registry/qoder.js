export default {
  id: "qoder",
  priority: 30,
  alias: "qd",
  uiAlias: "qd",
  display: {
    name: "Qoder",
    icon: "water_drop",
    color: "#EC4899",
    website: "https://qoder.com",
    notice: {
      signupUrl: "https://qoder.com",
    },
  },
  category: "oauth",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  authHint: "Personal Access Token (pt-...) từ https://qoder.com/account/integrations",
  transport: {
    baseUrl: "https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation",
    headers: {},
    timeoutMs: 120000,
    stallTimeoutMs: 120000,
    usage: {
      url: "https://openapi.qoder.sh/api/v2/quota/usage",
    },
  },
  models: [
    // 2026-09-19 cleanup: "lite" removed — neither region's live catalog
    // publishes it (not even as enable:false); it was a marketing-era row.
    // Ultimate/Performance/Efficient stay: the INTL catalog prices them
    // (1.6x / 1.1x / 0.3x) and badges render from that live data.
    { id: "auto", name: "Auto" },
    // 2026-11-07: QoDuck（lmodel）— app 场景独占的免费模型，同 qoder-cn 行；
    // 国际版 app 端同样可见（用户界面截图 2026-11-07）。
    { id: "lmodel", name: "QoDuck", promoFreeNote: "个人版限时每日赠送尝鲜额度" },
    { id: "ultimate", name: "Ultimate" },
    { id: "performance", name: "Performance" },
    { id: "efficient", name: "Efficient" },
    { id: "qmodel_38max", name: "Qwen3.8-Max" },
    { id: "qmodel_latest", name: "Qwen3.7-Max" },
    { id: "qmodel", name: "Qwen3.7-Plus" },
    { id: "qfmodel", name: "Qwen3.8-Flash" },
    { id: "kmodel_latest", name: "Kimi-K3.1-Pro" },
    { id: "kmodel", name: "Kimi-K2.8-Preview" },
    { id: "gmodel", name: "GLM-5.3" },
    { id: "gfmodel", name: "GLM-5.3-Flash" },
    { id: "dmodel", name: "DeepSeek-V4-Pro" },
    // Qoder 界面上 dfmodel 就是「DeepSeek-Flash / DeepSeek-V4.1-Flash-1017」
    // （2026-10-20 客户端模型卡确认），旧名 DeepSeek-V4-Flash 已过时。
    // 限免：个人版 0.0x 至 2026-10-25 00:00 (UTC+8)，之后回 0.1x。
    // 用带时区的 ISO 写死边界——裸日期会被当成 UTC 零点，等于多送 8 小时。
    { id: "dfmodel", name: "DeepSeek-V4.1-Flash 1017", promoFreeUntil: "2026-10-25T00:00:00+08:00" },
    { id: "mmodel", name: "MiniMax-M3.1-Flash" },
  ],
  oauth: {
    openApiBaseUrl: "https://openapi.qoder.sh",
    centerBaseUrl: "https://center.qoder.sh",
    chatBaseUrl: "https://api3.qoder.sh",
    deviceTokenUrl: "https://openapi.qoder.sh/api/v1/deviceToken/poll",
    refreshUrl: "https://center.qoder.sh/algo/api/v3/user/refresh_token",
    userInfoUrl: "https://openapi.qoder.sh/api/v1/userinfo",
    quotaUsageUrl: "https://openapi.qoder.sh/api/v2/quota/usage",
    loginUrl: "https://qoder.com/device/selectAccounts",
  },
  features: {
    usage: true,
    // PAT (apikey) connections also carry quota usage (via job-token exchange).
    usageApikey: true,
  },
};
