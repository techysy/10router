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
  community: true,
  // Free noAuth provider with no connections — shown on the usage topology
  // canvas by default. Toggle via the topologyVisibility setting on the
  // providers page.
  topologyHiddenByDefault: false,
  transport: {
    baseUrl: "https://opencode.ai",
    headers: {
      "x-opencode-client": "cli",
    },
    noAuth: true,
    forceStream: true,
    reasoningInject: { scope: "all" },
    // Muse Spark 1.3-Free 400s on any tool_choice other than "auto" (named /
    // required / none). Demote in the executor; extend only with evidence.
    quirks: {
      forceAutoToolChoiceModels: ["muse-spark-1.3-contributor-free"],
    },
  },
  models: [
    // Free catalog mirrors the official "limited-time free" list on
    // opencode.ai/docs/zen (cross-checked against the live /zen/v1/models on
    // 2026-09-30). Muse Spark models are served by /zen/v1/responses; the rest
    // stay on /chat/completions, so the format is declared per-model, not
    // per-provider. The live API also lists deepseek-v4-flash-free (upstream
    // still answers "Model is unavailable" — blocked in suggested-models
    // filters.js) and jev-1.13-free (needs the System One decision lane, not
    // ported yet — stays blocked).
    { id: "muse-spark-1.2-contributor-free", name: "Muse Spark 1.2 Contributor Free", targetFormat: "openai-responses" },
    { id: "muse-spark-1.3-contributor-free", name: "Muse Spark 1.3 Contributor Free", targetFormat: "openai-responses" },
    { id: "big-pickle", name: "Big Pickle" },
    { id: "deepseek-v4.1-flash-free", name: "DeepSeek V4.1 Flash Free" },
    { id: "mimo-v2.6-flash-free", name: "MiMo V2.6 Flash Free" },
    { id: "mimo-v2.5-free", name: "MiMo-V2.5 Free" },
    { id: "ling-3.0-flash-fin-free", name: "Ling 3.0 Flash Fin Free" },
    { id: "nemotron-3-ultra-free", name: "Nemotron 3 Ultra Free" },
    { id: "nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning Free" },
    // Jev decision model — served on the System One lane, NOT /chat/completions.
    { id: "jev-1.13-free", name: "Jev 1.13 Free", kind: "systemone" },
  ],
  serviceKinds: ["llm", "systemone"],
  // System One (Jev) decision endpoint — native JSON in/out, no chat translation.
  systemoneConfig: {
    baseUrl: "https://opencode.ai/zen/v1/systemone",
    headers: {
      "x-opencode-client": "cli",
      "User-Agent": "opencode/1.18.35",
    },
  },
  modelsFetcher: { url: "https://opencode.ai/zen/v1/models", type: "opencode-free" },
  passthroughModels: true,
};
