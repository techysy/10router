const provider = {
  id: "tokenharbor-free",
  alias: "tokenharbor-free",
  aliases: [
    "th-free",
    "thf",
  ],
  uiAlias: "thf",
  display: {
    name: "Token Harbor (Free)",
    icon: "anchor",
    color: "#0F766E",
    textIcon: "THF",
    website: "https://tokenharbor.ai",
    notice: {
      apiKeyUrl: "https://tokenharbor.ai/dashboard",
    },
  },
  category: "webCookie",
  authType: "cookie",
  authHint: "Paste your session cookie from tokenharbor.ai/dashboard",
  features: {
    usage: true,
    usageCookie: true,
  },
  transport: {
    baseUrl: "https://tokenharbor.ai/dashboard",
    format: "tokenharbor-free",
    authType: "cookie",
  },
  models: [],
  passthroughModels: false,
};

export default provider;
