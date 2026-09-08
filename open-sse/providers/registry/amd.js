// AMD Token Factory (Radeon Cloud) — free shared OpenAI-compatible endpoints.
// Docs: https://amd-aim.github.io/radeon-cloud-docs/ · key auto-issued on the
// Token Factory page (rc-… Bearer). Free tier: 30 RPM/key (20 RPM/account),
// 8 concurrent per key; models are text-only and marked experimental upstream.
export default {
  id: "amd",
  priority: 20,
  hasFree: true,
  alias: "amd",
  display: {
    name: "AMD Token Factory",
    icon: "developer_board",
    color: "#ED1C24",
    textIcon: "AMD",
    website: "https://developer.amd.com.cn/radeon/tokenfactory",
    notice: {
      text: "Free shared endpoints (experimental) — 30 RPM per key, 8 concurrent.",
      apiKeyUrl: "https://developer.amd.com.cn/radeon/modelapis",
    },
  },
  category: "freeTier",
  authType: "apikey",
  authModes: ["apikey"],
  transport: {
    baseUrl: "https://developer.amd.com.cn/radeon/api/v1/chat/completions",
    validateUrl: "https://developer.amd.com.cn/radeon/api/v1/models",
  },
  models: [
    { id: "DeepSeek-V4-Flash", name: "DeepSeek V4 Flash" },
    { id: "Qwen3.8-Flash-Next", name: "Qwen3.8 Flash Next" },
  ],
};
