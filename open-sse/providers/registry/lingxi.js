export default {
  id: "lingxi",
  priority: 185,
  alias: "lingxi",
  aliases: ["lx", "wps-lingxi"],
  uiAlias: "lingxi",
  display: {
    name: "WPS 灵犀",
    icon: "auto_awesome",
    color: "#E34D3F",
    textIcon: "灵犀",
    website: "https://lingxi.kdocs.cn",
  },
  category: "webCookie",
  authType: "cookie",
  serviceKinds: ["llm"],
  authHint:
    "Paste the full Cookie header of a logged-in lingxi.kdocs.cn session (wps_sid / kso_sid …). " +
    "Capture it in CreditDaddy's 网页会话 page and sync, or copy it from browser devtools. " +
    "No signature needed (the web client's X-Pop-Token is desktop-SDK-only). " +
    "While the session lives, 对话-mode turns do not deduct 灵点; the model multipliers only " +
    "bite on Pro/Max subscriptions.",
  transport: {
    baseUrl: "https://lingxi.kdocs.cn/solution/api/aigc/v3/assistant/sessions",
    format: "openai",
    authType: "cookie",
  },
  // `id` = exact upstream expect_model key (plans endpoint) or "auto" for the
  // server default; plan_pro/plan_max additionally switch to plan-mode.
  models: [
    { id: "auto", name: "自动 (Lingxi Auto)" },
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", multiplier: "~0.12x" },
    { id: "deepseek-v4-pro-0813", name: "DeepSeek V4 Pro", multiplier: "0.40x" },
    { id: "qwen3.8_flash", name: "Qwen3.8-Flash", multiplier: "~0.08x" },
    { id: "qwen3.8_max", name: "Qwen3.8-Max", multiplier: "~0.80x" },
    { id: "mimo-v2.6-pro", name: "Xiaomi MiMo-V2.6 Pro", multiplier: "0.10x" },
    { id: "GLM-5.3-Flash", name: "GLM 5.3 Flash", multiplier: "~0.11x" },
    { id: "GLM-5.3", name: "GLM 5.3", multiplier: "~0.75x" },
    { id: "minimax_m3", name: "MiniMax-M3", multiplier: "0.20x" },
    { id: "doubao_seed_2_1_pro_260628", name: "Doubao Seed 2.1 Pro", multiplier: "~0.50x" },
    { id: "kimi-k3.1-pro", name: "Kimi K3.1 Pro", multiplier: "~1.10x" },
    { id: "kimi-k3", name: "Kimi K3", multiplier: "1.60x" },
    { id: "plan_pro", name: "Pro 模式" },
    { id: "plan_max", name: "Max 模式" },
  ],
  passthroughModels: true,
};
