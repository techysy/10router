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
      // #164: apikey 通道（CD sk-key 场景）与 OAuth 双模并存
      expect(entry.authModes).toEqual(["oauth", "apikey"]);
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
    // Static rosters trimmed to the LIVE-verified sets (2026-11-22 client
    // cross-check): intl = 3 qwork-* tiers + 6 direct; CN = 2 tiers + 11
    // direct. The burned preview key (qmodel_latest) and the intl-deepseek
    // naming (deepseek-v4-pro) are gone — they never existed client-side.
    const intlIds = intl.models.map((m) => m.id);
    expect(intlIds).toEqual([
      "qwork-auto", "qwork-advanced", "qwork-ultimate",
      "qwen4-max", "qwen3.8-max", "deepseek-flash", "glm-5.3-flash", "kimi-k3.1-pro", "minimax-m3.1-flash",
    ]);
    const cnIds = cn.models.map((m) => m.id);
    expect(cnIds).toEqual([
      "flash", "pro", "qwen4-max", "qwen3.8-max-preview", "qwen3.8-flash", "ling-3.1-flash",
      "deepseek-flash", "deepseek-v4-pro", "glm-5.3", "glm-5.3-flash", "kimi-k3.1-pro",
      "minimax-m3.1-flash", "step-5-preview",
    ]);
    // CN's tier key "flash" stays routable; intl's tiers ride the qwork-* keys.
    expect(PROVIDER_MODELS[cn.alias].map((m) => m.id)).toContain("flash");
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
    // One catalog pass = model/list + chat-modes (two calls); count the
    // model/list ones specifically.
    const modelListCalls = proxyAwareFetchMock.mock.calls.filter(([u]) => String(u).includes("model/list"));
    expect(modelListCalls).toHaveLength(2);
    const [url1, opts1] = modelListCalls[0];
    const [, opts2] = modelListCalls[1];
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

it("hides tier keys from the chat-modes catalog (client picker parity)", async () => {
    proxyAwareFetchMock.mockImplementation((url) => {
      const payload = String(url).includes("/api/desktop/chat-modes")
        ? { schema_version: 2, catalog: [
            { key: "qwen3.8-flash", i18n: { display_name: { en: "Standard", zh: "标准" } }, frontier: false, is_default: true, enable: true, max_input_tokens: 1000000, price_factor: 1 },
            { key: "glm-5.3", i18n: { display_name: { en: "Pro", zh: "高级" } }, frontier: false, enable: true, max_input_tokens: 1000000, price_factor: 1 },
            { key: "gpt-6.1-sol", i18n: { display_name: { en: "Flagship", zh: "旗舰" } }, frontier: false, enable: true, max_input_tokens: 1000000, price_factor: 1 },
            { key: "qwen4-max", i18n: { display_name: { en: "Qwen4-Max" } }, frontier: true, enable: true, format: "anthropic/messages", max_input_tokens: 1000000, price_factor: 1.4 },
            { key: "qwen3.8-max", i18n: { display_name: { en: "Qwen3.8-Max" } }, frontier: true, enable: true, max_input_tokens: 1000000, price_factor: 1.9 },
            { key: "qwen3.8-flash", i18n: { display_name: { en: "Qwen3.8-Flash" } }, frontier: true, enable: true, max_input_tokens: 1000000, price_factor: 0.1 },
            { key: "deepseek-flash", i18n: { display_name: { en: "DeepSeek-V4.1-Flash" } }, frontier: true, enable: true, max_input_tokens: 1000000, price_factor: 0.2 },
            { key: "glm-5.3", i18n: { display_name: { en: "GLM-5.3" } }, frontier: true, enable: true, max_input_tokens: 1000000, price_factor: 1.3 },
            { key: "glm-5.3-flash", i18n: { display_name: { en: "GLM-5.3-Flash" } }, frontier: true, enable: true, max_input_tokens: 1000000, price_factor: 0.2 },
            { key: "kimi-k3.1-pro", i18n: { display_name: { en: "Kimi-K3.1-Pro" } }, frontier: true, enable: true, max_input_tokens: 1000000, price_factor: 2.6 },
            { key: "minimax-m3.1-flash", i18n: { display_name: { en: "MiniMax-M3.1-Flash" } }, frontier: true, enable: true, max_input_tokens: 1000000, price_factor: 0.2 },
          ] }
        : { qwork: [
            { key: "qwork-auto", display_name: "Standard (qwork)" },
            { key: "qwork-advanced", display_name: "Advanced (qwork)" },
            { key: "qwork-ultimate", display_name: "Flagship (qwork)" },
          ], chat: [], app: [] };
      return Promise.resolve({ ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) });
    });
    const { resolveQwenWorkModels } = await import("../../open-sse/services/qwenworkModels.js");
    const result = await resolveQwenWorkModels({
      accessToken: "at-1",
      provider: "qwenwork",
      providerSpecificData: { userId: "u-tier-1" },
    });
    // 3 qwork-* tiers + 6 direct (the tier-key collisions qwen3.8-flash / glm-5.3 drop)
    expect(result.models.map((m) => m.id)).toEqual([
      "qwork-auto", "qwork-advanced", "qwork-ultimate",
      "qwen4-max", "qwen3.8-max", "deepseek-flash", "glm-5.3-flash", "kimi-k3.1-pro", "minimax-m3.1-flash",
    ]);
    expect(result.rawConfigs.get("qwen4-max").format).toBe("anthropic/messages");
    expect(result.rawConfigs.get("qwen3.8-flash")).toBeUndefined();
  });

