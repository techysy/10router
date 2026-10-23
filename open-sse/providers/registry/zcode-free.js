// ZCode 免费体验包（Start Plan / Trust Build，GLM-5.3-Flash；2026-10-23 1024 Dev Day
// 起体验包加送 GLM-5.3，200M/日）→ CreditDaddy 本地网关。
// 上游是 CreditDaddy 桌面版（techysy/CreditDaddy）的「体验包接口」（面板旧称「额度网关」）：
//   POST http://127.0.0.1:<port>/gateway/zcode/v1/messages（Anthropic 形态）
// 它负责账号轮换 + 隐藏窗口静默过阿里云验证码；本条目只做端点映射，模型面固定。
// 前提：CreditDaddy 桌面版运行 + 面板「体验包接口」开启；纯 CLI / NAS 无验证码提供者时
// 网关返回 503（错误文案会说明）。体验包额度只存在于 zcode.z.ai plan 端点（3007 风控），
// 标准端点不可用——详见 docs/zh-CN/archive/zcode-plan-proxy-feasibility.md。
export default {
  id: "zcode-free",
  priority: 56,
  alias: "zcode-free",
  uiAlias: "zcode-free",
  display: {
    name: "ZCode Free",
    icon: "rocket_launch",
    color: "#7C3AED",
    textIcon: "ZC",
    website: "https://zcode.z.ai",
  },
  category: "free",
  noAuth: true,
  community: true,
  // 无连接行（noAuth），注册表模型需要显式开关才会进 /v1/models ——
  // 不加此旗标会让 opencode / mimo-free 等既有 noAuth 供应商的模型自动冒出来
  exposeStaticModels: true,
  transport: {
    baseUrl: "http://127.0.0.1:47860/gateway/zcode/v1/messages",
    format: "claude",
    noAuth: true,
  },
  models: [
    { id: "glm-5.3-flash", name: "GLM 5.3 Flash" },
    // GLM-5.3 thinking 不可关闭（canonical 能力行已标 thinkingCanDisable:false），
    // 与 glm.js / glm-cn.js 同 id 同能力，CreditDaddy 原样转发 model 字段。
    { id: "glm-5.3", name: "GLM 5.3" },
  ],
};
