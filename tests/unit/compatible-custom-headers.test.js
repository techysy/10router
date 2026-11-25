import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #149: compatible nodes (openai/anthropic-compatible) can declare per-endpoint
// custom headers (node psd.customHeaders). The chat path merges them in
// BaseExecutor.buildHeaders AFTER auth (custom wins — a gateway needing its
// own token header overrides the default Bearer); structural headers
// (host/content-length/connection/…) are refused. The connection TEST path
// (testApiKeyConnection) rides the same merge so the probe is representative.

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

const { BaseExecutor, applyNodeCustomHeaders } = await import(
  "../../open-sse/executors/base.js"
);
const { testApiKeyConnection } = await import(
  "../../src/app/api/providers/[id]/test/testUtils.js"
);
const { proxyAwareFetch } = await import("open-sse/utils/proxyFetch.js");

let fetchMock;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  proxyAwareFetch.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonRes(status, body = "{}") {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

describe("BaseExecutor.buildHeaders merges per-endpoint custom headers (#149)", () => {
  const exec = new BaseExecutor("openai-compatible-x", {});
  const creds = {
    apiKey: "sk_default",
    providerSpecificData: {
      customHeaders: {
        "x-gateway-token": "abc",
        "Authorization": "Bearer custom",
        "content-length": "9",
        "Host": "evil.example.com",
        badKey: 123,
      },
    },
  };

  it("applies custom headers after auth (custom wins over default Bearer)", () => {
    const headers = exec.buildHeaders(creds);
    expect(headers["x-gateway-token"]).toBe("abc");
    expect(headers.Authorization).toBe("Bearer custom");
  });

  it("refuses structural headers and non-string values", () => {
    const headers = exec.buildHeaders(creds);
    expect(headers["content-length"]).toBeUndefined();
    expect(headers.Host).toBeUndefined();
    expect(headers.badKey).toBeUndefined();
    // the default auth still present before the override
    expect(Object.keys(headers)).toContain("Content-Type");
  });

  it("is a no-op without customHeaders (non-object / missing psd)", () => {
    const plain = exec.buildHeaders({ apiKey: "sk" });
    expect(plain.Authorization).toBe("Bearer sk");
    const empty = exec.buildHeaders({ apiKey: "sk", providerSpecificData: { customHeaders: [] } });
    expect(empty.Authorization).toBe("Bearer sk");
    expect(applyNodeCustomHeaders({}, null)).toEqual({});
  });

  it("anthropic-compatible keeps x-api-key and still applies custom headers", () => {
    const anthropicExec = new BaseExecutor("anthropic-compatible-x", {});
    const headers = anthropicExec.buildHeaders({
      apiKey: "sk",
      providerSpecificData: { customHeaders: { "x-extra": "v" } },
    });
    expect(headers["x-api-key"]).toBe("sk");
    expect(headers["x-extra"]).toBe("v");
  });
});

describe("compatible connection TEST rides the custom headers (#149)", () => {
  it("openai-compatible /models probe sends the node's custom headers", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200));
    const conn = {
      provider: "openai-compatible-x",
      apiKey: "sk_test",
      providerSpecificData: {
        baseUrl: "https://gw.example.com/v1",
        customHeaders: { "x-gateway-token": "abc" },
      },
    };
    const result = await testApiKeyConnection(conn, null);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toEqual({ valid: true, error: null });
    expect(proxyAwareFetch).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://gw.example.com/v1/models");
    expect(init.headers.Authorization).toBe("Bearer sk_test");
    expect(init.headers["x-gateway-token"]).toBe("abc");
  });

  it("without customHeaders the probe stays the plain Bearer probe", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200));
    const conn = {
      provider: "openai-compatible-x",
      apiKey: "sk_test",
      providerSpecificData: { baseUrl: "https://gw.example.com/v1" },
    };
    await testApiKeyConnection(conn, null);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://gw.example.com/v1/models");
    expect(init.headers.Authorization).toBe("Bearer sk_test");
    expect(Object.keys(init.headers)).not.toContain("x-gateway-token");
  });
});