it("price_factor 0 without an active promotion is NOT free (intl tiers bill from the credit pool)", async () => {
    proxyAwareFetchMock.mockImplementation((url) => {
      const payload = String(url).includes("/api/desktop/chat-modes")
        ? { schema_version: 2, catalog: [
            { key: "qwen4-max", i18n: { display_name: { en: "Qwen4-Max" } }, frontier: true, enable: true, format: "anthropic/messages", max_input_tokens: 1000000, price_factor: 1.4 },
          ] }
        : { qwork: [
            { key: "qwork-auto", display_name: "Standard (qwork)", price_factor: 0 },
            { key: "qwork-advanced", display_name: "Advanced (qwork)", price_factor: 0, promotion: { badge: { zh: "会员限免" }, active: true, ruleId: "ffm-1", timezone: "Asia/Shanghai", windowEnd: "23:59", windowStart: "00:00" } },
          ], chat: [], app: [] };
      return Promise.resolve({ ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) });
    });
    const { resolveQwenWorkModels } = await import("../../open-sse/services/qwenworkModels.js");
    const result = await resolveQwenWorkModels({
      accessToken: "at-1",
      provider: "qwenwork",
      providerSpecificData: { userId: "u-zero-1" },
    });
    // Live 2026-11-22: a 2,136-token qwork-auto chat drew ~0.52 credits —
    // price_factor 0 on intl tiers means "no published factor", not free.
    expect(result.rawConfigs.get("qwork-auto").price_factor).toBe(0);
    expect(result.models.find((m) => m.id === "qwork-auto").rateMultiplier).toBeNull();
    // CN-style promoted zero keeps the free semantics (会员限免).
    expect(result.models.find((m) => m.id === "qwork-advanced").rateMultiplier).toBe(0);
    expect(result.models.find((m) => m.id === "qwen4-max").rateMultiplier).toBe(1.4);
    // The dashboard tooltip explains the free ride from the promotion's own
    // badge text — the passthrough below is the contract that carries
    // 「会员限免」to the model row (ModelRow promotionBadgeNote reads it).
    expect(result.models.find((m) => m.id === "qwork-advanced").promotion.badge.zh).toBe("会员限免");
  });

it("stored-value card semantics for null-total accounts + degraded copy on 401 (#164)", async () => {
    proxyAwareFetchMock.mockImplementation((url) => {
      if (String(url).includes("account-context")) {
        return Promise.resolve({ ok: false, status: 401, json: async () => ({}), text: async () => "" });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => modelListBody, text: async () => JSON.stringify(modelListBody) });
    });
    const { getQwenWorkUsage } = await import("../../open-sse/services/usage/qwenwork.js");
    const degraded = await getQwenWorkUsage("at-expired", "qwenwork");
    // CD access-only syncs last ~7 days — the card degrades with a re-sync
    // instruction instead of rendering dead numbers.
    expect(degraded.message).toContain("expired or revoked");
    expect(degraded.message).toContain("CreditDaddy");

    proxyAwareFetchMock.mockImplementation((url) => {
      // 个人版余额制: quota.total/used are null (issue #164 CD-observed shape)
      const payload = String(url).includes("account-context")
        ? { data: { plan: { name: "个人基础版" }, quota: { total: null, used: null, remaining: 699.58 } } }
        : modelListBody;
      return Promise.resolve({ ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) });
    });
    const usage = await getQwenWorkUsage("at-1", "qwenwork");
    const row = usage.quotas.credits;
    expect(row.isCreditBalance).toBe(true);
    expect(row.total).toBe(699.58);
    expect(row.remaining).toBe(699.58);
    expect(row.used).toBe(0);
    expect(usage.plan).toBe("个人基础版");
  });

