export default {
  id: "veoaifree-web",
  priority: 160,
  alias: "veo-free",
  display: {
    name: "Veo AI Free Web",
    icon: "movie",
    color: "#EA4335",
    textIcon: "VF",
    website: "https://veoaifree.com",
  },
  category: "apikey",
  authType: "none",
  noAuth: true,
  authHint: "No credentials needed — veoaifree.com free tier (about 6 requests/hour per IP)",
  transport: null,
  serviceKinds: ["image", "video"],
  // Video: no /v1/videos* wiring (see grok-web.js) — hide the kind instead of
  // 500-crashing the transparent proxy on a missing videoConfig.baseUrl.
  hiddenKinds: ["video"],
  models: [
    { id: "veo", name: "VEO 3.1 (Free)", params: ["seconds", "size"], kind: "video" },
    { id: "seedance", name: "Seedance (Free)", params: ["seconds", "size"], kind: "video" },
    { id: "nano-banana", name: "Nano Banana (Free)", params: ["n", "size"], kind: "image" },
  ],
};
