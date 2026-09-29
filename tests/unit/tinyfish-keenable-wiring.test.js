// TinyFish + Keenable — search + scrape (web fetch) wiring contract.
//
// Both providers were added on feat/search-scrape-tinyfish-keenable: registry
// entry (searchConfig + fetchConfig) → search callers/normalizers → /v1/search
// and /v1/web/fetch, surfaced on the dashboard through the registry-driven
// getProvidersByKind() path. The fetch side is exercised end-to-end here with a
// stubbed global fetch so a future refactor cannot silently drop either branch.
import { describe, it, expect, vi } from "vitest";

import tinyfish from "open-sse/providers/registry/tinyfish.js";
import keenable from "open-sse/providers/registry/keenable.js";
import REGISTRY from "open-sse/providers/registry/index.js";
import { buildSearchRequest } from "open-sse/handlers/search/callers.js";
import { normalizeSearchResponse } from "open-sse/handlers/search/normalizers.js";
import { handleFetchCore } from "open-sse/handlers/fetch/index.js";
import { AI_PROVIDERS, getProvidersByKind } from "@/shared/constants/providers.js";

const providers = [
  {
    entry: tinyfish,
    searchBase: "https://api.search.tinyfish.ai",
    fetchBase: "https://api.fetch.tinyfish.ai",
    token: "tf-secret",
  },
  {
    entry: keenable,
    searchBase: "https://api.keenable.ai/v1/search",
    fetchBase: "https://api.keenable.ai/v1/fetch",
    token: "keen_secret",
  },
];

function searchParams(overrides = {}) {
  return {
    query: "latest ai news",
    token: "secret",
    searchType: "web",
    maxResults: 5,
    domainFilter: [],
    providerOptions: undefined,
    providerSpecificData: undefined,
    ...overrides,
  };
}

describe.each(providers)("registry contract: $entry.id", ({ entry, searchBase, fetchBase }) => {
  it("is an apikey provider offering both webSearch and webFetch", () => {
    expect(entry.category).toBeTruthy();
    expect(entry.authType).toBe("apikey");
    expect(entry.serviceKinds).toEqual(expect.arrayContaining(["webSearch", "webFetch"]));
    expect(entry.hidden).toBeFalsy();
    expect(entry.display?.apiKeyUrl || entry.display?.notice?.apiKeyUrl).toBeTruthy();
  });

  it("ships both search and fetch configs", () => {
    expect(entry.searchConfig?.baseUrl).toBe(searchBase);
    expect(entry.searchConfig?.authHeader).toBe("x-api-key");
    expect(entry.fetchConfig?.baseUrl).toBe(fetchBase);
    expect(entry.fetchConfig?.authHeader).toBe("x-api-key");
    expect(entry.searchConfig?.searchTypes?.length).toBeGreaterThan(0);
  });

  it("is exported through the registry index", () => {
    expect(REGISTRY.find((p) => p.id === entry.id)).toBeTruthy();
  });

  it("is present in AI_PROVIDERS with its media config intact", () => {
    const wired = AI_PROVIDERS[entry.id];
    expect(wired).toBeTruthy();
    expect(wired.serviceKinds).toEqual(expect.arrayContaining(["webSearch", "webFetch"]));
    expect(wired.searchConfig?.baseUrl).toBe(searchBase);
    expect(wired.fetchConfig?.baseUrl).toBe(fetchBase);
  });

  it("is listed by getProvidersByKind for both web kinds", () => {
    expect(getProvidersByKind("webSearch").map((p) => p.id)).toContain(entry.id);
    expect(getProvidersByKind("webFetch").map((p) => p.id)).toContain(entry.id);
  });
});

