// AMD Token Factory (Radeon Cloud) — free shared OpenAI-compatible endpoints.
// Docs: https://amd-aim.github.io/radeon-cloud-docs/ · key auto-issued on the
// Token Factory page (rc-… Bearer). Free tier: 30 RPM/key (20 RPM/account),
// 8 concurrent per key; every model is marked experimental upstream.
//
// The catalog is identical for every key and live at GET /v1/models — AMD asks
// callers to reconcile against it at runtime instead of hardcoding names, so the
// seed below is only a starting point. Two entries take images (verified against
// the live endpoint: prompt_tokens_details.image_tokens > 0) —
// DeepSeek-V4-Flash-Vision-Exp and Qwen3.8-Flash-Next; the rest are text-only.
// MinerU2.5-Pro is deliberately not listed: it is OCR-only (output_modalities
// ["ocr"], charged per page) and takes no chat request.
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
    { id: "DeepSeek-V4-Flash-Vision-Exp", name: "DeepSeek V4 Flash Vision (Exp)" },
    { id: "Qwen3.8-Flash-Next", name: "Qwen3.8 Flash Next" },
    { id: "MiniCPM5-2B", name: "MiniCPM5 2B" },
  ],
};
