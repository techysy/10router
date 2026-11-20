/**
 * Nous Portal provider: registry wiring, Hermes-compatible device-code
 * OAuth shape, and the single-use refresh-token handler.
 *
 * Wire protocol attested against the open-source Hermes Agent client
 * (hermes_cli/auth_nous.py, hermes_cli/auth_device_flow.py, fetched
 * 2026-11-20): device grant with public client_id "hermes-cli", scope
 * "inference:invoke", refresh token carried in the
 * `x-nous-refresh-token` header (NOT the form body). No network in
 * these tests — fetch is stubbed before module import.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS, PROVIDER_OAUTH } from "../../open-sse/providers/index.js";

const FREE_MODEL_IDS = [
  "qwen/qwen4-max:free",
  "meituan/longcat-2.5:free",
  "stepfun/step-3.7-flash:free",
  "tencent/hy4-flash:free",
  "upstage/solar-mini4:free",
];

describe("Nous provider registry", () => {
  const entry = REGISTRY.find((e) => e.id === "nous");

  it("is registered as a free-tier OAuth provider on the Nous inference host", () => {
    expect(entry).toBeDefined();
    expect(entry.category).toBe("freeTier");
    expect(entry.hasOAuth).toBe(true);
    expect(entry.authModes).toContain("oauth");
    expect(entry.transport.baseUrl).toBe(
      "https://inference-api.nousresearch.com/v1/chat/completions",
    );
    expect(entry.transport.validateUrl).toBe(
      "https://inference-api.nousresearch.com/v1/models",
    );
    expect(entry.modelsFetcher).toEqual({
      url: "https://inference-api.nousresearch.com/v1/models",
      type: "openai",
    });
    expect(entry.passthroughModels).toBe(true);
  });

  it("carries the public Hermes OAuth client config", () => {
    expect(entry.oauth.clientId).toBe("hermes-cli");
    expect(entry.oauth.deviceCodeUrl).toBe(
      "https://portal.nousresearch.com/api/oauth/device/code",
    );
    expect(entry.oauth.tokenUrl).toBe("https://portal.nousresearch.com/api/oauth/token");
    expect(entry.oauth.refreshUrl).toBe("https://portal.nousresearch.com/api/oauth/token");
    expect(entry.oauth.scope).toBe("inference:invoke");
    expect(PROVIDER_OAUTH["nous"]).toEqual(entry.oauth);
    expect(PROVIDERS["nous"].format).toBe("openai");
  });

  it("hardcodes the :free roster in the static model list (alias-trick baseline)", () => {
    const ids = entry.models.map((m) => m.id);
    for (const id of FREE_MODEL_IDS) expect(ids).toContain(id);
    const listed = PROVIDER_MODELS["nous"].map((m) => m.id);
    for (const id of FREE_MODEL_IDS) expect(listed).toContain(id);
  });
});

const originalFetch = global.fetch;

function mockFetch(payload, { ok = true, status = 200 } = {}) {
  const fn = vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(typeof payload === "string" ? payload : JSON.stringify(payload)),
  });
  global.fetch = fn;
  return fn;
}

describe("Nous device-code OAuth provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    global.fetch = originalFetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("requests a device code with client_id + scope as form data", async () => {
    const fetchMock = mockFetch({
      device_code: "dc-1",
      user_code: "ABCD-EFGH",
      verification_uri: "https://portal.nousresearch.com/device",
      verification_uri_complete: "https://portal.nousresearch.com/device?user_code=ABCD-EFGH",
      expires_in: 900,
      interval: 5,
    });
    const { default: nous } = await import("../../src/lib/oauth/providers/nous.js");
    expect(nous.flowType).toBe("device_code");

    const data = await nous.requestDeviceCode(nous.config);
    expect(data.user_code).toBe("ABCD-EFGH");
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://portal.nousresearch.com/api/oauth/device/code");
    expect(opts.method).toBe("POST");
    const body = new URLSearchParams(opts.body);
    expect(body.get("client_id")).toBe("hermes-cli");
    expect(body.get("scope")).toBe("inference:invoke");
  });

  it("polls with the device_code grant and treats authorization_pending as pending", async () => {
    const fetchMock = mockFetch(
      { error: "authorization_pending", error_description: "waiting" },
      { ok: false, status: 400 },
    );
    const { default: nous } = await import("../../src/lib/oauth/providers/nous.js");

    const result = await nous.pollToken(nous.config, "dc-1");
    expect(result.ok).toBe(true);
    expect(result.data.error).toBe("authorization_pending");
    const body = new URLSearchParams(fetchMock.mock.calls[0][1].body);
    expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(body.get("device_code")).toBe("dc-1");
    expect(body.get("client_id")).toBe("hermes-cli");
  });

  it("mapTokens stamps an absolute expiry and device_code auth method", async () => {
    const { default: nous } = await import("../../src/lib/oauth/providers/nous.js");
    const mapped = nous.mapTokens(
      { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: "inference:invoke" },
      { account: { email: "user@example.com", monthly_charge: 0 } },
    );
    expect(mapped.accessToken).toBe("at-1");
    expect(mapped.refreshToken).toBe("rt-1");
    expect(Date.parse(mapped.expiresAt)).toBeGreaterThan(Date.now());
    expect(mapped.email).toBe("user@example.com");
    expect(mapped.providerSpecificData.authMethod).toBe("device_code");
    expect(mapped.providerSpecificData.plan).toBe("free");
  });
});

describe("refreshNousToken (single-use rotating refresh)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    global.fetch = originalFetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("sends the refresh token in the x-nous-refresh-token header, never the body", async () => {
    const fetchMock = mockFetch({
      access_token: "at-new",
      refresh_token: "rt-rotated",
      expires_in: 3600,
    });
    const { refreshNousToken } = await import("open-sse/services/tokenRefresh/providers.js");

    const result = await refreshNousToken("rt-original", null);
    expect(result.accessToken).toBe("at-new");
    expect(result.refreshToken).toBe("rt-rotated");

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://portal.nousresearch.com/api/oauth/token");
    expect(opts.headers["x-nous-refresh-token"]).toBe("rt-original");
    const body = new URLSearchParams(opts.body);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("client_id")).toBe("hermes-cli");
    expect(body.get("refresh_token")).toBeNull();
  });

  it("classifies refresh_token_reused as an unrecoverable invalid_grant", async () => {
    mockFetch({ error: "refresh_token_reused" }, { ok: false, status: 400 });
    const { refreshNousToken } = await import("open-sse/services/tokenRefresh/providers.js");

    const result = await refreshNousToken("rt-replayed", null);
    expect(result).toEqual({ error: "invalid_grant" });
  });
});
