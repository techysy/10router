// Trae SOLO 远程 Agent（字节跳动 Trae）→ CreditDaddy 本地网关。
// 上游是 CreditDaddy 桌面版（techysy/CreditDaddy）的「Trae 网关」接口：
//   POST http://127.0.0.1:<port>/gateway/trae/v1/messages（Anthropic Messages 形态）
//   （网关内部转换为 https://solo.trae.cn/api/remote/v1 的 SOLO agent 会话协议）
// CreditDaddy 负责账号多路 SWRR 轮换、401 凭据热对齐、429 限流冷却与局域网白名单；
// 本条目做端点映射与模型面接入，支持思考流（thinking_delta）与用量回报。
// 前提：CreditDaddy 桌面版运行 + 面板「Trae 网关」开启 + 已添加 Trae (SOLO) 账号；
// 无账号时网关按轮换队列为空处理（503 提示）。
export default {
  id: "trae-free",
  priority: 58,
  alias: "trae-free",
  uiAlias: "trae-free",
  display: {
    name: "Trae Free",
    icon: "bolt",
    color: "#FF6A00",
    textIcon: "TF",
    website: "https://www.trae.ai",
  },
  category: "free",
  noAuth: true,
  community: true,
  // 无连接行（noAuth），注册表模型需要显式开关才会进 /v1/models ——
  // 不加此旗标会让既有 noAuth 供应商的模型自动冒出来
  exposeStaticModels: true,
  transport: {
    baseUrl: "http://127.0.0.1:47860/gateway/trae/v1/messages",
    format: "claude",
    noAuth: true,
  },
  // 模型目录对齐 TRAE 2.3.87413 官方 remote（Work / SOLO Agent，2026-10-10 采集，#54）：
  //   新增 18 款（GLM-5.3 系 / MiMo-V2.6 / Kimi-K3 / DeepSeek Official 变体 / Step-5-Preview 等）；
  //   保留 Doubao-Seed-Code（当前默认）与 kimi-k2.6；
  //   移除已从 remote 目录下架的 10 款（2.0-Code/m2.7/glm-5 系/V4 基础版/k2.5/3.6/3.5）。
  models: [
    { id: "Doubao-Seed-Code", name: "Doubao Seed Code" },
    { id: "Doubao-Seed-2.1-Pro", name: "Doubao Seed 2.1-Pro" },
    { id: "Doubao-Seed-2.1-Turbo", name: "Doubao Seed 2.1-Turbo" },
    { id: "Doubao-Seed-Evolving", name: "Doubao Seed Evolving" },
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1-Flash" },
    { id: "DeepSeek-V4-Flash-Official", name: "DeepSeek V4-Flash Official" },
    { id: "DeepSeek-V4-Pro-Official", name: "DeepSeek V4-Pro Official" },
    { id: "glm-5.2", name: "GLM 5.2" },
    { id: "glm-5.3", name: "GLM 5.3" },
    { id: "glm-5.3-flash", name: "GLM 5.3-Flash" },
    { id: "glm-5.3-flashx", name: "GLM 5.3-FlashX" },
    { id: "mimo-v2.6-flash", name: "MiMo V2.6-Flash" },
    { id: "mimo-v2.6-pro", name: "MiMo V2.6-Pro" },
    { id: "kimi-k2.6", name: "Kimi K2.6" },
    { id: "kimi-k2.7-code", name: "Kimi K2.7-Code" },
    { id: "kimi-k3", name: "Kimi K3" },
    { id: "minimax-m3", name: "MiniMax M3" },
    { id: "qwen-3.7-plus", name: "Qwen 3.7-Plus" },
    { id: "qwen3.8-max", name: "Qwen 3.8-Max" },
    { id: "step-5-preview", name: "Step 5-Preview" },
  ],
};
