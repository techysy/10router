// Meoo （秒悟） provider: registry wiring, CLI client-id resolution, and the
// OAuth provider's auth-url / token-mapping contract. No network — the
// live cli-compat behaviour is covered by the CLI-source parity comments
// in open-sse/services/meooAk.js.
//
// Route B (paste-key connections) is covered at the bottom: the control
// plane is stubbed through the proxyFetch mock, the DB through @/models.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS, PROVIDER_OAUTH } from "../../open-sse/providers/index.js";
import {
  MEOO_CLI_PRODUCTION_CLIENT_ID,
  MEOO_CLI_TEST_CLIENT_ID,
  resolveMeooCliClientId,
} from "../../open-sse/shared/meoo/constants.js";
import { MEOO_STATIC_MODEL_SPECS } from "../../open-sse/services/meooModels.js";

const ATTESTED_MODEL_IDS = [
  "qwen3.8-max",
  "qwen3.8-flash",
  "qwen3.7-max",
  "qwen3.7-plus",
  "deepseek-v4.1-flash-1017",
  "deepseek-v4-pro-0813",
  "deepseek-v4-flash-0731",
  "glm-5.2-fast-preview",
  "glm-5.2",
];

describe("Meoo provider registry", () => {
  const entry = REGISTRY.find((e) => e.id === "meoo");

  it("is registered as an OAuth provider on the OpenAI-compatible gateway", () => {
    expect(entry).toBeDefined();
    expect(entry.category).toBe("oauth");
    expect(entry.hasOAuth).toBe(true);
    expect(PROVIDERS["meoo"]).toBeDefined();
    expect(PROVIDERS["meoo"].format).toBe("openai");
    expect(PROVIDERS["meoo"].baseUrl).toBe(
      "https://api.meoo.host/meoo-ai/compatible-mode/v1/chat/completions",
    );
  });

  it("injects the OAuth client into transport (providers/index.js contract)", () => {
    expect(PROVIDERS["meoo"].clientId).toBe(MEOO_CLI_PRODUCTION_CLIENT_ID);
    expect(PROVIDERS["meoo"].tokenUrl).toBe("https://meoo.com/oauth/token");
    expect(PROVIDER_OAUTH["meoo"].scope).toBe("cli.compat");
    expect(PROVIDER_OAUTH["meoo"].refresh).toEqual({ encoding: "form" });
  });

  it("seeds the attested static models, all covered by the spec table", () => {
    const ids = (PROVIDER_MODELS["meoo"] || []).map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(ATTESTED_MODEL_IDS));
    for (const id of ids) {
      expect(MEOO_STATIC_MODEL_SPECS[id], `spec for ${id}`).toBeDefined();
    }
  });

  it("keeps providers/meoo.json in sync with the registry model list", () => {
    const catalog = JSON.parse(
      readFileSync(resolve(__dirname, "../../providers/meoo.json"), "utf8"),
    );
    expect(catalog.provider).toBe("meoo");
    const jsonIds = catalog.models.map((m) => m.id).sort();
    const registryIds = (entry.models || []).map((m) => m.id).sort();
    expect(jsonIds).toEqual(registryIds);
  });
});

describe("resolveMeooCliClientId (CLI oauth.js parity)", () => {
  it("uses the production client only for exact production hostnames", () => {
    expect(resolveMeooCliClientId("https://meoo.com")).toBe(MEOO_CLI_PRODUCTION_CLIENT_ID);
    expect(resolveMeooCliClientId("https://gray-meoo.aliyun-inc.com")).toBe(MEOO_CLI_PRODUCTION_CLIENT_ID);
    expect(resolveMeooCliClientId("https://pre-release.example.com")).toBe(MEOO_CLI_TEST_CLIENT_ID);
    expect(resolveMeooCliClientId("http://127.0.0.1:8080")).toBe(MEOO_CLI_TEST_CLIENT_ID);
  });
});

