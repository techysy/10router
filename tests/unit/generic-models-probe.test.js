import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Registry providers shipped without a curated case in testApiKeyConnection's
// switch (modelscope / inception / apinex / oxion …) dead-ended on "Provider
// test not supported" — the Test button stayed broken until someone remembered
// the case list. The switch default now falls through to the generic GET
// /models probe when the registry declares an explicit validateUrl; these
// cases pin that behavior (and the auth-only verdict) for oxion and friends.

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
}));
vi.mock("@/lib/network/proxyTest", () => ({ testProxyUrl: vi.fn(async () => ({ ok: true })) }));
vi.mock("open-sse/services/usage.js", () => ({ getUsageForProvider: vi.fn() }));
vi.mock("open-sse/services/qoderModels.js", () => ({ resolveQoderModels: vi.fn() }));
vi.mock("@/lib/oauth/constants/oauth", () => ({
  GEMINI_CONFIG: {}, ANTIGRAVITY_CONFIG: {}, KIRO_CONFIG: {}, CLAUDE_CONFIG: {},
  CLINE_CONFIG: {}, KILOCODE_CONFIG: { apiBaseUrl: "https://x" }, KIMCHI_CONFIG: {}, CODEX_CONFIG: {},
}));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));

const { testApiKeyConnection, probeOpenAIModelsEndpoint } = await import(
  "../../src/app/api/providers/[id]/test/testUtils.js"
);

function conn(provider, extra = {}) {
  return { provider, apiKey: "cc_test_key", authType: "apikey", ...extra };
}

function jsonRes(status, body = "{}") {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

let fetchMock;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("connection test — switch default falls through to the generic /models probe", () => {
  it("oxion (no curated case, registry validateUrl) probes its /models with Bearer auth", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200));
    const result = await testApiKeyConnection(conn("oxion"));
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://oxionai.com/v1/models");
    expect(init.headers.Authorization).toBe("Bearer cc_test_key");
    expect(result).toEqual({ valid: true, error: null });
  });

  it("modelscope / sambanova / kilo-gateway use a chat ping — their /models is a public catalog", async () => {
    // Verified 2026-10-25 with a bogus Bearer: all three answer /models 200
    // without checking the key, so the generic probe cannot discriminate.
    fetchMock.mockResolvedValueOnce(jsonRes(200, JSON.stringify({ choices: [{ message: { content: "pong" } }] })));
    const result = await testApiKeyConnection(conn("modelscope"));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api-inference.modelscope.cn/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer cc_test_key");
    expect(result).toEqual({ valid: true, error: null });

    fetchMock.mockResolvedValueOnce(jsonRes(401));
    const bad = await testApiKeyConnection(conn("sambanova"));
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.sambanova.ai/v1/chat/completions");
    expect(bad).toEqual({ valid: false, error: "Invalid API key" });

    fetchMock.mockResolvedValueOnce(jsonRes(200, JSON.stringify({ choices: [] })));
    const kilo = await testApiKeyConnection(conn("kilo-gateway"));
    expect(fetchMock.mock.calls[2][0]).toBe("https://api.kilo.ai/api/gateway/chat/completions");
    expect(kilo).toEqual({ valid: true, error: null });
  });

  it("401 still means bad key", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(401));
    const result = await testApiKeyConnection(conn("oxion"));
    expect(result).toEqual({ valid: false, error: "Invalid API key" });
  });

  it("verdict stays auth-only: upstream 503 during a maintenance window does not fail the key", async () => {
    // Live Oxion body from 2026-10-24 — the gateway 5xx'd wholesale while the
    // key was perfectly fine. A maintenance 503 must not red the connection.
    fetchMock.mockResolvedValueOnce(jsonRes(503, JSON.stringify({
      error: { code: "service_upgrading", message: "Our service is being upgraded right now." },
    })));
    const result = await testApiKeyConnection(conn("oxion"));
    expect(result).toEqual({ valid: true, error: null });
  });

  it("HTML 503 (gateway / Cloudflare page) reports maintenance instead of bad key", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html><body>blocked</body></html>", {
      status: 503,
      headers: { "content-type": "text/html" },
    }));
    const result = await testApiKeyConnection(conn("oxion"));
    expect(result.valid).toBe(false);
    expect(result.maintenance).toBe(true);
    expect(result.error).toMatch(/maintenance/i);
  });

  it("network-level failure reports maintenance", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    const result = await testApiKeyConnection(conn("oxion"));
    expect(result.valid).toBe(false);
    expect(result.maintenance).toBe(true);
    expect(result.error).toMatch(/Endpoint unreachable/i);
  });

  it("providers without a registry validateUrl keep the old answer (vertex)", async () => {
    const result = await testApiKeyConnection(conn("vertex"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ valid: false, error: "Provider test not supported" });
  });

  it("curated generic cases share the helper (river) — same URL derivation", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200));
    const result = await testApiKeyConnection(conn("river"));
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.river.ai/v1/models");
    expect(result).toEqual({ valid: true, error: null });
  });

  it("probeOpenAIModelsEndpoint directly answers not-supported when nothing is derivable", async () => {
    const result = await probeOpenAIModelsEndpoint({ provider: "selfhosted-embedding", apiKey: "x" }, {});
    expect(result).toEqual({ valid: false, error: "Provider test not supported" });
  });
});
