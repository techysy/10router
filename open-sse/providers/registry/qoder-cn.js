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
    // HungerG（客户端 2026-11-25 截图里的 Free/0x 条目）= 上游 key `hmodel`。
    // 目录读取已改用桌面指纹（QODER_CN_CATALOG_CLIENT_TYPE），这一行才拿得到。
    // 实测（2026-11-25，三号交叉）：
    //   - ct=5 的 CN 目录 14 条**没有** hmodel；ct=10 是 15 条，且其余 14 行
    //     与 ct=5 逐字段完全一致（15 个字段零差异），所以切过去不影响别的行。
    //   - 聊天用**我们原有的 cli 形状 + ct=5 签名**即可放行：备用号与 auto
    //     交错跑，hmodel 4/4 次出正文、auto 2/2 次正常；响应帧形状与 auto
    //     不同（id 为 `hex.hex`、首帧无 reasoning_content）—— 不是被静默
    //     降级成 auto 后回的字。
    //   - 条目里 minimal_version 对 cli/qoder_work/mobile/jb_plugin/
    //     cloud_agents/qoder_wake 写死 9999.9999.9999，但那是**目录可见性**
    //     口径，不是推理端点的准入：实测 cli 形状照样出字。
    // ⚠️ 别把「恒定 10605 isQueued」当成通道封禁——主号与 #187 同期连
    //    `auto` 都同样被排队（账号级 p4 限流），只有未限流的备用号能作数。
    //    判定必须带同期对照组，且对照组也要红过一次才算模型本身的问题。
    // price_factor 0 + tags:[free] + is_free:true → 免费档；1M、is_vl、
    // is_reasoning、思考档 low/high/max 可关（thinking_config.disabled 存在）。
    { id: "hmodel", name: "HungerG", rateMultiplier: 0 },
    // 快速 = `fast`，0.6x。2026-11-25 live 探测：CN 目录按客户端指纹决定下发
    // 哪些行——ct=5 下 1.0.0 只有 13 条（无 fast）、≥1.2.0 才有 14 条；ct=10
    // 下 15 条（fast + hmodel 都在）。catalog 读取已改用
    // QODER_CN_CATALOG_VERSION + QODER_CN_CATALOG_CLIENT_TYPE；在此之前这行
    // 永远取不到 model_config，聊天必报 `model_config for "fast" not yet known`。
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