describe("tinyfish search request builder", () => {
  it("GETs X-API-Key-authed query params against the search endpoint", () => {
    const { url, init } = buildSearchRequest({ id: "tinyfish", ...tinyfish.searchConfig }, searchParams({ token: "tf-secret" }));
    expect(init.method).toBe("GET");
    expect(init.headers["X-API-Key"]).toBe("tf-secret");
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname.replace(/\/$/, "")}`).toBe("https://api.search.tinyfish.ai");
    expect(parsed.searchParams.get("query")).toBe("latest ai news");
    // web is the upstream default — no domain_type noise.
    expect(parsed.searchParams.get("domain_type")).toBeNull();
  });

  it("maps news, geo, domain filters, freshness and offset onto TinyFish params", () => {
    const { url } = buildSearchRequest({ id: "tinyfish", ...tinyfish.searchConfig }, searchParams({
      searchType: "news",
      country: "us",
      language: "zh",
      domainFilter: ["arxiv.org", "-reddit.com"],
      timeRange: "week",
      offset: 5,
      maxResults: 5,
    }));
    const parsed = new URL(url);
    expect(parsed.searchParams.get("domain_type")).toBe("news");
    expect(parsed.searchParams.get("location")).toBe("US");
    expect(parsed.searchParams.get("language")).toBe("zh");
    expect(parsed.searchParams.get("include_domains")).toBe("arxiv.org");
    expect(parsed.searchParams.get("exclude_domains")).toBe("reddit.com");
    expect(parsed.searchParams.get("recency_minutes")).toBe("10080");
    // pages are 0-indexed upstream: offset 5 with 5 results → page 1
    expect(parsed.searchParams.get("page")).toBe("1");
  });

  it("refuses to build without an API key", () => {
    expect(() =>
      buildSearchRequest({ id: "tinyfish", ...tinyfish.searchConfig }, searchParams({ token: undefined }))
    ).toThrow(/TinyFish/);
  });
});

describe("keenable search request builder", () => {
  it("POSTs X-API-Key-authed JSON to the search endpoint", () => {
    const { url, init } = buildSearchRequest({ id: "keenable", ...keenable.searchConfig }, searchParams({ token: "keen_secret" }));
    expect(url).toBe("https://api.keenable.ai/v1/search");
    expect(init.method).toBe("POST");
    expect(init.headers["X-API-Key"]).toBe("keen_secret");
    expect(JSON.parse(init.body)).toMatchObject({ query: "latest ai news", max_results: 5 });
  });

  it("honours mode, a single-site filter and freshness as a relative delta", () => {
    const { init } = buildSearchRequest({ id: "keenable", ...keenable.searchConfig }, searchParams({
      domainFilter: ["techcrunch.com"],
      timeRange: "day",
      providerOptions: { mode: "realtime" },
    }));
    const body = JSON.parse(init.body);
    expect(body.mode).toBe("realtime");
    expect(body.site).toBe("techcrunch.com");
    expect(body.published_after).toBe("1d");
  });

  it("drops a multi-domain filter rather than silently keeping one", () => {
    const { init } = buildSearchRequest(
      { id: "keenable", ...keenable.searchConfig },
      searchParams({ domainFilter: ["a.com", "b.com"] })
    );
    expect(JSON.parse(init.body).site).toBeUndefined();
  });

  it("ignores an out-of-range mode value", () => {
    const { init } = buildSearchRequest(
      { id: "keenable", ...keenable.searchConfig },
      searchParams({ providerOptions: { mode: "turbo" } })
    );
    expect(JSON.parse(init.body).mode).toBeUndefined();
  });
});

describe("search response normalizers", () => {
  it("maps TinyFish results onto the unified SearchResult shape", () => {
    const payload = {
      query: "ai",
      results: [
        {
          position: 1,
          domain: "example.com",
          title: "AI Weekly",
          snippet: "A summary of the week in AI.",
          url: "https://example.com/ai?utm=1",
          published_at: "2026-09-18",
          publisher: "Example Press",
        },
        { position: 2, title: "Second", snippet: "two", url: "https://example.org/x" },
      ],
      total_results: 1200,
      page: 0,
    };
    const { results, totalResults } = normalizeSearchResponse("tinyfish", payload, "ai", "web");
    expect(results).toHaveLength(2);
    expect(totalResults).toBe(1200);
    const [first, second] = results;
    expect(first.title).toBe("AI Weekly");
    expect(first.display_url).toBe("example.com/ai");
    expect(first.snippet).toBe("A summary of the week in AI.");
    expect(first.metadata.author).toBe("Example Press");
    expect(first.published_at).toBe("2026-09-18");
    expect(first.position).toBe(1);
    expect(first.citation.provider).toBe("tinyfish");
    expect(second.metadata.author).toBeNull();
  });

  it("maps Keenable results (description → snippet, snippet → content)", () => {
    const payload = {
      query: "ai",
      mode: "pro",
      results: [
        {
          title: "TypeScript Best Practices 2026",
          url: "https://example.com/ts",
          description: "A comprehensive guide.",
          snippet: "Use strict mode, prefer interfaces…",
          published_at: "2026-01-15T10:30:00Z",
        },
        { title: "Bare", url: "https://example.org/b", description: "short only" },
      ],
    };
    const { results, totalResults } = normalizeSearchResponse("keenable", payload, "ai", "web");
    expect(totalResults).toBe(2);
    const [first, second] = results;
    expect(first.snippet).toBe("A comprehensive guide.");
    expect(first.content).toMatchObject({ format: "text", text: "Use strict mode, prefer interfaces…" });
    expect(first.published_at).toBe("2026-01-15T10:30:00Z");
    expect(second.content).toBeNull();
  });

  it("degrades gracefully on an unexpected payload", () => {
    for (const id of ["tinyfish", "keenable"]) {
      expect(normalizeSearchResponse(id, { results: null }, "ai", "web")).toEqual({
        results: [],
        totalResults: null,
      });
    }
  });
});

describe("web fetch dispatch", () => {
  it("posts to TinyFish with X-API-Key and parses results[]", async () => {
    const calls = [];
    vi.stubGlobal("fetch", async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({ results: [{ url, title: "Example", text: "# Hello" }], errors: [] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    try {
      const res = await handleFetchCore({
        url: "https://example.com/page",
        format: "markdown",
        provider: "tinyfish",
        providerConfig: tinyfish.fetchConfig,
        credentials: { apiKey: "tf-secret" },
      });
      expect(res.success).toBe(true);
      expect(calls[0].url).toBe("https://api.fetch.tinyfish.ai");
      expect(calls[0].init.method).toBe("POST");
      expect(calls[0].init.headers["x-api-key"]).toBe("tf-secret");
      expect(JSON.parse(calls[0].init.body)).toEqual({ urls: ["https://example.com/page"], format: "markdown" });
      expect(res.data.provider).toBe("tinyfish");
      expect(res.data.title).toBe("Example");
      expect(res.data.content).toMatchObject({ format: "markdown", text: "# Hello", length: 7 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("maps a plain text request onto TinyFish's markdown format", async () => {
    const calls = [];
    vi.stubGlobal("fetch", async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ results: [{ url, title: "T", text: "body" }], errors: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    try {
      await handleFetchCore({
        url: "https://example.com",
        format: "text",
        provider: "tinyfish",
        providerConfig: tinyfish.fetchConfig,
        credentials: { apiKey: "tf-secret" },
      });
      expect(JSON.parse(calls[0].init.body).format).toBe("markdown");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("surfaces a per-URL TinyFish error when results[] is empty", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ results: [], errors: [{ url: "https://example.com", error: "timeout" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    try {
      const res = await handleFetchCore({
        url: "https://example.com",
        provider: "tinyfish",
        providerConfig: tinyfish.fetchConfig,
        credentials: { apiKey: "tf-secret" },
      });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/timeout/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("GETs Keenable with live=true and passes max_chars through", async () => {
    const calls = [];
    vi.stubGlobal("fetch", async (url) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({ url, title: "Keenable Page", content: "# Page body" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    try {
      const res = await handleFetchCore({
        url: "https://example.com/deep",
        format: "markdown",
        maxCharacters: 42,
        provider: "keenable",
        providerConfig: keenable.fetchConfig,
        credentials: { apiKey: "keen_secret" },
      });
      expect(res.success).toBe(true);
      const parsed = new URL(calls[0]);
      expect(`${parsed.origin}${parsed.pathname}`).toBe("https://api.keenable.ai/v1/fetch");
      expect(parsed.searchParams.get("url")).toBe("https://example.com/deep");
      expect(parsed.searchParams.get("live")).toBe("true");
      expect(parsed.searchParams.get("max_chars")).toBe("42");
      expect(res.data.provider).toBe("keenable");
      expect(res.data.title).toBe("Keenable Page");
      expect(res.data.content.text).toBe("# Page body");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("still rejects unknown fetch providers", async () => {
    const res = await handleFetchCore({
      url: "https://example.com",
      provider: "not-a-provider",
      providerConfig: {},
      credentials: {},
    });
    expect(res).toMatchObject({ success: false, status: 400 });
  });
});
