// MiniMax Code 免费体验包（算力币，MiniMax-M3）→ CreditDaddy 本地网关。
// 上游是 MiniMax Code 的标准 Anthropic Messages 协议（CreditDaddy 侧转发）：
//   POST http://127.0.0.1:<port>/gateway/minimax/v1/messages
//   （上游 https://agent.minimax.cn/mavis/api/v1/llm/v1/messages，模型透传）
// CreditDaddy 负责账号多路轮换、401 自动 OAuth 刷新、429 冷却、局域网白名单
// 与每日签到（CD 内已闭环）；本条目只做端点映射。模型面对齐当前订阅双线的
// 正式目录（issue #75 回归）。
// 前提：CreditDaddy 桌面版运行 + 面板「MiniMax 网关」开启 + 已添加 MiniMax 账号；
// 无账号时网关按轮换队列为空处理（错误文案会说明）。
export default {
  id: "minimax-free",
  priority: 57,
  alias: "minimax-free",
  aliases: ["mmcf"],
  uiAlias: "minimax-free",
  display: {
    name: "MiniMax Code Free",
    icon: "bolt",
    color: "#FF4D00",
    textIcon: "MM",
    website: "https://agent.minimax.cn",
  },
  category: "free",
  noAuth: true,
  community: true,
  // 无连接行（noAuth），注册表模型需要显式开关才会进 /v1/models ——
  // 不加此旗标会让既有 noAuth 供应商的模型自动冒出来
  exposeStaticModels: true,
  transport: {
    baseUrl: "http://127.0.0.1:47860/gateway/minimax/v1/messages",
    format: "claude",
    noAuth: true,
  },
  models: [
    // 正式 id 优先；`-Preview` 过渡期已结束（与订阅双线同口径，issue #70/#75），
    // 2026-11-25 下架。CreditDaddy 网关按 id 透传，写着旧 id 的存量请求照样发出。
    { id: "MiniMax-M3.1-Flash", name: "MiniMax M3.1 Flash" },
    { id: "MiniMax-M3", name: "MiniMax M3" },
    { id: "MiniMax-M2.7-highspeed", name: "MiniMax M2.7 Highspeed" },
    { id: "MiniMax-M2.7", name: "MiniMax M2.7" },
  ],
};
