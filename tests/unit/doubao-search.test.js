import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildSearchRequest } from "../../open-sse/handlers/search/callers.js";
import { normalizeSearchResponse } from "../../open-sse/handlers/search/normalizers.js";
import { handleFetchCore } from "../../open-sse/handlers/fetch/index.js";
import { doubaoApiError } from "../../open-sse/utils/doubaoApi.js";
import { getModelsByProviderId } from "../../open-sse/config/providerModels.js";
import { APIKEY_PROVIDERS } from "../../src/shared/constants/providers.js";

const config = { id: "doubao", baseUrl: "https://open.feedcoopapi.com/search_api/global_search" };

describe("Doubao search request builder", () => {
  it("sends the official POST + Bearer shape with web SearchType", () => {
    const { url, init } = buildSearchRequest(config, {
      query: "火山引擎 联网搜索", searchType: "web", maxResults: 10, token: "vk-test",
    });

    expect(url).toBe("https://open.feedcoopapi.com/search_api/global_search");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer vk-test");
    expect(JSON.parse(init.body)).toEqual({
      SearchType: "web",
      Query: "火山引擎 联网搜索",
      DocCount: 10,
      MaxSnippetLength: 1000,
    });
  });

  it("truncates Query at the official 100-char cap instead of failing", () => {
    const { init } = buildSearchRequest(config, {
      query: "长".repeat(300), searchType: "web", maxResults: 5, token: "k",
    });
    expect(JSON.parse(init.body).Query).toHaveLength(100);
  });

  it("ignores domainFilter / country / timeRange (no upstream fields) without error", () => {
    const { init } = buildSearchRequest(config, {
      query: "q", searchType: "web", maxResults: 5, token: "k",
      domainFilter: ["example.com", "-bad.example"],
      country: "cn", language: "zh", timeRange: "week",
    });
    const body = JSON.parse(init.body);
    expect(body).toEqual({ SearchType: "web", Query: "q", DocCount: 5, MaxSnippetLength: 1000 });
  });
});

describe("Doubao response normalization + API error mapping", () => {
  it("maps Result.Documents with text-only Snippet joins", () => {
    const data = {
      Result: {
        TotalDocCount: 42,
        Documents: [
          {
            Title: "Doubao doc",
            Url: "https://example.com/a",
            Snippet: [
              { Type: "text", Text: "first line" },
              { Type: "image", Image: "https://example.com/img" },
              { Type: "text", Text: "second line" },
            ],
            DocumentInfo: { PublishTime: "2026-10-28" },
            HostInfo: { Hostname: "example.com", IconUrl: "https://example.com/fav.png" },
          },
        ],
      },
    };

    const { results, totalResults } = normalizeSearchResponse("doubao", data, "q", "web");
    expect(totalResults).toBe(42);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      title: "Doubao doc",
      url: "https://example.com/a",
      snippet: "first line\nsecond line",
      published_at: "2026-10-28",
      favicon_url: "https://example.com/fav.png",
    });
    expect(results[0].metadata.author).toBe("example.com");
    expect(results[0].citation.provider).toBe("doubao");
  });

  it.each([
    [{ Code: "RateLimitExceeded", CodeN: 700429, Message: "QPS exceeded" }, 429],
    [{ Code: "FreeQuotaExhausted", CodeN: 10406, Message: "quota drained" }, 403],
    [{ Code: "QuotaExceeded", CodeN: 10412, Message: "quota drained" }, 403],
    [{ Code: "InvalidKey", CodeN: 700901, Message: "bad key" }, 401],
    [{ Code: "RobotsRefused", CodeN: 10413, Message: "robots.txt disallows" }, 403],
    [{ Code: "UpstreamFail", CodeN: 10500, Message: "upstream" }, 502],
    [{ Code: "Unknown", CodeN: 999999, Message: "?" }, 502],
  ])("maps body error %j to HTTP %s (typed error drives account rotation)", (err, status) => {
    let caught;
    try {
      normalizeSearchResponse("doubao", { ResponseMetadata: { Error: err } }, "q", "web");
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.status).toBe(status);
  });

  it("reads a null Result as an empty answer only when no API error is present", () => {
    const { results, totalResults } = normalizeSearchResponse("doubao", { ResponseMetadata: {} }, "q", "web");
    expect(results).toEqual([]);
    expect(totalResults).toBeNull();
  });

  it("doubaoApiError returns null for clean payloads", () => {
    expect(doubaoApiError({ Result: { Documents: [] } })).toBeNull();
    expect(doubaoApiError(null)).toBeNull();
  });
});

describe("Doubao web fetch (runDoubao via handleFetchCore)", () => {
  const originalFetch = global.fetch;
  beforeEach(() => { global.fetch = vi.fn(); });
  afterEach(() => { global.fetch = originalFetch; });

  const providerArgs = {
    url: "https://example.com/article",
    format: "text",
    provider: "doubao",
    providerConfig: { baseUrl: "https://open.feedcoopapi.com/search_api/fetch", timeoutMs: 15000, maxCharacters: 50000 },
    credentials: { apiKey: "vk-test" },
  };

  it("posts the single URL and returns ContentText as text", async () => {
    global.fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      ResponseMetadata: {},
      Result: { Data: { StatusCode: 200, Title: "Example", ContentText: "正文内容" } },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const result = await handleFetchCore(providerArgs);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ provider: "doubao", title: "Example", content: { format: "text", text: "正文内容" } });
    const [reqUrl, init] = global.fetch.mock.calls[0];
    expect(reqUrl).toBe("https://open.feedcoopapi.com/search_api/fetch");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer vk-test");
    expect(JSON.parse(init.body)).toEqual({ Url: "https://example.com/article" });
  });

  it("maps a body-level API error (HTTP may still be 200) to its real status", async () => {
    global.fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      ResponseMetadata: { Error: { Code: "FreeQuotaExhausted", CodeN: 10406, Message: "quota drained" } },
      Result: null,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const result = await handleFetchCore(providerArgs);
    expect(result.success).toBe(false);
    expect(result.status).toBe(403);
    expect(result.error).toContain("FreeQuotaExhausted");
  });

  it("treats the target page's own non-200 StatusCode as a fetch failure", async () => {
    global.fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      Result: { Data: { StatusCode: 404, ContentText: "" } },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const result = await handleFetchCore(providerArgs);
    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(result.error).toBe("Target page returned 404");
  });

  it("degrades a markdown request to text instead of failing", async () => {
    global.fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      Result: { Data: { StatusCode: 200, Title: "T", ContentText: "plain" } },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const result = await handleFetchCore({ ...providerArgs, format: "markdown" });
    expect(result.success).toBe(true);
    expect(result.data.content.format).toBe("text");
  });
});

describe("Doubao provider registration", () => {
  it("registers webSearch + webFetch with web-only search types", () => {
    const p = APIKEY_PROVIDERS.doubao;
    expect(p).toBeDefined();
    expect(p.serviceKinds).toEqual(expect.arrayContaining(["webSearch", "webFetch"]));
    expect(p.searchConfig.searchTypes).toEqual(["web"]);
    expect(p.searchConfig.maxMaxResults).toBe(20);
    expect(p.fetchConfig.maxCharacters).toBe(50000);
    expect(p.fetchConfig.formats).toEqual(["text"]);
    expect(getModelsByProviderId("doubao")).toEqual([]);
  });
});
