/**
 * Junie (JetBrains) free-lane provider: registry wiring, JBA PKCE OAuth
 * shape, the id_token-as-credential mapping, the single-use refresh
 * handler, and the executor deltas (Free-license headers, model
 * mapping, stream_options backfill).
 *
 * Wire protocol live-verified 2026-11-23 against the official CLI's
 * behavior: POST ingrazzio-cloud-prod.labs.jb.gg/llm/vllm/v1/chat/
 * completions with Bearer **id_token** + X-Forced-License-Free: true;
 * JUNIE_API_KEY (perm-) answers 403 NO_LICENSE on free accounts and is
 * not used anywhere here. No network in these tests — fetch is stubbed
 * before module import.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS, PROVIDER_OAUTH } from "../../open-sse/providers/index.js";
import {
  JUNIE_CHAT_URL,
  JUNIE_FREE_HEADERS,
  JUNIE_UPSTREAM_MODEL,
  resolveJunieUpstreamModel,
} from "../../open-sse/shared/junie/constants.js";

function fakeJwt(payload) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64({ alg: "RS256", typ: "JWT" })}.${b64(payload)}.fakesig`;
}

describe("Junie provider registry", () => {
  const entry = REGISTRY.find((e) => e.id === "junie");

  it("is registered as an OAuth provider on the Ingrazzio vllm lane", () => {
    expect(entry).toBeDefined();
    expect(entry.category).toBe("oauth");
    expect(entry.hasOAuth).toBe(true);
    expect(entry.authModes).toEqual(["oauth"]);
    expect(entry.transport.baseUrl).toBe(JUNIE_CHAT_URL);
    expect(PROVIDERS["junie"].format).toBe("openai");
  });

  it("carries the public junie-cli OAuth client config", () => {
    expect(entry.oauth.clientId).toBe("junie-cli");
    expect(entry.oauth.authorizeUrl).toBe("https://junie.jetbrains.com/cli-auth");
    expect(entry.oauth.tokenUrl).toBe("https://oauth.account.jetbrains.com/oauth2/token");
    expect(entry.oauth.refreshUrl).toBe("https://oauth.account.jetbrains.com/oauth2/token");
    expect(entry.oauth.scope).toBe("offline_access openid jb-authn-service");
    expect(entry.oauth.redirectUri).toBe("http://localhost:62345");
    expect(PROVIDER_OAUTH["junie"]).toEqual(entry.oauth);
  });

  it("exposes exactly one user-facing model key for the free lane", () => {
    expect(entry.models).toEqual([{ id: "junie-lite", name: "Junie Lite 免费车道" }]);
    const listed = PROVIDER_MODELS["junie"].map((m) => m.id);
    expect(listed).toEqual(["junie-lite"]);
    expect(resolveJunieUpstreamModel("junie-lite")).toBe(JUNIE_UPSTREAM_MODEL);
    expect(JUNIE_UPSTREAM_MODEL).toBe("Qwen/Qwen3.6-27B-FP8");
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

describe("Junie PKCE OAuth provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    global.fetch = originalFetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("builds the authorize URL exactly like the CLI (no response_type)", async () => {
    const { default: junie } = await import("../../src/lib/oauth/providers/junie.js");
    expect(junie.flowType).toBe("authorization_code_pkce");

    const url = new URL(
      junie.buildAuthUrl(junie.config, "http://localhost:9999/callback", "state-1", "challenge-1"),
    );
    expect(url.origin + url.pathname).toBe("https://junie.jetbrains.com/cli-auth");
    expect(url.searchParams.get("client_id")).toBe("junie-cli");
    expect(url.searchParams.get("scope")).toBe("offline_access openid jb-authn-service");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    // The registered redirect wins over the caller-passed one.
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:62345");
    expect(url.searchParams.get("response_type")).toBeNull();
  });

  it("exchanges the code with a form body (grant/code/verifier/client/redirect)", async () => {
    const idToken = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, email: "user@example.com", name: "User One" });
    const fetchMock = mockFetch({
      access_token: "at-1",
      id_token: idToken,
      refresh_token: "rt-1",
      expires_in: 3600,
      scope: "offline_access openid jb-authn-service",
    });
    const { default: junie } = await import("../../src/lib/oauth/providers/junie.js");

    const tokens = await junie.exchangeToken(junie.config, "code-1", "http://localhost:62345", "verifier-1", "state-1");
    expect(tokens.id_token).toBe(idToken);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://oauth.account.jetbrains.com/oauth2/token");
    expect(opts.method).toBe("POST");
    const body = new URLSearchParams(opts.body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("code-1");
    expect(body.get("code_verifier")).toBe("verifier-1");
    expect(body.get("client_id")).toBe("junie-cli");
    expect(body.get("redirect_uri")).toBe("http://localhost:62345");
  });

  it("mapTokens stores the id_token as the credential and stamps its own expiry", async () => {
    const exp = Math.floor(Date.now() / 1000) + 1800;
    const idToken = fakeJwt({ exp, email: "user@example.com", name: "User One" });
    const { default: junie } = await import("../../src/lib/oauth/providers/junie.js");

    const mapped = junie.mapTokens({
      access_token: "at-1",
      id_token: idToken,
      refresh_token: "rt-1",
      expires_in: 3600,
      scope: "offline_access openid jb-authn-service",
    });
    expect(mapped.accessToken).toBe(idToken);
    expect(mapped.idToken).toBe(idToken);
    expect(mapped.refreshToken).toBe("rt-1");
    expect(mapped.expiresAt).toBe(new Date(exp * 1000).toISOString());
    expect(mapped.email).toBe("user@example.com");
    expect(mapped.displayName).toBe("User One");
    expect(mapped.providerSpecificData.authMethod).toBe("pkce");
  });
});

describe("refreshJunieToken (single-use rotating refresh, id_token credential)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    global.fetch = originalFetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("posts the form refresh and returns the NEW id_token + rotated refresh token", async () => {
    const newIdToken = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const fetchMock = mockFetch({
      access_token: "at-new",
      id_token: newIdToken,
      refresh_token: "rt-rotated",
      expires_in: 3600,
    });
    const { refreshJunieToken } = await import("open-sse/services/tokenRefresh/providers.js");

    const result = await refreshJunieToken("rt-original-junie-a", null);
    expect(result.accessToken).toBe(newIdToken);
    expect(result.idToken).toBe(newIdToken);
    expect(result.refreshToken).toBe("rt-rotated");
    expect(result.expiresIn).toBeGreaterThan(3500);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://oauth.account.jetbrains.com/oauth2/token");
    const body = new URLSearchParams(opts.body);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt-original-junie-a");
    expect(body.get("client_id")).toBe("junie-cli");
  });

  it("classifies invalid_grant as unrecoverable", async () => {
    mockFetch({ error: "invalid_grant" }, { ok: false, status: 400 });
    const { refreshJunieToken } = await import("open-sse/services/tokenRefresh/providers.js");

    const result = await refreshJunieToken("rt-dead-junie-b", null);
    expect(result).toEqual({ error: "invalid_grant" });
  });

  it("returns null without a network call when no refresh token exists", async () => {
    const fetchMock = mockFetch({});
    const { refreshJunieToken } = await import("open-sse/services/tokenRefresh/providers.js");

    const result = await refreshJunieToken(null, null);
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("JunieExecutor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    global.fetch = originalFetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("maps the model and backfills stream_options.include_usage on streams", async () => {
    const { JunieExecutor } = await import("open-sse/executors/junie.js");
    const executor = new JunieExecutor("junie");

    const streamed = executor.transformRequest("junie-lite", {
      model: "junie-lite",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    expect(streamed.model).toBe(JUNIE_UPSTREAM_MODEL);
    expect(streamed.stream_options).toEqual({ include_usage: true });

    const plain = executor.transformRequest("junie-lite", {
      model: "junie-lite",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });
    expect(plain.model).toBe(JUNIE_UPSTREAM_MODEL);
    expect(plain.stream_options).toBeUndefined();
  });

  it("sends the id_token as Bearer plus the three Free-license headers", async () => {
    const { JunieExecutor } = await import("open-sse/executors/junie.js");
    const executor = new JunieExecutor("junie");

    const headers = executor.buildHeaders({ accessToken: "id-token-1" }, true, JUNIE_CHAT_URL, "junie-lite", {});
    expect(headers.Authorization).toBe("Bearer id-token-1");
    for (const [k, v] of Object.entries(JUNIE_FREE_HEADERS)) {
      expect(headers[k]).toBe(v);
    }
  });

  it("refreshCredentials routes through refreshJunieToken", async () => {
    const newIdToken = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    mockFetch({
      access_token: "at-new",
      id_token: newIdToken,
      refresh_token: "rt-rotated-2",
      expires_in: 3600,
    });
    const { JunieExecutor } = await import("open-sse/executors/junie.js");
    const executor = new JunieExecutor("junie");

    const result = await executor.refreshCredentials(
      { accessToken: "id-token-old", refreshToken: "rt-executor-junie-c" },
      null,
    );
    expect(result.accessToken).toBe(newIdToken);
    expect(result.refreshToken).toBe("rt-rotated-2");
  });

  it("refreshCredentials returns null without a refresh token", async () => {
    const fetchMock = mockFetch({});
    const { JunieExecutor } = await import("open-sse/executors/junie.js");
    const executor = new JunieExecutor("junie");

    const result = await executor.refreshCredentials({ accessToken: "id-token-1" }, null);
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
