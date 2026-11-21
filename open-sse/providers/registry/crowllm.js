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
  models: [
    { id: "qwen4-max:free", name: "Qwen 4 Max (Free)" },
    { id: "grok-4.7:free", name: "Grok 4.7 (Free)" },
    { id: "glm-5.3-flash:free", name: "GLM 5.3 Flash (Free)" },
    { id: "deepseek-v4-flash-0731:free", name: "DeepSeek V4 Flash 0731 (Free)" },
  ],
};
