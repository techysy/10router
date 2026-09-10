export default {
  id: "opencode-go",
  priority: 210,
  alias: "opencode-go",
  aliases: [
    "ocg",
  ],
  uiAlias: "ocg",
  display: {
    name: "OpenCode Go",
    icon: "terminal",
    color: "#E87040",
    textIcon: "OC",
    website: "https://opencode.ai/auth",
    notice: {
      text: "OpenCode Go subscription: $5/mo (then  0/mo). Access to Kimi, GLM, Qwen, MiMo, MiniMax models.",
      apiKeyUrl: "https://opencode.ai/auth",
    },
  },
  category: "apikey",
  features: {
    usage: true,
    usageApikey: true,
  },
  // Refresh Official Models pulls the live authenticated /v1/models endpoint;
  // the checked-in catalog below is only a fallback seed.
  transport: {
    baseUrl: "https://opencode.ai/zen/go/v1/chat/completions",
    headers: {},
  },
  // Multi-endpoint: pick the transport matching the client sourceFormat to skip
  // translation. Guarded per-model by `supportedFormats` (see chatCore) because
  // opencode-go models differ in endpoint support.
  transports: [
    { format: "openai", baseUrl: "https://opencode.ai/zen/go/v1/chat/completions", auth: { combined: true, header: "Authorization", scheme: "bearer" } },
    { format: "claude", baseUrl: "https://opencode.ai/zen/go/v1/messages", auth: { combined: true, header: "x-api-key", scheme: "raw", anthropicVersion: true } },
    { format: "openai-responses", baseUrl: "https://opencode.ai/zen/go/v1/responses", auth: { combined: true, header: "Authorization", scheme: "bearer" } },
  ],
  models: [
    // Live /v1/models advertises Luna, but it was missing from the static
    // routing table. Keep it on the OpenAI Chat endpoint; Claude/Responses
    // transports are not valid for this model.
    { id: "gpt-5.6-luna", name: "GPT 5.6 Luna", supportedFormats: ["openai"] },
    { id: "glm-5.3-flash", name: "GLM 5.3 Flash (Vision)", supportedFormats: ["openai"] },
    { id: "glm-5.2", name: "GLM 5.2", supportedFormats: ["openai"] },
    { id: "glm-5.1", name: "GLM 5.1", supportedFormats: ["openai"] },
    { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", supportedFormats: ["openai"] },
    { id: "kimi-k2.6", name: "Kimi K2.6", supportedFormats: ["openai"] },
    // V4.1-Flash 在 opencode-go 有两个 id：官方文档表主推的 deepseek-v4.1-flash，
    // 以及 /models 目录里同时列出的 deepseek-flash（与 DeepSeek 第一方同名）。
    // 三端点声明与同一上游的 deepseek-v4-flash 一致——DeepSeek 已把那个 id 路由到
    // V4.1 Flash，等于这条声明已经被现网验证过。
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", supportedFormats: ["openai", "claude", "openai-responses"] },
    { id: "deepseek-flash", name: "DeepSeek V4.1 Flash (alias id)", supportedFormats: ["openai", "claude", "openai-responses"] },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", supportedFormats: ["openai", "claude", "openai-responses"] },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", supportedFormats: ["openai", "claude", "openai-responses"] },
    { id: "deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Flash Vision (Exp)", supportedFormats: ["openai", "claude", "openai-responses"] },
    { id: "mimo-v2.5", name: "MiMo V2.5", supportedFormats: ["openai"] },
    { id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro", supportedFormats: ["openai"] },
    { id: "minimax-m3", name: "MiniMax M3", supportedFormats: ["openai", "claude"] },
    { id: "minimax-m2.7", name: "MiniMax M2.7", supportedFormats: ["openai", "claude"] },
    { id: "minimax-m2.5", name: "MiniMax M2.5", supportedFormats: ["openai", "claude"] },
    { id: "qwen3.7-max", name: "Qwen 3.7 Max", supportedFormats: ["openai", "claude"] },
    { id: "qwen3.7-plus", name: "Qwen 3.7 Plus", supportedFormats: ["openai", "claude"] },
    { id: "qwen3.6-plus", name: "Qwen 3.6 Plus", supportedFormats: ["openai", "claude"] },
  ],
};
