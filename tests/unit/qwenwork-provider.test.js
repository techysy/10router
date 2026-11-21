/**
 * QwenWork （千问办公） providers: registry wiring, the Qoder-family device
 * flow with QwenWork's site differences (client_id + redirect_uri on the
 * authorization URL, 200-empty poll = pending, account-context profile),
 * the single-use device-token refresh handler, and the qwork-scene chat
 * body shape.
 *
 * Wire protocol attested against community implementations verified live
 * against the desktop app (magpie-plugin-qwenwork, dsh-qwenwork-connect,
 * qwenwork2api — fetched 2026-11-21). No network in these tests — fetch
 * is stubbed per test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// proxyAwareFetch routes through got-scraping when installed, which would
// bypass a global.fetch stub and hit the network — mock it at the module
// boundary (same pattern as qoder-queue-wait.test.js). QwenWorkService
// uses plain fetch and is stubbed via global.fetch instead.
const { proxyAwareFetchMock } = vi.hoisted(() => ({ proxyAwareFetchMock: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: proxyAwareFetchMock }));

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS, PROVIDER_OAUTH } from "../../open-sse/providers/index.js";
import { QwenWorkService } from "../../src/lib/oauth/services/qwenwork.js";
import { QWENWORK_SITES } from "../../open-sse/shared/qwenwork/constants.js";
import qwenworkProvider, { createQwenWorkProvider } from "../../src/lib/oauth/providers/qwenwork.js";

const originalFetch = global.fetch;

function mockFetch(payload, { ok = true, status = 200 } = {}) {
  const fn = vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => payload,
    text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
  });
  global.fetch = fn;
  return fn;
}

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("QwenWork provider registry", () => {
  const intl = REGISTRY.find((e) => e.id === "qwenwork");
  const cn = REGISTRY.find((e) => e.id === "qwenwork-cn");

  it("registers both deployments as OAuth providers on their gateway hosts", () => {
    for (const [entry, host] of [[intl, "gateway.qwenwork.ai"], [cn, "gateway.qwenwork.cn"]]) {
      expect(entry).toBeDefined();
      expect(entry.category).toBe("oauth");
      expect(entry.hasOAuth).toBe(true);
      expect(entry.authModes).toEqual(["oauth"]);
      expect(entry.transport.baseUrl).toBe(`https://${host}/algo/api/v2/service/pro/sse/agent_chat_generation`);
      expect(entry.passthroughModels).toBe(true);
      expect(PROVIDER_OAUTH[entry.id]).toEqual(entry.oauth);
      expect(PROVIDERS[entry.id]).toBeDefined();
    }
  });

  it("carries the desktop clients' public OAuth identities", () => {
    expect(intl.oauth.clientId).toBe("cc65e5fc-05bd-4f5d-a4e8-0df19aa3d75a");
    expect(intl.oauth.redirectUri).toBe("qwenwork://");
    expect(intl.oauth.loginUrl).toBe("https://gateway.qwenwork.ai/device/selectAccounts");
    expect(intl.oauth.refreshUrl).toBe("https://gateway.qwenwork.ai/api/v1/deviceToken/refresh");
    expect(cn.oauth.clientId).toBe("e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb");
    expect(cn.oauth.redirectUri).toBe("qwenwork-cn://");
    expect(cn.oauth.loginUrl).toBe("https://gateway.qwenwork.cn/device/selectAccounts");
    expect(cn.oauth.refreshUrl).toBe("https://gateway.qwenwork.cn/api/v1/deviceToken/refresh");
  });

  it("hardcodes the tier + direct model keys in the static list", () => {
    for (const entry of [intl, cn]) {
      const ids = entry.models.map((m) => m.id);
      for (const id of ["lite", "flash", "pro", "flagship", "qwen4-max", "deepseek-v4-pro", "glm-5.3", "kimi-k3.1-pro"]) {
        expect(ids).toContain(id);
      }
      const listed = PROVIDER_MODELS[entry.alias].map((m) => m.id);
      expect(listed).toContain("flash");
    }
  });
});

describe("QwenWorkService device flow", () => {
  it("builds the authorization URL with client_id, redirect_uri, machine_id, PKCE", () => {
    const svc = new QwenWorkService(QWENWORK_SITES.qwenwork);
    const flow = svc.initiateDeviceFlow();
    const url = new URL(flow.verificationUriComplete);
    expect(url.origin + url.pathname).toBe("https://gateway.qwenwork.ai/device/selectAccounts");
    expect(url.searchParams.get("client_id")).toBe("cc65e5fc-05bd-4f5d-a4e8-0df19aa3d75a");
    expect(url.searchParams.get("redirect_uri")).toBe("qwenwork://");
    expect(url.searchParams.get("challenge_method")).toBe("S256");
    expect(url.searchParams.get("challenge")).toBeTruthy();
    expect(url.searchParams.get("machine_id")).toBe(flow.machineId);
    expect(url.searchParams.get("nonce")).toBe(flow.nonce);
  });

  it("uses the CN identity on the CN site", () => {
    const svc = new QwenWorkService(QWENWORK_SITES["qwenwork-cn"]);
    const url = new URL(svc.initiateDeviceFlow().verificationUriComplete);
    expect(url.origin + url.pathname).toBe("https://gateway.qwenwork.cn/device/selectAccounts");
    expect(url.searchParams.get("client_id")).toBe("e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb");
    expect(url.searchParams.get("redirect_uri")).toBe("qwenwork-cn://");
  });

  it("poll: 202 is pending, 200-with-token is ok, 200-empty is pending", async () => {
    const svc = new QwenWorkService(QWENWORK_SITES.qwenwork);
    mockFetch({}, { ok: false, status: 202 });
    await expect(svc.pollDeviceToken({ nonce: "n", codeVerifier: "v" })).resolves.toEqual({ status: "pending" });

    mockFetch({ token: "dt-abc", refresh_token: "rt-abc", user_id: "u1", expires_in: 3600 });
    const ok = await svc.pollDeviceToken({ nonce: "n", codeVerifier: "v" });
    expect(ok.status).toBe("ok");
    expect(ok.accessToken).toBe("dt-abc");
    expect(ok.refreshToken).toBe("rt-abc");
    expect(ok.userId).toBe("u1");
    expect(ok.expireTime).toBeGreaterThan(Date.now());

    mockFetch({});
    await expect(svc.pollDeviceToken({ nonce: "n", codeVerifier: "v" })).resolves.toEqual({ status: "pending" });
  });

  it("fetchUserInfo parses the account-context data.user shape", async () => {
    const svc = new QwenWorkService(QWENWORK_SITES.qwenwork);
    mockFetch({ data: { user: { name: "Ada", email: "ada@example.com" }, organization_id: "org9" } });
    await expect(svc.fetchUserInfo("dt-abc")).resolves.toEqual({
      name: "Ada",
      email: "ada@example.com",
      organizationId: "org9",
    });
  });
});

describe("QwenWork OAuth provider definition", () => {
  it("requestDeviceCode plumbs nonce + machineId through the modal shape", async () => {
    const data = await qwenworkProvider.requestDeviceCode();
    expect(qwenworkProvider.flowType).toBe("device_code");
    expect(data.device_code).toBe(data._qwenworkNonce);
    expect(data._qwenworkMachineId).toBeTruthy();
    expect(data.verification_uri).toBe("https://gateway.qwenwork.ai/device/selectAccounts");
    const complete = new URL(data.verification_uri_complete);
    expect(complete.searchParams.get("machine_id")).toBe(data._qwenworkMachineId);
    expect(complete.searchParams.get("client_id")).toBe("cc65e5fc-05bd-4f5d-a4e8-0df19aa3d75a");
  });

  it("mapTokens falls back to a stable synthetic email and stores machineId", () => {
    const mapped = qwenworkProvider.mapTokens({
      access_token: "dt-abc",
      refresh_token: "rt-abc",
      expires_in: 3600,
      _qwenworkUserId: "u1",
      _qwenworkMachineId: "m1",
      _qwenworkName: "",
      _qwenworkEmail: "",
      _qwenworkOrganizationId: "org9",
    });
    expect(mapped.email).toBe("qwenwork-user-u1");
    expect(mapped.providerSpecificData).toEqual({
      authMethod: "device",
      userId: "u1",
      machineId: "m1",
      organizationId: "org9",
    });
    const cn = createQwenWorkProvider("qwenwork-cn");
    expect(cn.config.loginUrl).toBe("https://gateway.qwenwork.cn/device/selectAccounts");
  });
});

describe("refreshQwenWorkToken", () => {
  beforeEach(() => {
    proxyAwareFetchMock.mockReset();
  });

  it("posts { refresh_token, target: 'c' } to the deployment's refresh URL and returns the rotated pair", async () => {
    const { refreshQwenWorkToken } = await import("../../open-sse/services/tokenRefresh.js");
    proxyAwareFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ token: "dt-new", refresh_token: "rt-new", expires_in: 7200 }),
    });
    const out = await refreshQwenWorkToken("rt-old", "qwenwork-cn");
    expect(out).toEqual({ accessToken: "dt-new", refreshToken: "rt-new", expiresIn: 7200 });
    const [url, opts] = proxyAwareFetchMock.mock.calls[0];
    expect(url).toBe("https://gateway.qwenwork.cn/api/v1/deviceToken/refresh");
    expect(JSON.parse(opts.body)).toEqual({ refresh_token: "rt-old", target: "c" });
  });

  it("maps a 401 to invalid_grant so the framework marks the connection expired", async () => {
    const { refreshQwenWorkToken } = await import("../../open-sse/services/tokenRefresh.js");
    proxyAwareFetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ errorCode: "INVALID_TOKEN" }),
    });
    await expect(refreshQwenWorkToken("rt-dead", "qwenwork")).resolves.toEqual({ error: "invalid_grant" });
  });
});

describe("QwenWork catalog scene merge", () => {
  it("merges qwork + chat + app scenes (tier keys may live outside qwork/chat)", async () => {
    const { resolveQwenWorkModels, getQwenWorkModelConfig, clearQwenWorkCatalog } = await import("../../open-sse/services/qwenworkModels.js");
    proxyAwareFetchMock.mockReset();
    proxyAwareFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        chat: [{ key: "deepseek-flash", display_name: "DeepSeek V4 Flash", is_vl: true, is_reasoning: true, max_input_tokens: 1000000 }],
        app: [{ key: "flash", display_name: "标准", is_vl: true, is_reasoning: true, max_input_tokens: 1000000 }],
      }),
      text: async () => "",
    });
    clearQwenWorkCatalog();
    const credentials = {
      provider: "qwenwork-cn",
      accessToken: "dt-abc",
      providerSpecificData: { userId: "u1", machineId: "m1" },
    };
    const resolved = await resolveQwenWorkModels(credentials, { forceRefresh: true });
    expect(resolved.models.map((m) => m.id).sort()).toEqual(["deepseek-flash", "flash"]);
    await expect(getQwenWorkModelConfig(credentials, "flash")).resolves.toMatchObject({ key: "flash" });
    await expect(getQwenWorkModelConfig(credentials, "deepseek-flash")).resolves.toMatchObject({ key: "deepseek-flash" });
  });
});

describe("QwenWork catalog request shape (official-client identity)", () => {
  it("sends Encode=1, the X-QwenWork-* client headers and a stable derived machineId", async () => {
    const { resolveQwenWorkModels, clearQwenWorkCatalog } = await import("../../open-sse/services/qwenworkModels.js");
    proxyAwareFetchMock.mockReset();
    proxyAwareFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ qwork: [{ key: "qwork-auto", display_name: "Auto" }] }),
      text: async () => "",
    });
    clearQwenWorkCatalog();
    // No machineId stored on the connection (the OAuth framework does
    // not hand it back) — the catalog fetch must derive a stable one.
    const credentials = {
      provider: "qwenwork",
      accessToken: "dt-abc",
      providerSpecificData: { userId: "u-intl" },
    };
    await resolveQwenWorkModels(credentials, { forceRefresh: true });
    await resolveQwenWorkModels(credentials, { forceRefresh: true });
    expect(proxyAwareFetchMock).toHaveBeenCalledTimes(2);
    const [url1, opts1] = proxyAwareFetchMock.mock.calls[0];
    const [, opts2] = proxyAwareFetchMock.mock.calls[1];
    expect(url1).toBe("https://gateway.qwenwork.ai/algo/api/v2/model/list?Encode=1");
    expect(opts1.headers["User-Agent"]).toBe("qoderwork/1.2.1");
    expect(opts1.headers["X-QwenWork-Version"]).toBe("1.2.1");
    expect(opts1.headers["X-QwenWork-Release-Version"]).toBe("1.2.1-26092107");
    expect(opts1.headers["X-QwenWork-Build"]).toBe("26092107");
    expect(opts1.headers["X-QwenWork-Channel"]).toBe("stable");
    const machineHeader = (h) => Object.entries(h).find(([k]) => k.toLowerCase() === "cosy-machineid")?.[1];
    expect(machineHeader(opts1.headers)).toBeTruthy();
    expect(machineHeader(opts1.headers)).toBe(machineHeader(opts2.headers));
  });
});

describe("QwenWorkExecutor chat body (qwork scene)", () => {
  it("builds the slim model_config, qoder_work business block and preamble system block", async () => {
    const catalogEntry = {
      key: "flash",
      display_name: "标准",
      format: "openai",
      is_vl: true,
      is_reasoning: true,
      max_input_tokens: 1000000,
      max_output_tokens: 65536,
      source: "system",
    };
    proxyAwareFetchMock.mockReset();
    proxyAwareFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ qwork: [catalogEntry] }),
      text: async () => JSON.stringify({ qwork: [catalogEntry] }),
    });
    const { __test__ } = await import("../../open-sse/executors/qwenwork.js");
    const { clearQwenWorkCatalog } = await import("../../open-sse/services/qwenworkModels.js");
    clearQwenWorkCatalog();
    const credentials = {
      provider: "qwenwork",
      accessToken: "dt-abc",
      providerSpecificData: { userId: "u1", machineId: "m1" },
    };
    const { qworkKey, payload, modelConfig } = await __test__.buildQwenWorkRequestBody({
      model: "qwenwork/flash",
      body: { messages: [{ role: "user", content: "hello" }] },
      credentials,
    });
    expect(qworkKey).toBe("flash");
    expect(modelConfig).toMatchObject({ key: "flash", display_name: "标准", format: "openai", is_vl: true, is_reasoning: true, max_input_tokens: 1000000 });
    expect(payload.business).toMatchObject({ product: "qoder_work", version: "1.1.59", type: "agent" });
    expect(payload.session_type).toBe("qoder_work");
    expect(payload.request_id).toBe(payload.chat_record_id);
    expect(payload.system[0].type).toBe("text");
    expect(payload.system[0].text).toContain("You are QwenWork (qw)");
    expect(payload.messages[0].role).toBe("system");
    expect(payload.parameters).toMatchObject({ enable_thinking: true, context_length: 1000000 });
    expect(payload.model_config).toEqual(modelConfig);
  });
});
