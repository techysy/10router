// Xiaomi ended the free MiMo channel ("MiMo free API service has ended").
// Kept visible as a configurable card so the user can choose whether it shows
// on the usage topology canvas; by default it is hidden there (service ended),
// and it carries a deprecation notice. Override the default via the
// topologyVisibility setting toggle on the providers page.
export default {
  id: "mimo-free",
  hidden: false,
  priority: 50,
  hasFree: true,
  // The `mmf` spelling is taken by the provider whose *id* is `mmf` (registry
  // mmf.js — the same Xiaomi free endpoint, kept as the bare hidden stub). An
  // id always wins its own spelling in ALIAS_TO_PROVIDER_ID, so `mmf` resolved
  // to that entry and this card's claims were dead — worse, PROVIDER_MODELS is
  // keyed `alias || id`, so both wrote the same `mmf` key and the later one
  // silently overwrote the other's catalogue; disabledModelsRepo's canonical
  // name is `uiAlias || alias || id`, so both also collapsed into one `mmf`
  // key-group and toggling a model here toggled it there. Own our own id as the
  // spelling (self-documenting, and nothing to collide with) — `mimo-free/…`
  // is what the catalogue emits.
  alias: "mimo-free",
  uiAlias: "mimo-free",
  display: {
    name: "MiMo Code Free",
    icon: "smart_toy",
    color: "#FF6900",
    textIcon: "MF",
    deprecationNotice:
      "MiMo free API service has ended. This provider is no longer free. It is hidden from the usage topology by default — enable it via the toggle if you still want it shown.",
  },
  topologyHiddenByDefault: true,
  category: "free",
  noAuth: true,
  community: true,
  transport: {
    baseUrl: "https://api.xiaomimimo.com/api/free-ai/openai/chat",
    noAuth: true,
  },
  models: [
    { id: "mimo-auto", name: "MiMo Auto" },
  ],
  modelsFetcher: { url: "https://models.dev/api.json", type: "mimo-free" },
  passthroughModels: true,
};