describe("chat-modes-v2 catalog merge", () => {
  beforeEach(() => {
    proxyAwareFetchMock.mockReset();
  });

  const modelListBody = {
    qwork: [
      { key: "flash", display_name: "标准", is_reasoning: true, is_vl: true, max_input_tokens: 1000000, max_output_tokens: 32768, price_factor: 0.1, enable: true },
    ],
    chat: [],
    app: [],
  };
  const chatModesBody = {
    schema_version: 2,
    catalog: [
      { key: "qwen4-max", i18n: { display_name: { en: "Qwen4-Max", zh: "Qwen4-Max" }, description: { zh: "全维旗舰" } }, enable: true, format: "anthropic/messages", harness: "oc", is_reasoning: true, is_vl: true, max_input_tokens: 1000000, price_factor: 1.4 },
      { key: "glm-5.3", i18n: { display_name: { en: "GLM-5.3", zh: "GLM-5.3" } }, enable: true, is_reasoning: true, is_vl: false, max_input_tokens: 1000000, price_factor: 1.3 },
      { key: "flash", i18n: { display_name: { en: "Qwen3.8-Flash", zh: "Qwen3.8-Flash" } }, enable: true, is_reasoning: true, is_vl: true, max_input_tokens: 1000000, price_factor: 0.1 },
    ],
    subtask_routing: {},
  };

  function routeFetch() {
    proxyAwareFetchMock.mockImplementation((url) => {
      const payload = String(url).includes("/api/desktop/chat-modes") ? chatModesBody : modelListBody;
      return Promise.resolve({ ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) });
    });
  }

  it("merges the chat-modes catalog: new keys appear, config fields survive the union", async () => {
    routeFetch();
    const { resolveQwenWorkModels } = await import("../../open-sse/services/qwenworkModels.js");
    const result = await resolveQwenWorkModels({
      accessToken: "at-1",
      provider: "qwenwork",
      providerSpecificData: { userId: "u-merge-1" },
    });
    expect(result.models.map((m) => m.id).sort()).toEqual(["flash", "glm-5.3", "qwen4-max"]);
    const q4 = result.rawConfigs.get("qwen4-max");
    expect(q4.display_name).toBe("Qwen4-Max");
    expect(q4.format).toBe("anthropic/messages");
    // chat-modes fields win on overlap; model/list-only fields survive
    const flash = result.rawConfigs.get("flash");
    expect(flash.display_name).toBe("Qwen3.8-Flash");
    expect(flash.max_output_tokens).toBe(32768);
    const modelsById = Object.fromEntries(result.models.map((m) => [m.id, m]));
    expect(modelsById["qwen4-max"].rateMultiplier).toBe(1.4);
  });

  it("keeps the model/list catalog when chat-modes fetch fails", async () => {
    proxyAwareFetchMock.mockImplementation((url) => {
      if (String(url).includes("/api/desktop/chat-modes")) {
        return Promise.resolve({ ok: false, status: 503, json: async () => ({}), text: async () => "" });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => modelListBody, text: async () => JSON.stringify(modelListBody) });
    });
    const { resolveQwenWorkModels } = await import("../../open-sse/services/qwenworkModels.js");
    const result = await resolveQwenWorkModels({
      accessToken: "at-1",
      provider: "qwenwork",
      providerSpecificData: { userId: "u-fallback-1" },
    });
    expect(result.models.map((m) => m.id)).toEqual(["flash"]);
  });

  it("usage credits row carries the meoo-style expiringBatch channel", async () => {
    proxyAwareFetchMock.mockImplementation((url) => {
      const payload = String(url).includes("account-context")
        ? { data: { plan: { name: "Pro", next_refresh_date: "2026-12-20T00:00:00+08:00" }, quota: { total: 1000, used: 200, remaining: 800 } } }
        : modelListBody;
      return Promise.resolve({ ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) });
    });
    const { getQwenWorkUsage } = await import("../../open-sse/services/usage/qwenwork.js");
    const usage = await getQwenWorkUsage("at-1", "qwenwork");
    const row = usage.quotas.credits;
    expect(row.remaining).toBe(800);
    expect(row.expiringBatch).toMatchObject({ remaining: 800 });
    expect(typeof row.expiringBatch.resetAt).toBe("string");
  });
});
