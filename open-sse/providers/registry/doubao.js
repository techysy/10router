export default {
  id: "doubao",
  alias: "doubao",
  aliases: ["doubao-search", "volc-search"],
  display: {
    name: "Doubao Search",
    icon: "search",
    color: "#175CFF",
    textIcon: "DB",
    website: "https://www.volcengine.com/product/doubao-search",
    notice: {
      // 火山引擎控制台开通「联网搜索」后按量后付费,搜索与 Fetch 共享同一把 Key
      // 与同一份 500 次/月的免费额度;中文内容召回质量明显优于通用搜索 API。
      apiKeyUrl: "https://console.volcengine.com/searchapi"
    }
  },
  category: "apikey",
  authType: "apikey",
  serviceKinds: [
    "webSearch",
    "webFetch"
  ],
  searchConfig: {
    baseUrl: "https://open.feedcoopapi.com/search_api/global_search",
    method: "POST",
    authType: "apikey",
    authHeader: "bearer",
    costPerQuery: 0,
    freeMonthlyQuota: 500,
    // 官方仅 web 检索结果(image / visual 搜图不在本期);Query 上限 100 字符
    // 且不支持多词搜索,超出由 caller 截断。无 country/language/timeRange 参数,
    // domainFilter 无对应字段(仅 Filter.IcpHostOnly),传入时忽略不报错。
    searchTypes: [
      "web"
    ],
    defaultMaxResults: 10,
    maxMaxResults: 20,
    timeoutMs: 10000,
    cacheTTLMs: 300000
  },
  fetchConfig: {
    baseUrl: "https://open.feedcoopapi.com/search_api/fetch",
    method: "POST",
    authType: "apikey",
    authHeader: "bearer",
    costPerQuery: 0,
    freeMonthlyQuota: 500,
    // ContentText 是纯文本(不执行 JS,无 markdown);请求 markdown 时降级返回 text。
    formats: [
      "text"
    ],
    maxCharacters: 50000,
    timeoutMs: 15000
  }
};
