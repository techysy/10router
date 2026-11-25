export default {
  id: "gemini-web",
  priority: 220,
  alias: "gemini-web",
  aliases: [
    "gweb",
  ],
  uiAlias: "gemini-web",
  // Executor is a stub — generateMedia/execute throw unconditionally — so the
  // provider is not advertised in the add-catalog until it is implemented.
  hidden: true,
  display: {
    name: "Gemini Web",
    icon: "auto_awesome",
    color: "#4285F4",
    textIcon: "GW",
    website: "https://gemini.google.com",
  },
  category: "webCookie",
  authType: "cookie",
  serviceKinds: ["image"],
  authHint: "Paste your __Secure-1PSID (and __Secure-1PSIDTS) cookie value(s) from gemini.google.com",
  transport: {
    baseUrl: "https://gemini.google.com/app",
    format: "openai",
    authType: "cookie",
  },
  models: [
    { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
    { id: "gemini-3.7-flash", name: "Gemini 3.7 Flash" },
    { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash-Lite" },
    { id: "gemini-image", name: "Gemini Image (web)", params: ["n", "size"], kind: "image" },
  ],
};
