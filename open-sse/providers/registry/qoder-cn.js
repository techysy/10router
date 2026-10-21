export default {
  id: "qoder-cn",
  priority: 31,
  alias: "qdc",
  uiAlias: "qdc",
  display: {
    name: "Qoder CN",
    icon: "water_drop",
    color: "#F43F5E",
    website: "https://qoder.cn",
    notice: {
      signupUrl: "https://qoder.cn",
    },
  },
  category: "oauth",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  authHint: "Personal Access Token (pt-...) 来自 https://qoder.cn/account/integrations",
  // Static JSON catalog — CN model list endpoint requires COSY signing, so
  // pull the pre-extracted catalog through the JSON-catalog flow instead of
  // the live /model/list endpoint. Same approach as CodeBuddy/opencode-go.
  modelsJsonUrl: "https://api.github.com/repos/techysy/10router/contents/providers/qoder-cn.json",
  // Gitee mirror fallback — used when the GitHub source is unreachable/slow
  fallbackModelsJsonUrl: "https://gitee.com/techysy/10router/raw/main/providers/qoder-cn.json",
  transport: {
    baseUrl: "https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation",
    headers: {},
    timeoutMs: 120000,
    stallTimeoutMs: 120000,
    usage: {
      url: "https://openapi.qoder.com.cn/api/v2/quota/usage",
    },
  },
  models: [
    // 2026-09-19 cleanup: ultimate/performance/efficient/lite/qmodel_preview
    // were marketing-era rows — the CN live catalog (raw, incl. enable:false)
    // publishes none of them (only Auto + the model keys below). Chat still
    // accepts those keys server-side; they simply no longer get dashboard rows.
    { id: "auto", name: "Auto" },
    { id: "qmodel_38max", name: "Qwen3.8-Max" },
    { id: "qmodel_latest", name: "Qwen3.7-Max" },
    { id: "qmodel", name: "Qwen3.7-Plus" },
    // Added 2026-09-19: present in the live CN catalog (rate 0.1, no promo);
    // it was leaking into the page as a lone "custom" row via the fetch
    // button until registered here.
    { id: "q37fmodel", name: "Qwen3.7-Flash" },
    { id: "qfmodel", name: "Qwen3.8-Flash" },
    { id: "kmodel_latest", name: "Kimi-K3" },
    { id: "kmodel", name: "Kimi-K2.7-Code" },
    { id: "gmodel", name: "GLM-5.3" },
    { id: "gfmodel", name: "GLM-5.3-Flash" },
    { id: "gm51model", name: "GLM-5.2" },
    { id: "dmodel", name: "DeepSeek-V4-Pro" },
    // 同 qoder：dfmodel = DeepSeek-V4.1-Flash-1017，个人版限免至
    // 2026-10-25 00:00 (UTC+8)，之后回 0.1x。
    { id: "dfmodel", name: "DeepSeek-V4.1-Flash 1017", promoFreeUntil: "2026-10-25T00:00:00+08:00" },
    { id: "mmodel", name: "MiniMax-M3" },
  ],
  oauth: {
    openApiBaseUrl: "https://openapi.qoder.com.cn",
    centerBaseUrl: "https://gateway.qoder.com.cn",
    chatBaseUrl: "https://gateway.qoder.com.cn",
    deviceTokenUrl: "https://openapi.qoder.com.cn/api/v1/deviceToken/poll",
    // Same shape as the global deployment: device refresh on openapi (no
    // signature), job refresh for `jrt-` tokens on its own path. The center
    // `/algo/api/v3/user/refresh_token` endpoint requires appcode signing and
    // rejects unsigned device tokens (403 "Request discarded").
    refreshUrl: "https://openapi.qoder.com.cn/api/v1/deviceToken/refresh",
    jobRefreshUrl: "https://openapi.qoder.com.cn/api/v1/jobToken/refresh",
    userInfoUrl: "https://openapi.qoder.com.cn/api/v1/userinfo",
    quotaUsageUrl: "https://openapi.qoder.com.cn/api/v2/quota/usage",
    loginUrl: "https://qoder.cn/device/selectAccounts",
  },
  features: {
    usage: true,
    // PAT (apikey) connections also carry quota usage (via job-token exchange).
    usageApikey: true,
  },
};
