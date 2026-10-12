// Token Harbor — OpenAI-compatible aggregator. One API key reaches every
// model, billed per-token from a prepaid wallet. Model ids are bare (e.g.
// claude-opus-5.5, gpt-6-astra, deepseek-v4.1-flash:free) and are fetched live
// from the provider.
//
// thinkingFormat is deliberately NOT declared on the transport: Token Harbor
// forwards requests verbatim, so each model must resolve its own thinking wire
// format through providers/capabilities.js. Setting a provider-wide value
// would force one format (e.g. claude-adaptive) onto every model.
export default {
  id: "tokenharbor",
  alias: "tokenharbor",
  aliases: ["th", "thh"],
  uiAlias: "tokenharbor",
  display: {
    name: "Token Harbor",
    icon: "anchor",
    color: "#0F766E",
    textIcon: "TH",
    website: "https://tokenharbor.ai",
    notice: {
      apiKeyUrl: "https://tokenharbor.ai/dashboard",
    },
  },
  category: "apikey",
  authType: "apikey",
  // Without this the card ranks ~51/53 in the API Key grid (unconnected
  // providers fall through to `priority ?? 999`, then alphabetical) while the
  // page folds everything past the first 20 behind "Show all". 45 keeps it
  // ahead of the Anthropic/OpenAI tier so it lands inside the visible 20 on
  // fresh installs.
  priority: 45,
  transport: {
    baseUrl: "https://tokenharbor.ai/v1/chat/completions",
    validateUrl: "https://tokenharbor.ai/v1/models",
    retry: {
      429: 2,
    },
  },
  // Curated seed; the live catalogue is fetched via modelsFetcher and any other
  // id is accepted via passthroughModels. Their catalogue rotates (the :free set
  // in particular), so this stays deliberately small and is only the offline
  // fallback. Ids are bare — Token Harbor does not prefix them by upstream vendor.
  models: [
    { id: "claude-opus-5.5", name: "Claude Opus 5.5" },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
    // Dot-version + ":free" form. The canonical `claude-haiku-5-5` row (dash
    // form) does not match it, so without a capability row it falls to the
    // generic `*claude*haiku*` pattern (claude-budget, 200K/64K). That row is
    // added in capabilities.js by PR #51; this entry only makes the id offered.
    { id: "claude-haiku-5.5:free", name: "Claude Haiku 5.5 (Free)" },
    { id: "gpt-6-astra", name: "GPT-6 Astra" },
    { id: "gpt-6-sol", name: "GPT-6 Sol" },
    { id: "deepseek-v4.1-flash:free", name: "DeepSeek V4.1 Flash (Free)" },
    { id: "qwen3.8-flash:free", name: "Qwen3.8 Flash (Free)" },
    { id: "mimo-v2.6-flash:free", name: "MiMo V2.6 Flash (Free)" },
    { id: "grok-4.7", name: "Grok 4.7" },
  ],
  modelsFetcher: { url: "https://tokenharbor.ai/v1/models", type: "openai" },
  passthroughModels: true,
};
