import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Pure System One decision providers (drex / v1m / thx) had no entry in the
// connection-test provider switch, so the dashboard's Test button answered
// "Provider test not supported" for a healthy key and the provider card kept
// showing "N Added" (testStatus "unknown") even while the model-level ping
// went green. These cases pin both probe paths to the decision endpoint.

// Heavy app-side deps of testUtils — none of them are exercised here.
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

const { testApiKeyConnection } = await import("../../src/app/api/providers/[id]/test/testUtils.js");
const { POST: validate } = await import("../../src/app/api/providers/validate/route.js");

const DECISION_BODY = JSON.stringify({
  answers: { probe: { type: "noul", noul: 0.7 } },
});

function conn(provider, extra = {}) {
  return { provider, apiKey: "nace_sk_test", authType: "apikey", ...extra };
}

function jsonRes(status, body = DECISION_BODY) {
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

describe("testApiKeyConnection — pure System One providers", () => {
  it.each([
    ["drex", "https://drex.nace.ai/v1/systemone", "drex-v1.0"],
    ["nace", "https://console.nace.ai/v1/systemone", "drex-max"],
    ["v1m", "https://v1m.ir/v1/systemone", "rev-latest"],
    ["thx", "https://api.hal-x.ai/v1/systemone", "thx-01"],
  ])("%s probes its decision endpoint with a typed decision and Bearer auth", async (provider, url, model) => {
    fetchMock.mockResolvedValue(jsonRes(200));

    const result = await testApiKeyConnection(conn(provider));

    expect(result).toEqual({ valid: true, error: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(url);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer nace_sk_test");
    const body = JSON.parse(init.body);
    expect(body.model).toBe(model);
    expect(body.state).toBeTruthy();
    expect(body.questions.probe.type).toBe("noul");
  });

  it("a bad key (401/403) fails; a non-auth 4xx means the key was accepted", async () => {
    for (const status of [401, 403]) {
      fetchMock.mockResolvedValueOnce(jsonRes(status, '{"error":"Invalid API key"}'));
      expect(await testApiKeyConnection(conn("drex"))).toEqual({ valid: false, error: "Invalid API key" });
    }
    // 422 = payload/model rejected, auth passed
    fetchMock.mockResolvedValueOnce(jsonRes(422, '{"error":"bad model"}'));
    expect(await testApiKeyConnection(conn("drex"))).toEqual({ valid: true, error: null });
  });

  it("THX-01's 404-with-a-decision-body is never read as a pass", async () => {
    // Live behaviour: an unauthenticated POST answers 404 carrying a full
    // answers object. A 404 also means "endpoint moved" — either way it must
    // not turn into green.
    fetchMock.mockResolvedValue(jsonRes(404));
    const result = await testApiKeyConnection(conn("thx"));
    expect(result.valid).toBe(false);
  });

  it("honours the connection-level baseUrl override (mirrors handleSystemoneCore)", async () => {
    fetchMock.mockResolvedValue(jsonRes(200));
    await testApiKeyConnection(conn("thx", { providerSpecificData: { baseUrl: "https://gateway.local/v1/systemone/" } }));
    expect(fetchMock.mock.calls[0][0]).toBe("https://gateway.local/v1/systemone");
  });

  it("dual-surface providers are not hijacked (codiv keeps its /models probe)", async () => {
    fetchMock.mockResolvedValue(jsonRes(200, '{"data":[]}'));
    await testApiKeyConnection(conn("codiv"));
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toContain("/models");
    expect(init.method).toBeUndefined(); // plain GET
  });
});

describe("POST /api/providers/validate — pure System One providers", () => {
  function req(body) {
    return { json: async () => body };
  }

  it("validates drex against its decision endpoint instead of returning 400", async () => {
    fetchMock.mockResolvedValue(jsonRes(200));
    const res = await validate(req({ provider: "drex", apiKey: "nace_sk_test" }));
    expect(res.status).toBe(200);
    expect((await res.json()).valid).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe("https://drex.nace.ai/v1/systemone");
  });

  it("validates nace against console.nace.ai decision endpoint", async () => {
    fetchMock.mockResolvedValue(jsonRes(200));
    const res = await validate(req({ provider: "nace", apiKey: "nace_sk_test" }));
    expect(res.status).toBe(200);
    expect((await res.json()).valid).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe("https://console.nace.ai/v1/systemone");
  });

  it("maps 401 to invalid and a 404 to invalid (THX quirk)", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(401, '{"error":"nope"}'));
    expect((await (await validate(req({ provider: "thx", apiKey: "sk-bad" }))).json()).valid).toBe(false);

    fetchMock.mockResolvedValueOnce(jsonRes(404));
    expect((await (await validate(req({ provider: "thx", apiKey: "sk-x" }))).json()).valid).toBe(false);
  });

  it("a network failure is reported as maintenance, not a bad key", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const data = await (await validate(req({ provider: "v1m", apiKey: "k" }))).json();
    expect(data.valid).toBe(false);
    expect(data.maintenance).toBe(true);
  });
});
