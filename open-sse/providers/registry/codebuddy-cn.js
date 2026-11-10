export default {
  id: "codebuddy-cn",
  // Short model prefix (cbcn/glm-5.2). "cbcn" = CodeBuddy CN; reserve "cbai"
  // for a future codebuddy-ai (intl) provider. The full id still resolves.
  alias: "cbcn",
  uiAlias: "cbcn",
  hidden: false,
  priority: 90,
  display: {
    name: "CodeBuddy CN",
    icon: "smart_toy",
    color: "#006EFF",
    website: "https://copilot.tencent.com",
    notice: {
      signupUrl: "https://copilot.tencent.com",
      // 网页版 = 在线 agent 页面(WorkBuddy 工作台);积分/用量控制台仍在
      // signupUrl(copilot.tencent.com)——provider 页右上角按钮指向 webUrl,
      // 替代默认的 "Get API Key"(该渠道的密钥本来就不走自动认证引导)。
      webUrl: "https://www.workbuddy.cn/app",
    },
  },
  category: "oauth",
  authModes: ["oauth", "apikey"],
  hasOAuth: true,
  transport: {
    baseUrl: "https://copilot.tencent.com/v2/chat/completions",
    forceStream: true,
    // CodeBuddy is a unified OpenAI-compatible gateway: every model (GLM, Kimi,
    // MiniMax, DeepSeek, Hunyuan) takes reasoning via OpenAI-style reasoning_effort,
    // not its vendor-native thinking shape. Force the openai thinking format.
    thinkingFormat: "openai",
    quirks: {
      // Root-level tool `parameters` must be a concrete type:"object"; the
      // upstream answers 400 {code:11129 "invalid function call parameters"}
      // for a root anyOf/oneOf/allOf/$ref/type-array/missing-type. chatCore
      // downgrades tool schemas for providers declaring this quirk. See
      // translator/concerns/toolCall.js and issue #27.
      sanitizeToolSchema: true,
    },
    headers: {
      // 2026-11-11 对齐官方 CLI 2.182.0（npm @tencent-ai/codebuddy-code，解包
      // 分析其请求头构造）：新版不再发 "CLI/x.y.z CodeBuddy/x.y.z" 形态的 UA，
      // 版本信息改走 X-IDE-Version / X-Client-Version / X-Product-Version 独立头。
      // 过渡期双发：旧 UA 保留（现网实测仍 200，WAF 尚未拒），新头补齐 ——
      // 上游不认识的头会忽略，认识的规则得到满足。旧 UA 被拒时删掉那行即可。
      "User-Agent": "CLI/2.182.0 CodeBuddy/2.182.0",
      "X-Product": "SaaS",
      "X-IDE-Type": "CLI",
      "X-IDE-Name": "CLI",
      "X-IDE-Version": "2.182.0",
      "X-Client-Version": "2.182.0",
      "X-Product-Version": "2.182.0",
      "x-requested-with": "XMLHttpRequest",
      "x-codebuddy-request": "1",
    },
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
    },
    // Quota endpoint differs from the chat gateway: POST returns nested Tencent
    // billing payload (data.Response.Data.Accounts[]). See services/usage/codebuddy-cn.js.
    usage: {
      url: "https://copilot.tencent.com/v2/billing/meter/get-user-resource",
    },
  },
  // Catalog mirrors the model/credit list published on copilot.tencent.com.
  // Models the server no longer lists are removed even when the chat endpoint
  // still answers them — the published list is the contract. Drop log:
  // glm-5.0 / glm-4.7 and hy4-preview-x (endpoint returns 11102 "model service
  // info not found", see docs/zh-CN/codebuddy-cn-error-codes.md), plus
  // glm-5.0-turbo / minimax-m2.7 / kimi-k2.5 / hy3-preview / deepseek-v3-2-volc
  // (absent from the server list, though still answering 200), hy3-x (paid
  // tier, not used here), kimi-k3-1 (spurious duplicate slot — the server lists
  // only kimi-k3) and deepseek-v4-flash (superseded by deepseek-v4.1-flash).
  // "-x" suffix = paid tier of the same model (free id rides the promo quota).
  // rateMultiplier = credit cost multiplier published on the CN credit page
  // (0 = rides the free quota). CN and intl share one credit system, so models
  // present on both carry identical multipliers. Rendered as a badge by ModelRow.
  // 2026-11-05 全量对齐 CN 客户端模型清单（用户提供截图，即完整列表）：
  // 旧一代模型一律移除，只保留下面这张表。倍率取客户端「消耗速度」一栏。
  // 标签含义：
  //   · 限时免费 —— promoFreeUntil（带原价，到期自动回落）
  //   · 夜间折扣 —— nightFree 时段
  //   · 错峰使用 —— 工作日高峰原价 / 非高峰折扣
  //   · 订阅优先 —— subPriority
  models: [
    { id: "auto", name: "Auto" },
    // ⚠️ 命名口径：客户端卡片上的「300K / 1M」（上下文窗口档位）与 High / Max /
    // Medium（思考档位展示）是**卡片 UI 的一部分，不是模型名**——name 只抄型号
    // 本体（如 Hy4、GLM-5.3）。11-05 对齐时曾把整串文案抄进 name（
    // "GLM-5.3 300K High"），连 /v1/models 的显示名都带上 300K，已纠正。
    // Hy4：客户端卡片「Hy4 300K High」+ 红色 `new` 标签（标签也不是名字的一部分）。
    // 用**正式 id `hy4`**而不是过渡期的 `hy4-preview`：预览版仍在应答，但注册表
    // 只跟随客户端的当前型号（2026-11-05 现网探测两者均 200，取新版）。
    // 同屏 0.00x（限时免费）与 0.29x（原价），故保留原价 + 限免窗口。
    // 客户端已不再显示 23:00–08:00 夜间免费，故不再带 nightFree。
    { id: "hy4", name: "Hy4", rateMultiplier: 0.29, promoFreeUntil: "2026-11-15T00:00:00+08:00", promoFreeNote: "每日赠送免费额度" },
    // Hy3：卡片文案「7月6日-11月15日，每日赠送免费额度」——是**每日赠送额度**，
    // 用完后按 0.05x 计费，不是整段免费。故带 promoFreeUntil 让 badge 在窗口内
    // 显示 free，同时保留 0.05x 作为原价；promoFreeNote 把「每日赠送」这层
    // 额度口径带到悬停提示里，避免被读成整段无限免费。
    { id: "hy3", name: "Hy3", rateMultiplier: 0.05, promoFreeUntil: "2026-11-15T00:00:00+08:00", promoFreeNote: "每日赠送免费额度" },
    // Space-Bunny：官方应用（WorkBuddy 工作台）上架的"匿名大模型"，原生多模态
    // 输入、1M 上下文、编码向。0.03x 是首周折扣，2026-10-08 积分页回填正式价 0.08。
    { id: "space-bunny", name: "Space-Bunny", rateMultiplier: 0.08 },
    // GLM 三档：客户端 2026-11-05 倍率 5.3 / 5.3-Flash / 5.2 = 0.69 / 0.08 / 0.79。
    // 5.3 与 5.3-Flash 带「订阅优先」；5.2 的「夜间折扣」是**立减**不是免费
    // （nightFree 徽章会亮 free，夸大），故用 discountNote 说明。
    { id: "glm-5.3", name: "GLM-5.3", rateMultiplier: 0.69, subPriority: true },
    { id: "glm-5.3-flash", name: "GLM-5.3-Flash", rateMultiplier: 0.08, subPriority: true },
    { id: "glm-5.2", name: "GLM-5.2", rateMultiplier: 0.79, discountNote: "每晚 23:00—次日 8:00 积分限时立减，非高峰错峰更省" },
    { id: "minimax-m3.1-flash", name: "MiniMax-M3.1-Flash", rateMultiplier: 0.08 },
    // 2026-10-08 现网探测：hy5-preview / glm-5.4 / kimi-k2.7-code / muse-spark-1.3
    // 回 11102。minimax-m2.7 当日曾按「返回 200 且回显自身 id」短窗收录，
    // 2026-10-10 撤下——从不在服务端公布列表、倍率从未公布、使用量近乎零。
    { id: "kimi-k3.1-pro", name: "Kimi-K3.1-Pro", rateMultiplier: 0.97 },
    { id: "kimi-k3", name: "Kimi-K3", rateMultiplier: 1.62 },
    // 2026-10-08 积分页列出 Kimi-K2.8-Preview 0.77x，现网探测答 200（kimi-k2.8
    // 与 kimi-k2-8-preview 都是 11102，id 带 .8-preview）。国际线同样有该 id。
    { id: "kimi-k2.8-preview", name: "Kimi-K2.8-Preview", rateMultiplier: 0.77, subPriority: true },
    // 2026-11-05 现网探测：`xiaomi-mimo-v2.6-pro` → 11102，真身是 `mimo-v2.6-pro`（200）。
    // 官方卡片名带厂商前缀「Xiaomi MiMo-V2.6-Pro」（与 trae-cn 的 Doubao 前缀不同，
    // 那次是官方列表本就没有前缀才删；这里官方就这么叫，保留）。
    { id: "mimo-v2.6-pro", name: "Xiaomi MiMo-V2.6-Pro", rateMultiplier: 0.13 },
    // 官方积分页 2026-10-02 已将此模型回调至 0.11x（曾为首周 0.03x 尝鲜价）。
    // StepFun 的 Step-5-Preview,2026-10-09 积分页 0.43x + "订阅优先"标签,
    // 上下文 UI 可选 300/600/1M。⚠️ 本机免费账号探测:step-5-preview /
    // step5-preview / step-5 / step5 / stepfun-5-preview / Step-5-Preview(UI 原样)/
    // step-5-preview-x 等 17 种写法**全部回 11102**,与瞎编的对照 id 同判定(同批
    // glm-5.3 / deepseek-v4.1-flash 回 200,判定器正常)。按账号档位差异收录——
    // 与 intl 的 Claude 线同一判断,同样未经本账号验证。
    { id: "step-5-preview", name: "Step-5-Preview", rateMultiplier: 0.33 },
    // 两张 DeepSeek 卡的「夜间折扣」都是**立减**（工作日 09:00–12:00、14:00–18:00
    // 高峰原价，非高峰 5 折）——不是免费窗口，nightFree 徽章会亮 free 夸大，
    // 故用 discountNote 说明。V4.1-Flash 已更新至 -1017 最新版（1M 窗口、原生多模态）。
    { id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash", rateMultiplier: 0.11, discountNote: "周一至周五 09:00-12:00、14:00-18:00 属高峰原价，非高峰期积分5折" },
    { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", rateMultiplier: 0.51, discountNote: "周一至周五 09:00-12:00、14:00-18:00 属高峰原价，非高峰期积分5折" },
    // NOTE: the GPT/Gemini family (gpt-5.6-sol/terra/luna, gpt-5.5, gpt-5.4,
    // gpt-5.3-codex, gemini-3.5-flash) belongs to CodeBuddy *international*
    // (codebuddy.ai) ONLY — copilot.tencent.com never published them, and the
    // CN capabilities map below has no entry for them either. Do not re-add
    // them here; they live in registry/codebuddy-intl.js.
  ],
  oauth: {
    baseUrl: "https://copilot.tencent.com",
    stateUrl: "https://copilot.tencent.com/v2/plugin/auth/state",
    tokenUrl: "https://copilot.tencent.com/v2/plugin/auth/token",
    refreshUrl: "https://copilot.tencent.com/v2/plugin/auth/token/refresh",
    // OAuth 轮询的 UA 与 transport 同步升到 2.182.0。
    userAgent: "CLI/2.182.0 CodeBuddy/2.182.0",
    platform: "CLI",
    pollInterval: 5000,
  },
  features: {
    usage: true,
    usageApikey: true,
  },
};
