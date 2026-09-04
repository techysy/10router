export default {
  id: "opencode",
  priority: 40,
  hasFree: true,
  alias: "oc",
  uiAlias: "oc",
  display: {
    name: "OpenCode Free",
    icon: "terminal",
    color: "#E87040",
    textIcon: "OC",
  },
  category: "free",
  noAuth: true,
  // Free noAuth provider with no connections — hidden from the usage topology
  // canvas by default (same as mimo-free). Toggle via the topologyVisibility
  // setting on the providers page.
  topologyHiddenByDefault: true,
  transport: {
    baseUrl: "https://opencode.ai",
    headers: {
      "x-opencode-client": "desktop",
    },
    noAuth: true,
  },
  models: [
    // Free catalog mirrors the official "limited-time free" list on
    // opencode.ai/docs/zen. Muse Spark models are served by /zen/v1/responses;
    // the rest stay on /chat/completions, so the format is declared per-model,
    // not per-provider. Upstream API also lists deepseek-v4-flash-free and
    // laguna-s-2.1-free, but both are already gone from the official free
    // list — deliberately NOT registered.
    { id: "muse-spark-1.2-contributor-free", name: "Muse Spark 1.2 Contributor Free", targetFormat: "openai-responses" },
    { id: "muse-spark-1.3-contributor-free", name: "Muse Spark 1.3 Contributor Free", targetFormat: "openai-responses" },
    { id: "big-pickle", name: "Big Pickle" },
    { id: "mimo-v2.5-free", name: "MiMo-V2.5 Free" },
    { id: "ling-3.0-flash-fin-free", name: "Ling 3.0 Flash Fin Free" },
    { id: "nemotron-3-ultra-free", name: "Nemotron 3 Ultra Free" },
    { id: "nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning Free" },
  ],
  modelsFetcher: { url: "https://opencode.ai/zen/v1/models", type: "opencode-free" },
  passthroughModels: true,
};
