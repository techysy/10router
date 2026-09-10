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
  // Endpoint support follows the endpoint table in https://opencode.ai/docs/go/.
  // `/v1/models` is the authoritative *full* list (their docs say so verbatim), while that
  // table only documents the recommended subset — ids it does not cover inherit their
  // family's endpoint. A missing declaration is not harmless: chatCore uses the
  // sourceFormat-matched transport whenever the model declares nothing, so an undeclared
  // chat-only id would send a claude-format request to /messages and fail.
  models: [
    // /v1/responses only — any other client format is translated to the responses format,
    // because these ids are not served on /chat/completions or /messages.
    { id: "grok-4.6", name: "Grok 4.6", targetFormat: "openai-responses", supportedFormats: ["openai-responses"] },
    { id: "gpt-5.6-luna", name: "GPT 5.6 Luna", targetFormat: "openai-responses", supportedFormats: ["openai-responses"] },
    { id: "muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor", targetFormat: "openai-responses", supportedFormats: ["openai-responses"] },
    { id: "muse-spark-1.2-contributor", name: "Muse Spark 1.2 Contributor", targetFormat: "openai-responses", supportedFormats: ["openai-responses"] },

    // /chat/completions only.
    { id: "glm-5.3-flash", name: "GLM 5.3 Flash (Vision)", supportedFormats: ["openai"] },
    { id: "glm-5.3", name: "GLM 5.3", supportedFormats: ["openai"] },
    { id: "glm-5.2", name: "GLM 5.2", supportedFormats: ["openai"] },
    { id: "glm-5.1", name: "GLM 5.1", supportedFormats: ["openai"] },
    { id: "glm-5", name: "GLM 5", supportedFormats: ["openai"] },
    { id: "kimi-k3", name: "Kimi K3", supportedFormats: ["openai"] },
    { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", supportedFormats: ["openai"] },
    { id: "kimi-k2.6", name: "Kimi K2.6", supportedFormats: ["openai"] },
    { id: "kimi-k2.5", name: "Kimi K2.5", supportedFormats: ["openai"] },
    { id: "longcat-2.0", name: "LongCat 2.0", supportedFormats: ["openai"] },
    // V4.1-Flash 在 opencode-go 有两个 id：官方文档表主推的 deepseek-v4.1-flash，
    // 以及 /models 目录里同时列出的 deepseek-flash（与 DeepSeek 第一方同名）。
    // 文档表只把 /chat/completions 列为推荐端点，但这条通道三个端点在现网都可用
    // （同一上游的 deepseek-v4-flash 已把该 id 路由到 V4.1 Flash，等于这条声明已被
    // 现网验证过），因此 DeepSeek 组维持三端点声明。
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", supportedFormats: ["openai", "claude", "openai-responses"] },
    { id: "deepseek-flash", name: "DeepSeek V4.1 Flash (alias id)", supportedFormats: ["openai", "claude", "openai-responses"] },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", supportedFormats: ["openai", "claude", "openai-responses"] },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", supportedFormats: ["openai", "claude", "openai-responses"] },
    { id: "deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Flash Vision (Exp)", supportedFormats: ["openai", "claude", "openai-responses"] },
    { id: "mimo-v2.5", name: "MiMo V2.5", supportedFormats: ["openai"] },
    { id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro", supportedFormats: ["openai"] },
    { id: "mimo-v2-pro", name: "MiMo V2 Pro", supportedFormats: ["openai"] },
    { id: "mimo-v2-omni", name: "MiMo V2 Omni", supportedFormats: ["openai"] },
    { id: "hy4-preview", name: "Hy4 Preview", supportedFormats: ["openai"] },
    { id: "hy3", name: "Hy3", supportedFormats: ["openai"] },
    { id: "hy3-preview", name: "Hy3 Preview", supportedFormats: ["openai"] },

    // /messages + /chat/completions.
    { id: "minimax-m3", name: "MiniMax M3", supportedFormats: ["openai", "claude"] },
    { id: "minimax-m2.7", name: "MiniMax M2.7", supportedFormats: ["openai", "claude"] },
    { id: "minimax-m2.5", name: "MiniMax M2.5", supportedFormats: ["openai", "claude"] },
    { id: "qwen3.8-max", name: "Qwen 3.8 Max", supportedFormats: ["openai", "claude"] },
    { id: "qwen3.8-flash", name: "Qwen 3.8 Flash", supportedFormats: ["openai", "claude"] },
    { id: "qwen3.7-max", name: "Qwen 3.7 Max", supportedFormats: ["openai", "claude"] },
    { id: "qwen3.7-plus", name: "Qwen 3.7 Plus", supportedFormats: ["openai", "claude"] },
    { id: "qwen3.6-plus", name: "Qwen 3.6 Plus", supportedFormats: ["openai", "claude"] },
    { id: "qwen3.5-plus", name: "Qwen 3.5 Plus", supportedFormats: ["openai", "claude"] },

    // Catalog-only ids: present in /v1/models but absent from the endpoint table
    // (models.dev marks the others of this group deprecated). Endpoint inherited from
    // the family.
    { id: "grok-4.5", name: "Grok 4.5", targetFormat: "openai-responses", supportedFormats: ["openai-responses"] },
    // omen-alpha has no family and no first-party spec, so it deliberately carries no
    // supportedFormats at all: an openai-format request lands on /chat/completions exactly
    // as an explicit ["openai"] would, while claude/responses clients keep their own
    // endpoint instead of being funnelled somewhere unverified. It sits in the capability
    // audit's allowlist as a codename.
    { id: "omen-alpha", name: "Omen Alpha" },
  ],
};
