export default {
  id: "keenable",
  alias: "keenable",
  display: {
    name: "Keenable",
    icon: "travel_explore",
    color: "#FF7E38",
    textIcon: "KE",
    website: "https://www.keenable.ai",
    notice: {
      apiKeyUrl: "https://app.keenable.ai/console"
    }
  },
  category: "apikey",
  authType: "apikey",
  authModes: ["apikey"],
  serviceKinds: [
    "webSearch",
    "webFetch"
  ],
  searchConfig: {
    baseUrl: "https://api.keenable.ai/v1/search",
    method: "POST",
    authType: "apikey",
    authHeader: "x-api-key",
    searchTypes: [
      "web"
    ],
    defaultMaxResults: 5,
    maxMaxResults: 50,
    timeoutMs: 10000,
    cacheTTLMs: 300000
  },
  fetchConfig: {
    baseUrl: "https://api.keenable.ai/v1/fetch",
    method: "GET",
    authType: "apikey",
    authHeader: "x-api-key",
    formats: [
      "markdown",
      "text"
    ],
    maxCharacters: 50000,
    timeoutMs: 15000
  }
};
