// CrowLLM (crowllm.com) — one-hub/new-api 系模型中转聚合站（2026-11-21 调研，
// 全部信息来自公开 /api/status、/api/pricing、/v1/models 与端点探测）。
//
// 形态：OpenAI 兼容网关（API 与站点同域 https://crowllm.com/v1/*），Bearer
// apiKey（sk- 前缀惯例）。站内货币 CC、one-api 倍率计价，`:free` 后缀即零倍率
// 免费模型（40 个）。/v1/models 公开可拉（183 个模型、19 家厂商），故静态条目
// 只锚定重点免费模型 + passthroughModels 透传动态全量。
//
// ⚠️ qwen4-max 只有 `:free` 版（model_ratio=0），没有付费版 qwen4-max —— 用户
// 点名的就是这个。该模型 24h 实测成功率 91.26%、平均延迟 27.5s（偏慢）。
//
// 无签到/每日赠送机制（checkin_enabled=false，服务端开关下发）→ 不接每日任务
// 调度器。注册页带 Cloudflare Turnstile 人机验证，但 /api/* 与 /v1/* 接口当前
// 裸 curl 直通（服务端调用不受盾影响；CF 规则可能变，接入后要观测）。
//
// /v1/messages 端点存在（假 key 回鉴权错误而非 404）但官方 supported_endpoint
// 矩阵未列 anthropic → 暂按纯 OpenAI 协议接入，claude 协议面待真 key 实测。
//
// /console/token 是 one-hub 家族惯例 key 页路径（SPA 无法无浏览器渲染验证，
// 未实锤）。
// 邀请码池（用户 2026-11-21 提供，4 条）：获取 API 入口每次读取随机取一条，
// 归因分散——与 croli 同款。getter 在 provider 信息被 JSON 序列化（面板 API）时
// 求值一次，即每次页面加载换一条；后续加码直接往数组里补。
const CROWLLM_INVITE_LINKS = [
  "https://crowllm.com/sign-up?aff=xGk0",
  "https://crowllm.com/sign-up?aff=quJ8",
  "https://crowllm.com/sign-up?aff=tEjJ",
  "https://crowllm.com/sign-up?aff=6CNM",
  "https://crowllm.com/sign-up?aff=T9Tu",
];
const pickInviteLink = () => CROWLLM_INVITE_LINKS[Math.floor(Math.random() * CROWLLM_INVITE_LINKS.length)];
export default {
  id: "crowllm",
  priority: 34,
  alias: "crowllm",
  uiAlias: "crowllm",
  display: {
    name: "CrowLLM",
    icon: "api",
    color: "#2563eb",
    website: "https://crowllm.com",
    notice: {
      text: "CrowLLM is an OpenAI-compatible gateway (one-hub family) with 180+ models; models suffixed :free cost nothing. Register with email/Google/GitHub/Discord, then create a key in the console.",
      signupUrl: "https://crowllm.com/sign-up",
      // 获取 API 入口 = 邀请码池轮换（文件头 CROWLLM_INVITE_LINKS）。
      // /console/token 是 one-hub 家族惯例 key 页路径，SPA 无法无浏览器渲染验证、
      // 未实锤，弃用。
      get apiKeyUrl() {
        return pickInviteLink();
      },
    },
  },
  // 免费额度组（free + freeTier 合并渲染成「免费」列表）——apikey 接入 +
  // :free 零倍率模型正是 freeTier 语义（deepai/dots/api-airforce 同组）；
  // free 组是 noAuth 直连型，不适用。authModes 保持 apikey（详情页对
  // freeTier+apikey 的连接渲染是现成路径）。
  category: "freeTier",
  authModes: ["apikey"],
  authType: "apikey",
  transport: {
    baseUrl: "https://crowllm.com/v1/chat/completions",
    validateUrl: "https://crowllm.com/v1/models",
    headers: {},
    timeoutMs: 120000,
  },
  modelsFetcher: { url: "https://crowllm.com/v1/models", type: "openai" },
  passthroughModels: true,
  // :free 全量锚定（2026-11-21 实拉 /v1/models，40 个，零倍率、免费目录 $110 全可用）。
  // 锚定进 providerModels 矩阵才能被路由/翻译覆盖/能力审计覆盖，动态透传只在面板可见。
  // 赠送额度只能打免费目录（钱包页口径），付费模型不在本表。
  models: [
    { id: "caw/glm-5.3-flash-thinking:free", name: "GLM 5.3 Flash Thinking (Free)" },
    { id: "caw/glm-5.3-flash:free", name: "GLM 5.3 Flash (Free)" },
    { id: "deepseek-v4-flash-0731-thinking:free", name: "DeepSeek V4 Flash 0731 Thinking (Free)" },
    { id: "deepseek-v4-flash-0731:free", name: "DeepSeek V4 Flash 0731 (Free)" },
    { id: "dots-3-note-preview:free", name: "Dots 3 Note Preview (Free)" },
    { id: "ernie-5.5-flash-preview:free", name: "ERNIE 5.5 Flash Preview (Free)" },
    { id: "flint-v1.0:free", name: "Flint 1.0 (Free)" },
    { id: "glm-4.6v-flash:free", name: "GLM 4.6V Flash (Free)" },
    { id: "glm-4.7-flash:free", name: "GLM 4.7 Flash (Free)" },
    { id: "glm-5.3-flash:free", name: "GLM 5.3 Flash (Free)" },
    { id: "grok-4.7-fast:free", name: "Grok 4.7 Fast (Free)" },
    { id: "grok-4.7:free", name: "Grok 4.7 (Free)" },
    { id: "hy4-flash:free", name: "HY4 Flash (Free)" },
    { id: "jais-3-mova-36b-a4b:free", name: "Jais 3 Mova 36B A4B (Free)" },
    { id: "k2-horizon-375b-a23b:free", name: "K2 Horizon 375B A23B (Free)" },
    { id: "laguna-xs-2.1-uncensored:free", name: "Laguna XS 2.1 Uncensored (Free)" },
    { id: "laguna-xs-2.1:free", name: "Laguna XS 2.1 (Free)" },
    { id: "liquid/lfm-2.5-2.6b-thinking:free", name: "LFM 2.5 2.6B Thinking (Free)" },
    { id: "liquid/lfm-2.5-2.6b:free", name: "LFM 2.5 2.6B (Free)" },
    { id: "llama-3.3-70b-instruct:free", name: "Llama 3.3 70B Instruct (Free)" },
    { id: "llama-3.3-70b:free", name: "Llama 3.3 70B (Free)" },
    { id: "longcat-2.5:free", name: "LongCat 2.5 (Free)" },
    { id: "minimax-m3.1-flash:free", name: "MiniMax M3.1 Flash (Free)" },
    { id: "nemotron-3-ultra-550b-a55b-uncensored:free", name: "Nemotron 3 Ultra 550B Uncensored (Free)" },
    { id: "nemotron-3-ultra-550b-a55b:free", name: "Nemotron 3 Ultra 550B (Free)" },
    { id: "nemotron-3.5-super-vl:free", name: "Nemotron 3.5 Super VL (Free)" },
    { id: "nvidia/mistral-large-4-1t-a52b:free", name: "Mistral Large 4 1T A52B (Free)" },
    { id: "nvidia/nemotron-3.5-bolt-e4b:free", name: "Nemotron 3.5 Bolt E4B (Free)" },
    { id: "nvidia/nemotron-3.5-super-vl-120b-a12b:free", name: "Nemotron 3.5 Super VL 120B (Free)" },
    { id: "openai/gpt-oss-20b:free", name: "GPT-OSS 20B (Free)" },
    { id: "openai/gpt-oss-safeguard-20b:free", name: "GPT-OSS Safeguard 20B (Free)" },
    { id: "particle-1:free", name: "Particle 1 (Free)" },
    { id: "qwen-3.5-397b-a17b:free", name: "Qwen 3.5 397B A17B (Free)" },
    { id: "qwen-3.6-27b:free", name: "Qwen 3.6 27B (Free)" },
    { id: "qwen-3.8-27b:free", name: "Qwen 3.8 27B (Free)" },
    { id: "qwen3-8-omni-flash:free", name: "Qwen3 8 Omni Flash (Free)" },
    { id: "qwen4-max:free", name: "Qwen 4 Max (Free)" },
    { id: "solar-mini4:free", name: "Solar Mini4 (Free)" },
    { id: "step-5-preview:free", name: "Step 5 Preview (Free)" },
    { id: "xing4.0-29b-a4b:free", name: "Xing 4.0 29B A4B (Free)" },
  ],
};
