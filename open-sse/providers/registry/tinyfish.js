export default {
  id: "tinyfish",
  alias: "tinyfish",
  display: {
    name: "TinyFish",
    icon: "travel_explore",
    color: "#D74B28",
    textIcon: "TF",
    website: "https://tinyfish.ai",
    notice: {
      apiKeyUrl: "https://agent.tinyfish.ai/api-keys"
    }
  },
  category: "freeTier",
  authType: "apikey",
  authModes: ["apikey"],
  serviceKinds: [
    "webSearch",
    "webFetch"
  ],
  searchConfig: {
    baseUrl: "https://api.search.tinyfish.ai",
    method: "GET",
    authType: "apikey",
    authHeader: "x-api-key",
    costPerQuery: 0,
    freeMonthlyQuota: 999999,
    searchTypes: [
      "web",
      "news"
    ],
    defaultMaxResults: 5,
    maxMaxResults: 20,
    timeoutMs: 10000,
    cacheTTLMs: 300000
  },
  fetchConfig: {
    baseUrl: "https://api.fetch.tinyfish.ai",
    method: "POST",
    authType: "apikey",
    authHeader: "x-api-key",
    costPerQuery: 0,
    freeMonthlyQuota: 999999,
    formats: [
      "markdown",
      "text",
      "html"
    ],
    maxCharacters: 100000,
    timeoutMs: 30000
  }
};
