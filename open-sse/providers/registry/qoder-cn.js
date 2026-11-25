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
    // 快速 = `fast`，0.6x。2026-11-25 live 探测：CN 目录只在 Cosy-Version
    // ≥1.2.0 时下发这一行（1.0.0 返回 13 条，≥1.2.0 返回 14 条），所以
    // catalog 读取已升到 QODER_CN_CATALOG_VERSION —— 否则这行永远取不到
    // model_config，聊天必报 `model_config for "fast" not yet known`。
    { id: "fast", name: "快速", rateMultiplier: 0.6 },
    { id: "qmodel_38max", name: "Qwen3.8-Max", rateMultiplier: 0.5, discountNote: "每晚 22:00—次日 8:00 错峰 4 折（10 PM-8 AM UTC+8）" },

    // 2026-11-18 客户端截图 + live 目录探测（GET /algo/api/v2/model/list）：
    // Qwen4-Max 正式版上架 = 上游 key `qmodel_latest`（复用，0.4x/1M）；
    // Qwen4-Max-Preview 拆为独立 key `qmodel_latest_preview`（0.1x/原价 0.5x）。
    { id: "qmodel_latest", name: "Qwen4-Max", rateMultiplier: 0.4 },
    { id: "qmodel_latest_preview", name: "Qwen4-Max-Preview", rateMultiplier: 0.1 },
    { id: "qmodel", name: "Qwen3.7-Plus" },
    // Added 2026-09-19: present in the live CN catalog (rate 0.1, no promo);
    // it was leaking into the page as a lone "custom" row via the fetch
    // button until registered here.
    { id: "q37fmodel", name: "Qwen3.7-Flash" },
    { id: "qfmodel", name: "Qwen3.8-Flash", rateMultiplier: 0.1, discountNote: "每晚 22:00—次日 8:00 错峰 4 折（10 PM-8 AM UTC+8）" },
    { id: "dmodel", name: "DeepSeek-V4-Pro", rateMultiplier: 0.5 },
    // 同 qoder：dfmodel = DeepSeek-V4.1-Flash-1017，个人版限免至
    // 2026-10-25 00:00 (UTC+8)，之后回 0.1x。
    { id: "dfmodel", name: "DeepSeek-Flash", rateMultiplier: 0.1 },
    { id: "gmodel", name: "GLM-5.3", rateMultiplier: 0.8 },
    // GLM-5.4（2026-11-25 客户端截图 + live 目录探测）= 上游 key
    // `gmodel_latest`，0.8x、tags:[new]、is_vl/is_reasoning 均 true。与 GLM-5.3
    // 同价但目录里是独立 key，不是同一个模型的两种写法。
    { id: "gmodel_latest", name: "GLM-5.4", rateMultiplier: 0.8 },
    { id: "gfmodel", name: "GLM-5.3-Flash", rateMultiplier: 0.1 },
    { id: "gm51model", name: "GLM-5.2" },
    { id: "kmodel_latest", name: "Kimi-K3.1-Pro", rateMultiplier: 1.0 },
    { id: "kmodel", name: "Kimi-K2.8-Preview", rateMultiplier: 0.8 },
    { id: "jmodel", name: "Step-5-Preview", rateMultiplier: 0.3 },
    { id: "mmodel", name: "MiniMax-M3.1-Flash", rateMultiplier: 0.1 },
  ],
  oauth: {
    openApiBaseUrl: "https://openapi.qoder.com.cn",
    centerBaseUrl: "https://gateway.qoder.com.cn",
    chatBaseUrl: "https://gateway.qoder.com.cn",
    deviceTokenUrl: "https://openapi.qoder.com.cn/api/v1/deviceToken/poll",
    refreshUrl: "https://gateway.qoder.com.cn/algo/api/v3/user/refresh_token",
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