describe("Meoo OAuth provider (src/lib/oauth/providers/meoo.js)", () => {
  it("builds a PKCE authorize URL with the CLI's parameter set", async () => {
    const meoo = (await import("../../src/lib/oauth/providers/meoo.js")).default;
    expect(meoo.flowType).toBe("authorization_code_pkce");
    const url = new URL(
      meoo.buildAuthUrl(meoo.config, "https://gw.example/api/oauth/callback", "state-1", "challenge-1"),
    );
    expect(url.origin + url.pathname).toBe("https://meoo.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(MEOO_CLI_PRODUCTION_CLIENT_ID);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("cli.compat");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe("https://gw.example/api/oauth/callback");
    expect(url.searchParams.get("state")).toBe("state-1");
  });

  it("mapTokens stores the resolved project AK as the connection apiKey", async () => {
    const meoo = (await import("../../src/lib/oauth/providers/meoo.js")).default;
    const mapped = meoo.mapTokens(
      { access_token: "at", refresh_token: "rt", expires_in: 3600, openid: "oid-1", tenant_id: "42" },
      {
        identity: { username: "alice", email: "", tenantId: "42" },
        projectApiKey: "meoo_project_service_v1.test",
        projectUrlId: "proj-1",
        projectName: "Demo",
        akStatus: "ok",
      },
    );
    expect(mapped.accessToken).toBe("at");
    expect(mapped.apiKey).toBe("meoo_project_service_v1.test");
    expect(mapped.providerSpecificData.projectApiKey).toBe("meoo_project_service_v1.test");
    expect(mapped.providerSpecificData.projectUrlId).toBe("proj-1");
    expect(mapped.providerSpecificData.akStatus).toBe("ok");
    expect(mapped.email).toBe("alice");
  });

  it("mapTokens without a resolved AK leaves apiKey unset and marks it pending", async () => {
    const meoo = (await import("../../src/lib/oauth/providers/meoo.js")).default;
    const mapped = meoo.mapTokens(
      { access_token: "at", refresh_token: "rt", expires_in: 3600, openid: "oid-2", tenant_id: "" },
      { identity: null, projectApiKey: "", akStatus: "error", akError: "no project" },
    );
    expect(mapped.apiKey).toBeUndefined();
    expect(mapped.providerSpecificData.akStatus).toBe("error");
    expect(mapped.providerSpecificData.akError).toBe("no project");
    expect(mapped.email).toBe("meoo-user-oid-2");
  });
});

// ─── Route B: paste-key connections (control-plane API key) ─────────────

const mocks = vi.hoisted(() => ({
  proxyAwareFetch: vi.fn(),
  createProviderConnection: vi.fn(),
  nextJson: vi.fn((body, init) => ({ status: init?.status || 200, body })),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.proxyAwareFetch,
}));

vi.mock("next/server", () => ({
  NextResponse: { json: mocks.nextJson },
}));

vi.mock("@/models", () => ({
  createProviderConnection: mocks.createProviderConnection,
}));

const PROJECT_AK = "meoo_project_service_v1.test-ak";

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, statusText: "", json: async () => body };
}

