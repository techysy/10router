import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #146: the connection-test token refresh used a bare fetch — with a
// connection proxy configured, the refresh POST to oauth2.googleapis.com /
// claude / kiro / cline left through the direct egress, got blocked, and the
// test misjudged healthy credentials as "refresh failed / token expired"
// (proxy-environment reports 2026-11). The refresh now rides
// fetchWithConnectionProxy like every probe around it: proxy configured →
// proxyAwareFetch with the connection's proxy; no proxy → plain fetch.
// These cases pin both paths.

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
  GEMINI_CONFIG: { clientId: "g", clientSecret: "s" },
  ANTIGRAVITY_CONFIG: { clientId: "g", clientSecret: "s" },
  KIRO_CONFIG: { socialRefreshUrl: "https://kiro.social/refresh" },
  CLAUDE_CONFIG: { tokenUrl: "https://claude.token/refresh", clientId: "claude" },
  CLINE_CONFIG: { refreshUrl: "https://cline.refresh/token" },
  KILOCODE_CONFIG: { apiBaseUrl: "https://x" }, KIMCHI_CONFIG: {}, CODEX_CONFIG: {},
}));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));

const { refreshOAuthToken } = await import(
  "../../src/app/api/providers/[id]/test/testUtils.js"
);
const { proxyAwareFetch } = await import("open-sse/utils/proxyFetch.js");

function jsonRes(status, body = "{}") {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

const PROXY = { connectionProxyEnabled: true, connectionProxyUrl: "http://10.0.0.9:7890" };
const tokenBody = JSON.stringify({ access_token: "at", expires_in: 3600 });

let fetchMock;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  proxyAwareFetch.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("connection-test token refresh rides the connection proxy (#146)", () => {
  it("gemini-cli refresh goes through proxyAwareFetch when a connection proxy is configured", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonRes(200, tokenBody));
    const tokens = await refreshOAuthToken({ provider: "gemini-cli", refreshToken: "rt_g" }, PROXY);
    expect(tokens?.accessToken).toBe("at");
    expect(proxyAwareFetch).toHaveBeenCalledOnce();
    const [url, init, proxyCfg] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(init.body.get("grant_type")).toBe("refresh_token");
    expect(proxyCfg).toMatchObject({ connectionProxyEnabled: true, connectionProxyUrl: "http://10.0.0.9:7890" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gemini-cli refresh stays a plain fetch without a proxy", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, tokenBody));
    const tokens = await refreshOAuthToken({ provider: "gemini-cli", refreshToken: "rt_g" }, null);
    expect(tokens?.accessToken).toBe("at");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("claude refresh rides the proxy too", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonRes(200, tokenBody));
    const tokens = await refreshOAuthToken({ provider: "claude", refreshToken: "rt_c" }, PROXY);
    expect(tokens?.accessToken).toBe("at");
    const [url] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe("https://claude.token/refresh");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("kiro social refresh rides the proxy", async () => {
    // The kiro social endpoint answers camelCase (data.accessToken), unlike
    // the google/claude refresh bodies.
    proxyAwareFetch.mockResolvedValueOnce(jsonRes(200, JSON.stringify({ accessToken: "at", expiresIn: 3600 })));
    const tokens = await refreshOAuthToken({ provider: "kiro", refreshToken: "rt_k" }, PROXY);
    expect(tokens?.accessToken).toBe("at");
    const [url] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe("https://kiro.social/refresh");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a proxy-blocked refresh reads as refresh failure, not a hang", async () => {
    proxyAwareFetch.mockRejectedValueOnce(new Error("proxy connect ECONNREFUSED"));
    const tokens = await refreshOAuthToken({ provider: "gemini-cli", refreshToken: "rt_g" }, PROXY);
    expect(tokens).toBeNull();
  });
});
