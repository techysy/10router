// Loomy（科大讯飞「Loomy」办公助手）— OpenAI 兼容的 session-token provider。
//
// ── 登录态怎么来（没有短信登录 UI）──────────────────────────────
// 上游登录是「短信验证码 + 客户端内置 AccessKey 的 HMAC-SHA1 签名」两步，签名
// 密钥随安装包分发（见 agent2api 的 loomy/{login,sign}.rs）。10router 这一版
// 不实现短信登录，也不假装能续期：
//   - 手工导入：把 Loomy 客户端登录后的 session 粘贴成连接凭证（apiKey 或
//     accessToken 都认，两个头都会发）；
//   - 会话 14 天、上游**没有 refresh 接口** ⇒ 过期后只能重新导入（业务面会以
//     HTTP 200 + `{code:"100002"}` 或 401 表达，executor 翻成 needs-reauth）。
// 因此 category 是 apikey，而不是 oauth：这里没有可自动跑的授权流程。
//
// ── 三个平面（详见 Rust endpoints.rs）───────────────────────────
//   chat         {base}/api/v1/chat/completions      OpenAI 协议
//   积分/签到     {base}/api/v2/points/records
//                {base}/api/v1/points/first-login
//   集成网关基址  https://loomyad.xunfei.cn
//
// ── 模型静态表 ─────────────────────────────────────────────────
// 上游 `/models` 没有内置兜底清单（Rust models.rs 的 BUILTIN_FALLBACK_MODELS 为
// 空表）。下表是参考实现实测的 bundled catalogue（8 条）+ Rust 目录注释里点名的
// `DeepSeek-V4.1-Flash`（声明可读图）。倍率写在展示名的括号里、不是结构化字段，
// 这里只保留模型名，不把倍率编进字段。`strictModels` 让表外 id 在选号前直接
// 400 —— 上游对未知模型会静默回落，那是最难查的一种「成功」。
const LOOMY_BASE_URL = "https://loomyad.xunfei.cn";
const LOOMY_CHAT_URL = `${LOOMY_BASE_URL}/api/v1/chat/completions`;

export default {
  id: "loomy",
  alias: "loomy",
  aliases: ["xfyun-loomy", "loomy-xunfei"],
  uiAlias: "loomy",
  category: "oauth",
  authType: "apikey",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  display: {
    name: "Loomy 讯飞",
    icon: "auto_awesome",
    color: "#16A6FF",
    textIcon: "LM",
    website: "https://loomy.xunfei.cn",
    notice: {
      signupUrl: "https://loomy.xunfei.cn",
    },
  },
  transport: {
    baseUrl: LOOMY_CHAT_URL,
    format: "openai",
    // 上游模型名就是 wire id，没有路由前缀；表内没有的 id 由 strictModels 拒绝。
  },
  models: [
    // 2026-10-20 按上游 `GET /api/v1/models` 实测校准（12 条里取 9 条 chat；
    // 另外 3 条是图像模型，chat 执行器不服务，故不登记）。`deepseek-v4-flash-0731`
    // 已不在上游目录，但实测仍可调用，作为 legacy 保留。
    { id: "deepseek-v4-flash-0731", name: "DeepSeek V4 Flash 0731", contextWindow: 1048576, reasoning: true, vision: false },
    { id: "DeepSeek-V4.1-Flash", name: "DeepSeek V4.1 Flash", contextWindow: 1048576, maxOutput: 384000, reasoning: true, vision: true },
    { id: "MiniMax-M3", name: "MiniMax M3", contextWindow: 1048576, maxOutput: 512000, reasoning: true, vision: true },
    { id: "Kimi-k2.6", name: "Kimi k2.6", contextWindow: 262144, maxOutput: 65536, reasoning: true, vision: true },
    { id: "qwen-3.8-max", name: "Qwen 3.8 Max", contextWindow: 1000000, maxOutput: 65536, reasoning: true, vision: false },
    { id: "GLM-5.3-Flash", name: "GLM 5.3 Flash", contextWindow: 1048576, maxOutput: 131072, reasoning: true, vision: true },
    { id: "qwen3.8-flash", name: "Qwen 3.8 Flash", contextWindow: 1000000, maxOutput: 131072, reasoning: true, vision: true },
    { id: "spark-x2.6", name: "Spark X2.6", contextWindow: 1048576, maxOutput: 131072, reasoning: true, vision: false },
    { id: "spark-x", name: "Spark X2.5", contextWindow: 1048576, maxOutput: 65536, reasoning: true, vision: false },
    { id: "mimo-v2.5", name: "MiMo V2.5", contextWindow: 1048576, maxOutput: 131072, reasoning: true, vision: true },
  ],
  strictModels: true,
  features: {
    usage: true,
    // The usage handler authenticates with the same pasted session, not a
    // separate console key.
    usageApikey: true,
  },
};
