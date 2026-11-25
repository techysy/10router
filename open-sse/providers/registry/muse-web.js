export default {
  id: "muse-web",
  priority: 220,
  alias: "muse-web",
  aliases: [
    "mu",
  ],
  uiAlias: "muse-web",
  // Executor is a stub — generateMedia throws unconditionally — so the
  // provider is not advertised in the add-catalog until it is implemented.
  hidden: true,
  display: {
    name: "Muse Web",
    icon: "auto_awesome",
    color: "#7C3AED",
    textIcon: "MU",
    website: "https://muse.ai",
  },
  category: "webCookie",
  authType: "cookie",
  serviceKinds: ["image", "video"],
  // Video: no /v1/videos* wiring (see grok-web.js) — hide the kind instead of
  // 500-crashing the transparent proxy on a missing videoConfig.baseUrl.
  hiddenKinds: ["video"],
  authHint: "Paste your muse.ai cookies (hatch_sess=...; hatch_gw=...; hatch_vml=...; hatch_native_auth_device=...) from a logged-in muse.ai session",
  transport: {
    baseUrl: "https://muse.ai",
    format: "openai",
    authType: "cookie",
  },
  models: [
    { id: "muse-chat", name: "Muse Chat" },
    { id: "muse-image", name: "Muse Image", params: ["n", "size"], kind: "image" },
    { id: "muse-video", name: "Muse Video", params: ["size", "seconds", "image"], kind: "video" },
  ],
};
