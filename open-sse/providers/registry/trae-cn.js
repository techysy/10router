// Trae 国内站 (trae.cn, ByteDance marscode CN) registry entry — issue #99 拆线（方案 A）。
// 与国际站 (trae.js) 的账号 / refresh token 不互通（拿错端换必 20101），数据面与
// 账号面主机也完全分叉（#99 情报二），故拆为独立条目；CreditDaddy 账号同步按
// TENROUTER_PROVIDER_MAP 以 provider id 对接（qoder-cn / codebuddy-cn 同款约定）。
// Chat = SOLO remote agent API（与国际站同形态）:
//   POST {base}/chat_sessions → {data:{chat_session_id, message_id}}
//   GET  {base}/chat_sessions/{id}/events?reply_to_message_id=... → SSE
//   Auth: Authorization: Cloud-IDE-JWT <jwt>
export default {
  id: "trae-cn",
  alias: "trae-cn",
  uiAlias: "trae-cn",
  category: "oauth",
  authType: "oauth",
  hasOAuth: true,
  authModes: ["oauth"],
  display: {
    name: "Trae CN",
    icon: "bolt",
    color: "#FF6A00",
    textIcon: "TC",
    website: "https://www.trae.cn",
    notice: {
      signupUrl: "https://www.trae.cn/events/code-fission/6SJTRWPCAP5X?utm_source=copy_link&utm_medium=code_fission",
      apiKeyUrl: "https://www.trae.cn/events/code-fission/6SJTRWPCAP5X?utm_source=copy_link&utm_medium=code_fission",
    },
  },
  transport: {
    // 国内 web remote 数据面（#99 情报二，trae2api-hub / Trae2api-cn 双源实测）：
    // core-normal.trae.cn 不解析；api.trae.com.cn 只承接 CloudIDE/OAuth/pay，
    // /api/ide/* 打过去 404 —— 国内 SOLO remote 会话走 mchost.guru 网关。
    baseUrl: "https://trae-api-cn.mchost.guru/api/remote/v1",
    soloBaseUrlCn: "https://trae-api-cn.mchost.guru/api/remote/v1",
    format: "openai",
    headers: {
      "X-Trae-Client-Type": "web",
      "X-Preferenced-Language": "zh",
      "Referer": "https://www.trae.cn/",
    },
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "Cloud-IDE-JWT",
    },
    usage: {
      url: "https://api.trae.com.cn/cloudide/api/v3/trae/GetUserInfo",
    },
    regions: {
      cn: "https://api.trae.com.cn",
    },
    defaultRegion: "cn",
  },
  oauth: {
    clientId: "ono9krqynydwx5",
    clientSecret: "-",
    platform: "trae",
    pollInterval: 1500,
    // 国内站网关族：api.trae.com.cn / api.marscode.cn / api.trae.cn（#69 实测全部可用）。
    loginGuidanceUrl: "https://api.trae.com.cn/cloudide/api/v3/trae/GetLoginGuidance",
    tokenUrl: "https://api.trae.com.cn/cloudide/api/v3/trae/oauth/ExchangeToken",
    exchangeTokenUrl: "https://api.trae.com.cn/cloudide/api/v3/trae/oauth/ExchangeToken",
    refreshUrl: "https://api.trae.com.cn/cloudide/api/v3/trae/oauth/ExchangeToken",
    userInfoUrl: "https://api.trae.com.cn/cloudide/api/v3/trae/GetUserInfo",
    refresh: { encoding: "json" },
  },
  // 模型目录：显示名 / 倍率 / 标签按官方客户端 2026-11-27 实拍对齐（用户截图四张，
  // 倍率 = 官方「积分消耗速度」；上一轮 2026-11-09 口径已被官方换代覆盖）。
  // 官方清单没有的旧模型**删除**（用户明确要求：截图上没有的就删掉；老 combo 引用
  // 断了可重建，不留僵尸行）。数组顺序 = 官方下拉顺序（详情页照此渲染）。
  // 权威源说明：本轮**未能 live 验证**——Trae 没有可用的模型目录端点（executor 侧
  // 无 model_list 读取，CN 侧 model/list 属 IDE 通道需真号 + 未探明签名），读 NAS
  // 生产凭据又超出本次授权，故 4 张客户端截图即权威源，逐张放大复核后落表。
  // 标签字段口径（与 codebuddy-cn 同一套）：
  //   专属补贴 / 会员限时优惠 / 闲时折扣 都是**折扣型**（倍率非 0），用 discountNote
  //   承载规则说明——不亮 free 徽章（promoFree* 会亮 free，夸大）。
  //   官方下拉带锁的模型（解锁说明「该模型仅限 会员 Lite/会员 Pro/会员 Pro+/会员
  //   Ultra/会员 Express 用户，升级后即可解锁」）→ paidTier：GLM-5.4、
  //   Kimi-K3.1-Pro-Highspeed、Kimi-K3.1-Pro、Qwen4-Max 四行；带锁行官方不显示倍率，
  //   故一律**不放** rateMultiplier（不编价）。
  // 显示名去掉『Doubao 』前缀（官方列表就叫 Seed-2.1-Turbo）；id 不动（老 combo /
  // 连接引用不受影响）。
  // 两处易错判读（已逐张放大复核，留此防止下轮再翻）：
  //   · 0.12x 那行是 **DeepSeek-V4.1-Flash**，不是「V4.1-Hash」——另一张同位置写
  //     Flash，「H」是低分辨率下 `Fl` 粘连的假象，且 Trae 全线（含国际线）无 Hash。
  //   · 清单末尾是 Qwen3.8-Max，**没有** Kimi-K2.5（那一行属国际线，别加到 CN）。
  models: [
    { id: "Doubao-Seed-2.1-Turbo", name: "Seed-2.1-Turbo", rateMultiplier: 0.20, discountNote: "专属补贴：原价 0.40 倍，当前补贴 5 折至 0.20 倍；会员专享 2.5 折至 0.10 倍" },
    { id: "Doubao-Seed-2.1-Pro", name: "Seed-2.1-Pro-0915", rateMultiplier: 0.80 },
    { id: "Doubao-Seed-Evolving", name: "Seed-Evolving", rateMultiplier: 0.80 },
    { id: "Doubao-Seed-Code", name: "Seed-Code", rateMultiplier: 0.06, discountNote: "专属补贴：积分消耗 0.06 倍" },
    { id: "glm-5.4", name: "GLM-5.4", paidTier: true },
    { id: "glm-5.3-flash", name: "GLM-5.3-Flash", rateMultiplier: 0.08 },
    { id: "glm-5.3-flashx", name: "GLM-5.3-FlashX", rateMultiplier: 0.31 },
    { id: "glm-5.3", name: "GLM-5.3", rateMultiplier: 0.78 },
    { id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash", rateMultiplier: 0.12, discountNote: "闲时折扣：空闲时段消耗更低，官方未公布本档折扣幅度" },
    { id: "DeepSeek-V4-Pro-Official", name: "DeepSeek-V4-Pro", rateMultiplier: 0.72, discountNote: "闲时折扣：空闲时段 5 折 0.72→0.36 倍，空闲时段=北京时间每日 22:00-次日 8:00；另有「更大上下文（Max）」开关，开启后上下文扩展至 1M、积分消耗更多" },
    { id: "kimi-k3.1-pro-highspeed", name: "Kimi-K3.1-Pro-Highspeed", paidTier: true },
    { id: "kimi-k3.1-pro", name: "Kimi-K3.1-Pro", paidTier: true },
    { id: "kimi-k3", name: "Kimi-K3", rateMultiplier: 1.83 },
    { id: "mimo-v2.6-flash", name: "MiMo-V2.6-Flash", rateMultiplier: 0.06 },
    { id: "mimo-v2.6-pro", name: "MiMo-V2.6-Pro", rateMultiplier: 0.15 },
    { id: "minimax-m3.1-flash", name: "MiniMax-M3.1-Flash", rateMultiplier: 0.09 },
    { id: "minimax-m3", name: "MiniMax-M3", rateMultiplier: 0.26 },
    { id: "step-5-preview", name: "Step-5-Preview", rateMultiplier: 0.48 },
    { id: "qwen4-max", name: "Qwen4-Max", paidTier: true },
    { id: "qwen3.8-flash", name: "Qwen3.8-Flash", rateMultiplier: 0.08 },
    { id: "qwen3.8-max", name: "Qwen3.8-Max", rateMultiplier: 1.50 },
  ],
  features: { usage: true },
};
