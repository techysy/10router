// 商汤小浣熊 (SenseTime Raccoon, xiaohuanxiong.com) — 微信扫码 OAuth 登录，
// OpenAI 兼容推理网关 xiaohuanxiong.com/api/web/llm/v2，DefaultExecutor 直走 transport。
//
// 登录链路（逆自官网 + 微信小程序路径，实测 2026-11-24）：
//   POST /api/iam/v1/auth/mp/qrcode  {} -> {data:{qrcode_code, scan_path:"/login/mp", ...}}
//   QR 内容 = https://xiaohuanxiong.com/login/mp?code=<qrcode_code>（微信扫开小程序）
//   轮询 POST /api/iam/v1/auth/mp/qrcode/login {qrcode_code}
//        -> {status:"success", access_token} / pending / logging / canceled / AUTH_QRCODE_EXPIRED
//   拿到的 IAM token 须再 POST /api/web/auth/v1/iam/confirm {} 激活，LLM API 才认
//   （否则 200901 iam_confirm_required）。IAM JWT iss=xiaohuanxiong.com/iam，~30d，
//   无 refresh_token。桌面端的 login_with_qrcode_code 是另一条线，对微信扫码永不翻转。
//
// 配额跟踪器（usage:true）：GET /api/web/points/v1/balance + /api/web/points/v1/tasks。
// 积分是任务制+邀请制（注册/桌面/移动登录、拉新），自动发放，无签到/claim 端点。
export default {
  id: "xiaohuanxiong",
  priority: 88,
  alias: "xhx",
  uiAlias: "xhx",
  display: {
    name: "商汤小浣熊",
    icon: "pets",
    color: "#E8590C",
    textIcon: "浣",
    website: "https://xiaohuanxiong.com",
    notice: {
      signupUrl: "https://xiaohuanxiong.com",
      text: "微信扫码登录（小浣熊小程序内确认）。IAM token ~30 天有效，过期重新扫码即可。积分按任务/邀请自动发放，配额跟踪器显示积分余额与任务进度。",
    },
  },
  category: "oauth",
  authModes: ["oauth"],
  hasOAuth: true,
  transport: {
    // buildUrl 对非 openai-compatible/anthropic-compatible provider 原样返回
    // baseUrl（不追加路径），所以这里必须含 /chat/completions。
    baseUrl: "https://xiaohuanxiong.com/api/web/llm/v2/chat/completions",
    validateUrl: "https://xiaohuanxiong.com/api/web/llm/v2/model_catalog",
    format: "openai",
  },
  features: {
    usage: true,
  },
  passthroughModels: true,
  models: [
    { id: "raccoon-090dd3", name: "Raccoon 090dd3" },
    { id: "raccoon-19b265", name: "Raccoon 19b265" },
    { id: "raccoon-405a1c", name: "Raccoon 405a1c" },
    { id: "sn-sensenova-6-8-flash", name: "SenseNova 6.8 Flash" },
    { id: "sn-sensenova-6-8-flash-lite", name: "SenseNova 6.8 Flash Lite" },
    { id: "sn-qwen4-max", name: "Qwen4 Max" },
    { id: "sn-glm-5-3", name: "GLM 5.3" },
    { id: "sn-glm-5-3-flash", name: "GLM 5.3 Flash" },
    { id: "sn-kimi-k3-1-pro", name: "Kimi K3.1 Pro" },
    { id: "sn-deepseek-v4-1-flash-1017", name: "DeepSeek V4.1 Flash" },
  ],
  oauth: {
    apiBaseUrl: "https://xiaohuanxiong.com",
    authApiBase: "https://xiaohuanxiong.com/api/web/auth/v1",
    iamApiBase: "https://xiaohuanxiong.com/api/iam/v1",
    // mp 扫码登录端点（server-issued qrcode_code）
    qrcodeCreateUrl: "https://xiaohuanxiong.com/api/iam/v1/auth/mp/qrcode",
    qrcodePollUrl: "https://xiaohuanxiong.com/api/iam/v1/auth/mp/qrcode/login",
    iamConfirmUrl: "https://xiaohuanxiong.com/api/web/auth/v1/iam/confirm",
    // 兜底授权码流（桌面客户端 deep-link 路径，paste-code 用）
    authorizeUrl: "https://xiaohuanxiong.com/code/authorize",
    tokenUrl: "https://xiaohuanxiong.com/api/web/auth/v1/login_with_authorization_code",
    refreshUrl: "https://xiaohuanxiong.com/api/web/auth/v1/refresh",
    clientId: "raccoon-desktop",
    callbackPath: "/auth/callback",
  },
};