// Stub the cli-compat control plane: identity / projects (two projects —
// the resolver must pick the first) / cloud environment.
function mockControlPlane({ identityStatus = 200, projectsStatus = 200 } = {}) {
  mocks.proxyAwareFetch.mockImplementation(async (url) => {
    const u = String(url);
    if (u.endsWith("/account/identity")) {
      if (identityStatus !== 200) {
        return jsonResponse(identityStatus, { errCode: "invalid_token", message: "invalid token" });
      }
      return jsonResponse(200, {
        success: true,
        data: { user: { id: "u-1", name: "alice", email: "alice@example.com", tenant_id: "t-1" } },
      });
    }
    if (u.includes("/projects?")) {
      if (projectsStatus !== 200) {
        return jsonResponse(projectsStatus, { errCode: "invalid_token", message: "invalid token" });
      }
      return jsonResponse(200, {
        success: true,
        data: {
          list: [
            { url_id: "proj-1", name: "Demo App", status: "active", type: "create-desktop" },
            { url_id: "proj-2", name: "Second App", status: "active", type: "create-desktop" },
          ],
          total: 2,
        },
      });
    }
    if (u.includes("/cloud/environment")) {
      return jsonResponse(200, { success: true, data: { enabled: true, meooProjectApiKey: PROJECT_AK } });
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
}

// Stub a control plane where the cli-compat namespace refuses everything
// but the documented /open/v1 namespace answers (dual-namespace fallback).
function mockDocNamespaceOnly() {
  mocks.proxyAwareFetch.mockImplementation(async (url) => {
    const u = String(url);
    if (u.includes("/cli-compat/")) {
      return jsonResponse(401, { errCode: "invalid_token", message: "invalid token" });
    }
    if (u.endsWith("/account/identity")) {
      return jsonResponse(200, {
        success: true,
        data: { user: { id: "u-1", name: "alice", email: "alice@example.com", tenant_id: "t-1" } },
      });
    }
    if (u.includes("/projects?")) {
      return jsonResponse(200, {
        success: true,
        data: { list: [{ id: "proj-1", name: "Demo App", status: "active" }], total: 1 },
      });
    }
    if (u.includes("/cloud/environment")) {
      return jsonResponse(200, { success: true, data: { enabled: true, meooProjectApiKey: PROJECT_AK } });
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
}

describe("Meoo control key format (route B)", () => {
  it("accepts only meoo_ak_ keys with a real body", async () => {
    const { isMeooControlKey } = await import("../../open-sse/shared/meoo/constants.js");
    expect(isMeooControlKey("meoo_ak_1234567890abcdef")).toBe(true);
    expect(isMeooControlKey("meoo_ak_short")).toBe(false);
    expect(isMeooControlKey("meoo_project_service_v1.abc")).toBe(false);
    expect(isMeooControlKey("sk-ant-1234567890")).toBe(false);
    expect(isMeooControlKey("")).toBe(false);
    expect(isMeooControlKey(null)).toBe(false);
    expect(isMeooControlKey(undefined)).toBe(false);
  });
});

describe("Meoo AK re-resolution with only a control key (route B)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockControlPlane();
  });

  it("resolveMeooCredentials resolves the project AK from the stored control key", async () => {
    const controlKey = "meoo_ak_resolve_test_1234567890";
    const { resolveMeooCredentials, getMeooControlKey } = await import(
      "../../open-sse/services/meooAk.js"
    );
    const credentials = { providerSpecificData: { meooControlKey: controlKey } };
    expect(getMeooControlKey(credentials)).toBe(controlKey);

    const resolved = await resolveMeooCredentials(credentials);
    expect(resolved["apiKey"]).toBe(PROJECT_AK);
    expect(resolved.accessToken).toBeUndefined();
    expect(resolved.refreshToken).toBeUndefined();
    // First project in the list wins; its identity rides along for display.
    expect(resolved.providerSpecificData.projectUrlId).toBe("proj-1");
    expect(resolved.providerSpecificData.projectName).toBe("Demo App");
    expect(resolved.providerSpecificData.akStatus).toBe("ok");
    expect(resolved.providerSpecificData.authMethod).toBe("api_key");
    // Every control-plane call carried the control key as the Bearer.
    const auths = mocks.proxyAwareFetch.mock.calls.map((c) => c[1]?.headers?.Authorization);
    expect(auths.length).toBeGreaterThan(0);
    expect(auths.every((h) => h === `Bearer ${controlKey}`)).toBe(true);
  });

  it("refreshMeooToken works without any OAuth token when a control key is stored", async () => {
    const controlKey = "meoo_ak_refresh_test_1234567890";
    const { refreshMeooToken } = await import("../../open-sse/services/tokenRefresh/providers.js");
    const refreshed = await refreshMeooToken(
      "",
      { providerSpecificData: { meooControlKey: controlKey } },
      null,
    );
    expect(refreshed).not.toBeNull();
    expect(refreshed["apiKey"]).toBe(PROJECT_AK);
    expect(refreshed.providerSpecificData.akStatus).toBe("ok");
  });

  it("resolveMeooCredentials still refuses a connection with no credential at all", async () => {
    const { resolveMeooCredentials } = await import("../../open-sse/services/meooAk.js");
    await expect(resolveMeooCredentials({ providerSpecificData: {} })).rejects.toMatchObject({
      code: "MEOO_NO_CREDENTIALS",
    });
  });

  it("initializes an uninitialized cloud environment (POST /cloud) and re-reads it", async () => {
    // Console state 云服务 0/1: environment GET 404s until POST /cloud
    // initializes it; the resolver must POST once, then GET the AK.
    let envGets = 0;
    let cloudPosts = 0;
    mocks.proxyAwareFetch.mockImplementation(async (url, opts) => {
      const u = String(url);
      if (u.endsWith("/account/identity")) {
        return jsonResponse(200, { success: true, data: { user: { id: "u-1", name: "alice" } } });
      }
      if (u.includes("/projects?")) {
        return jsonResponse(200, {
          success: true,
          data: { list: [{ url_id: "proj-1", name: "Demo App", status: "active" }], total: 1 },
        });
      }
      if (u.endsWith("/cloud") && (opts?.method || "GET") === "POST") {
        cloudPosts += 1;
        return jsonResponse(200, { success: true, data: {} });
      }
      if (u.includes("/cloud/environment")) {
        envGets += 1;
        if (cloudPosts === 0) return jsonResponse(404, { errCode: "not_found", message: "cloud environment not found" });
        return jsonResponse(200, { success: true, data: { enabled: true, meooProjectApiKey: PROJECT_AK } });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });

    const controlKey = "meoo_ak_cloudinit_test_123456";
    const { resolveMeooCredentials } = await import("../../open-sse/services/meooAk.js");
    const resolved = await resolveMeooCredentials({ providerSpecificData: { meooControlKey: controlKey } });
    expect(resolved["apiKey"]).toBe(PROJECT_AK);
    expect(cloudPosts).toBe(1);
    expect(envGets).toBeGreaterThanOrEqual(2);
  });

  it("surfaces the initialization error as-is when POST /cloud is refused", async () => {
    mocks.proxyAwareFetch.mockImplementation(async (url, opts) => {
      const u = String(url);
      if (u.includes("/projects?")) {
        return jsonResponse(200, {
          success: true,
          data: { list: [{ url_id: "proj-1", name: "Demo App", status: "active" }], total: 1 },
        });
      }
      if (u.endsWith("/cloud") && (opts?.method || "GET") === "POST") {
        return jsonResponse(403, { errCode: "scope_denied", message: "key lacks cloud scope" });
      }
      if (u.includes("/cloud/environment")) {
        return jsonResponse(404, { errCode: "not_found", message: "cloud environment not found" });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });

    const controlKey = "meoo_ak_cloudfail_test_123456";
    const { resolveMeooCredentials } = await import("../../open-sse/services/meooAk.js");
    await expect(
      resolveMeooCredentials({ providerSpecificData: { meooControlKey: controlKey } }),
    ).rejects.toMatchObject({ status: 403, code: "scope_denied" });
  });
});

describe("POST /api/oauth/meoo/import-apikey (route B)", () => {
  const controlKey = "meoo_ak_import_test_1234567890";

  beforeEach(() => {
    vi.clearAllMocks();
    mockControlPlane();
    mocks.createProviderConnection.mockResolvedValue({
      id: "conn-1",
      provider: "meoo",
      email: "alice@example.com",
      name: "alice@example.com",
    });
  });

  const post = async (body) => {
    const { POST } = await import("../../src/app/api/oauth/meoo/import-apikey/route.js");
    return POST({ json: async () => body });
  };

  it("creates a connection from a pasted control key, AK resolved, keys never echoed", async () => {
    const res = await post({ apiKey: controlKey });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.connection.projectUrlId).toBe("proj-1");
    expect(res.body.connection.projectName).toBe("Demo App");
    expect(res.body.connection.akStatus).toBe("ok");
    expect(JSON.stringify(res.body)).not.toContain(controlKey);
    expect(JSON.stringify(res.body)).not.toContain(PROJECT_AK);

    expect(mocks.createProviderConnection).toHaveBeenCalledTimes(1);
    const arg = mocks.createProviderConnection.mock.calls[0][0];
    expect(arg.provider).toBe("meoo");
    expect(arg["apiKey"]).toBe(PROJECT_AK);
    expect(arg.email).toBe("alice@example.com");
    expect(arg.testStatus).toBe("active");
    expect(arg.providerSpecificData.authMethod).toBe("api_key");
    expect(arg.providerSpecificData.meooControlKey).toBe(controlKey);
    expect(arg.providerSpecificData.projectUrlId).toBe("proj-1");
    expect(arg.providerSpecificData.projectName).toBe("Demo App");
  });

  it("rejects a malformed key before any network or DB work", async () => {
    const res = await post({ apiKey: "sk-not-a-meoo-key" });
    expect(res.status).toBe(400);
    expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
  });

  it("identity refusal does not block import when the projects leg verifies the key", async () => {
    // A scoped key may not be entitled to identity; verification rests on
    // the projects/environment leg (observed against live Meoo).
    mockControlPlane({ identityStatus: 401 });
    const res = await post({ apiKey: controlKey });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mocks.createProviderConnection).toHaveBeenCalledTimes(1);
    const arg = mocks.createProviderConnection.mock.calls[0][0];
    expect(arg["apiKey"]).toBe(PROJECT_AK);
    expect(arg.providerSpecificData.projectUrlId).toBe("proj-1");
  });

  it("rejects a key the projects leg refuses, surfacing Meoo's status and detail verbatim", async () => {
    mockControlPlane({ projectsStatus: 401 });
    const res = await post({ apiKey: controlKey });
    expect(res.status).toBe(401);
    expect(res.body.meooStatus).toBe(401);
    expect(res.body.meooCode).toBe("invalid_token");
    expect(res.body.detail).toContain("invalid token");
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
  });

  it("falls back to the documented /open/v1 namespace when cli-compat refuses", async () => {
    mockDocNamespaceOnly();
    const res = await post({ apiKey: controlKey });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const arg = mocks.createProviderConnection.mock.calls[0][0];
    expect(arg["apiKey"]).toBe(PROJECT_AK);
    expect(arg.providerSpecificData.projectUrlId).toBe("proj-1");
    expect(arg.providerSpecificData.projectName).toBe("Demo App");
  });
});
