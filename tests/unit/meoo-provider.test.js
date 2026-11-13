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
import { MEOO_STATIC_MODEL_SPECS, clearMeooCatalog } from "../../open-sse/services/meooModels.js";

const ATTESTED_MODEL_IDS = [
  "qwen3.8-max",
  "qwen3.8-flash",
  // The gateway only accepts the all-lowercase id (capitalized 400s live).
  "qwen4-max-preview",
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
  getProviderConnectionById: vi.fn(),
  getProviderNodeById: vi.fn(),
  updateProviderCredentials: vi.fn(),
  getLocalDbConnectionById: vi.fn(),
  refreshAndUpdateCredentials: vi.fn(),
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
  getProviderConnectionById: mocks.getProviderConnectionById,
  getProviderNodeById: mocks.getProviderNodeById,
}));

// The dashboard [id]/models route persists re-resolved credentials through
// this module; stub it so the meoo branch's write-back is assertable
// without the DB layer.
vi.mock("@/sse/services/tokenRefresh", () => ({
  refreshGoogleToken: vi.fn(),
  refreshCodexToken: vi.fn(),
  updateProviderCredentials: mocks.updateProviderCredentials,
}));

// The usage routes read connections through @/lib/localDb (not @/models).
vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: mocks.getLocalDbConnectionById,
  updateProviderConnection: vi.fn(),
}));

// The daily-claim route reuses the usage route's credential-refresh chain;
// stub the parent route module so the OAuth leg is assertable without the
// executor/token-refresh stack.
vi.mock("../../src/app/api/usage/[connectionId]/route.js", () => ({
  refreshAndUpdateCredentials: mocks.refreshAndUpdateCredentials,
}));

// Routes import open-sse/index.js for its fetch-patching side effect; the
// bare entry transitively pulls the translator chain (uuid — absent from
// this sandbox's test node_modules). The modules under test patch nothing.
vi.mock("../../open-sse/index.js", () => ({}));

// The [id]/models route imports every provider's catalog resolver; the
// sibling resolvers pull app dependencies (uuid, …) that this sandbox's
// test node_modules doesn't carry. Stub them — only the meoo branch of
// the route is under test here.
vi.mock("../../open-sse/services/kiroModels.js", () => ({ resolveKiroModels: vi.fn() }));
vi.mock("../../open-sse/services/kimchiModels.js", () => ({ resolveKimchiModels: vi.fn() }));
// The usage dispatch table imports every provider's handler; cursor's
// chain needs uuid (absent in this sandbox). Only the meoo dispatch entry
// is under test here.
vi.mock("../../open-sse/services/usage/cursor.js", () => ({ getCursorUsage: vi.fn() }));
vi.mock("../../open-sse/services/qoderModels.js", () => ({ resolveQoderModels: vi.fn() }));
vi.mock("../../open-sse/services/mimoModels.js", () => ({ resolveMimoModels: vi.fn() }));
vi.mock("../../open-sse/services/grokCliModels.js", () => ({ resolveGrokCliModels: vi.fn() }));
vi.mock("../../open-sse/services/cursorModels.js", () => ({ resolveCursorModels: vi.fn() }));
vi.mock("../../open-sse/shared/zedAuth.js", () => ({ resolveZedModels: vi.fn() }));

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

// ─── Dashboard discovery: GET /api/providers/[id]/models (meoo branch) ──
// The endpoint must serve the LIVE gateway catalog (so models Meoo
// configures later appear without a registry update), fall back to the
// static seeds when the live fetch fails, and persist a re-resolved AK.

describe("GET /api/providers/[id]/models — meoo live catalog (dashboard discovery)", () => {
  const connLive = {
    id: "conn-meoo-live",
    provider: "meoo",
    apiKey: PROJECT_AK,
    providerSpecificData: { projectApiKey: PROJECT_AK, akStatus: "ok" },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    clearMeooCatalog();
    mocks.getProviderNodeById.mockResolvedValue(null);
  });

  const getModels = async (id) => {
    const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");
    return GET(new Request(`http://localhost/api/providers/${id}/models`), {
      params: Promise.resolve({ id }),
    });
  };

  it("returns the live gateway catalog verbatim, including ids outside the static spec table", async () => {
    const gatewayAuths = [];
    mocks.proxyAwareFetch.mockImplementation(async (url, opts) => {
      const u = String(url);
      if (u.includes("api.meoo.host")) {
        gatewayAuths.push(opts?.headers?.Authorization);
        return jsonResponse(200, {
          data: [
            { id: "qwen3.8-flash" },
            { id: "qwen4-max-preview" },
            { id: "glm-5.3-flash" },
          ],
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });
    mocks.getProviderConnectionById.mockResolvedValue(connLive);

    const res = await getModels(connLive.id);
    expect(res.status).toBe(200);
    expect(res.body.provider).toBe("meoo");
    expect(res.body.connectionId).toBe(connLive.id);
    expect(res.body.warning).toBeUndefined();
    expect(gatewayAuths).toEqual([`Bearer ${PROJECT_AK}`]);

    const models = res.body.models;
    // Live catalog as-is — no endpoint-layer filtering against the static
    // table, so a model Meoo adds tomorrow is listed the moment it ships.
    expect(models.map((m) => m.id)).toEqual([
      "qwen3.8-flash",
      "qwen4-max-preview",
      "glm-5.3-flash",
    ]);
    // Spec-table hit under the corrected lowercase key.
    expect(models[1]).toMatchObject({
      name: "Qwen4-Max-Preview",
      contextLength: 1_000_000,
      maxOutputTokens: 131_072,
      isVL: true,
    });
    // Unknown id rides the resolver's fallback spec and is still listed.
    expect(models[2]).toMatchObject({
      name: "glm-5.3-flash",
      contextLength: 200_000,
      maxOutputTokens: 65_536,
      isVL: false,
    });
  });

  it("falls back to the static seed catalog when the live fetch fails", async () => {
    mocks.proxyAwareFetch.mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("api.meoo.host")) return jsonResponse(500, { error: "boom" });
      throw new Error(`unexpected fetch: ${u}`);
    });
    mocks.getProviderConnectionById.mockResolvedValue(connLive);

    const res = await getModels(connLive.id);
    expect(res.status).toBe(200);
    expect(res.body.warning).toContain("falling back to static");
    const ids = res.body.models.map((m) => m.id).sort();
    const seedIds = (PROVIDER_MODELS["meoo"] || []).map((m) => m.id).sort();
    expect(ids).toEqual(seedIds);
    // The corrected lowercase Qwen4 id is what the seeds now carry.
    expect(ids).toContain("qwen4-max-preview");
    expect(ids).not.toContain("Qwen4-Max-Preview");
  });

  it("re-resolves a stale project AK through the control key and persists it", async () => {
    const staleAk = "meoo_project_service_v1.stale-ak";
    const controlKey = "meoo_ak_stale_test_1234567890";
    const conn = {
      id: "conn-meoo-stale",
      provider: "meoo",
      apiKey: staleAk,
      providerSpecificData: {
        meooControlKey: controlKey,
        projectApiKey: staleAk,
        akStatus: "ok",
      },
    };
    mocks.proxyAwareFetch.mockImplementation(async (url, opts) => {
      const u = String(url);
      if (u.includes("api.meoo.host")) {
        if (opts?.headers?.Authorization === `Bearer ${staleAk}`) {
          return jsonResponse(401, { error: "invalid ak" });
        }
        if (opts?.headers?.Authorization === `Bearer ${PROJECT_AK}`) {
          return jsonResponse(200, { data: [{ id: "qwen3.8-max" }] });
        }
        throw new Error("gateway called with an unexpected AK");
      }
      // Control plane legs (same shapes as mockControlPlane above).
      if (u.endsWith("/account/identity")) {
        return jsonResponse(200, {
          success: true,
          data: { user: { id: "u-1", name: "alice", email: "alice@example.com", tenant_id: "t-1" } },
        });
      }
      if (u.includes("/projects?")) {
        return jsonResponse(200, {
          success: true,
          data: {
            list: [{ url_id: "proj-1", name: "Demo App", status: "active", type: "create-desktop" }],
            total: 1,
          },
        });
      }
      if (u.includes("/cloud/environment")) {
        return jsonResponse(200, { success: true, data: { enabled: true, meooProjectApiKey: PROJECT_AK } });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });
    mocks.getProviderConnectionById.mockResolvedValue(conn);

    const res = await getModels(conn.id);
    expect(res.status).toBe(200);
    expect(res.body.models.map((m) => m.id)).toEqual(["qwen3.8-max"]);
    // The re-resolved AK was written back through updateProviderCredentials
    // (the onCredentialsRefreshed wiring shared with /api/v1/models).
    const persistCalls = mocks.updateProviderCredentials.mock.calls.filter((c) => c[0] === conn.id);
    expect(persistCalls.length).toBeGreaterThan(0);
    expect(persistCalls[0][1]).toMatchObject({ apiKey: PROJECT_AK });
  });
});

// ─── Feature A: points balance in the quota window ──────────────────────
// getMeooUsage reads the control-plane points ledger (cli-compat first,
// documented namespace on failure). Credential priority: OAuth access
// token, then the stored control key — never the project AK.

const POINTS_ACCOUNT = { availableBalance: 5800, totalGranted: 10000, totalConsumed: 4200, totalExpired: 0 };

function mockPointsOk() {
  mocks.proxyAwareFetch.mockImplementation(async (url) => {
    const u = String(url);
    if (u.endsWith("/account/points")) {
      return jsonResponse(200, { success: true, data: { account: { ...POINTS_ACCOUNT } } });
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
}

describe("getMeooUsage — points ledger → quota window (feature A)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the credit-pot quotas shape with the OAuth access token", async () => {
    mockPointsOk();
    const { getMeooUsage } = await import("../../open-sse/services/usage/meoo.js");
    const usage = await getMeooUsage("at-oauth-1", {}, null);
    expect(usage.plan).toBe("Meoo");
    expect(usage.quotas).toEqual({
      "Balance （积分）": {
        used: 0,
        total: 5800,
        remainingPercentage: 100,
        resetAt: null,
        unlimited: true,
      },
    });
    const auths = mocks.proxyAwareFetch.mock.calls.map((c) => c[1]?.headers?.Authorization);
    expect(auths).toEqual(["Bearer at-oauth-1"]);
  });

  it("falls back to the stored control key for paste-key connections", async () => {
    mockPointsOk();
    const controlKey = "meoo_ak_usage_test_1234567890";
    const { getMeooUsage } = await import("../../open-sse/services/usage/meoo.js");
    const usage = await getMeooUsage(null, { meooControlKey: controlKey }, null);
    expect(usage.quotas["Balance （积分）"].total).toBe(5800);
    const auths = mocks.proxyAwareFetch.mock.calls.map((c) => c[1]?.headers?.Authorization);
    expect(auths).toEqual([`Bearer ${controlKey}`]);
  });

  it("prefers the access token when both credentials exist", async () => {
    mockPointsOk();
    const { getMeooUsage } = await import("../../open-sse/services/usage/meoo.js");
    await getMeooUsage("at-wins", { meooControlKey: "meoo_ak_loses_test_123456" }, null);
    const auths = mocks.proxyAwareFetch.mock.calls.map((c) => c[1]?.headers?.Authorization);
    expect(auths).toEqual(["Bearer at-wins"]);
  });

  it("guides connections without any control-plane credential, without network", async () => {
    const { getMeooUsage } = await import("../../open-sse/services/usage/meoo.js");
    const usage = await getMeooUsage(null, {}, null);
    expect(usage.quotas).toBeUndefined();
    expect(usage.message).toContain("控制面凭证");
    expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("surfaces Meoo's business-envelope failure verbatim instead of throwing", async () => {
    mocks.proxyAwareFetch.mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith("/account/points")) {
        return jsonResponse(200, { success: false, errCode: "points_denied", message: "points scope denied" });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });
    const { getMeooUsage } = await import("../../open-sse/services/usage/meoo.js");
    const usage = await getMeooUsage("at-1", {}, null);
    expect(usage.plan).toBe("Meoo");
    expect(usage.quotas).toBeUndefined();
    expect(usage.message).toContain("points scope denied");
  });

  it("surfaces an HTTP 401 from the points endpoint", async () => {
    mocks.proxyAwareFetch.mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith("/account/points")) {
        return jsonResponse(401, { errCode: "invalid_token", message: "invalid token" });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });
    const { getMeooUsage } = await import("../../open-sse/services/usage/meoo.js");
    const usage = await getMeooUsage("at-expired", {}, null);
    expect(usage.plan).toBe("Meoo");
    expect(usage.message).toContain("invalid token");
  });

  it("renders a zero balance as an empty pot (not unlimited)", async () => {
    mocks.proxyAwareFetch.mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith("/account/points")) {
        return jsonResponse(200, {
          success: true,
          data: { account: { availableBalance: 0, totalGranted: 5000, totalConsumed: 5000, totalExpired: 0 } },
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });
    const { getMeooUsage } = await import("../../open-sse/services/usage/meoo.js");
    const usage = await getMeooUsage("at-1", {}, null);
    expect(usage.quotas["Balance （积分）"]).toEqual({
      used: 0,
      total: 0,
      remainingPercentage: 0,
      resetAt: null,
      unlimited: false,
    });
  });

  it("is registered in the usage dispatch and admits api-key connections", async () => {
    const entry = REGISTRY.find((e) => e.id === "meoo");
    expect(entry.features?.usageApikey).toBe(true);
    const { USAGE_APIKEY_PROVIDERS } = await import("../../src/shared/constants/providers.js");
    expect(USAGE_APIKEY_PROVIDERS).toContain("meoo");

    mockPointsOk();
    const { getUsageForProvider } = await import("../../open-sse/services/usage.js");
    const usage = await getUsageForProvider(
      { provider: "meoo", accessToken: "at-dispatch", apiKey: PROJECT_AK, providerSpecificData: {} },
      null,
    );
    expect(usage.plan).toBe("Meoo");
    expect(usage.quotas["Balance （积分）"].total).toBe(5800);
  });
});

// ─── Feature B: POST /api/usage/[connectionId]/meoo-daily-claim ─────────
// No claim endpoint exists upstream: the route performs a login-equivalent
// action (OAuth → forced token refresh; paste-key → identity read) and
// verifies against the points ledger. claimed=true requires totalGranted
// to have actually increased.

describe("POST /api/usage/[connectionId]/meoo-daily-claim (feature B)", () => {
  const controlKey = "meoo_ak_claim_test_1234567890";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const postClaim = async (connectionId) => {
    const { POST } = await import(
      "../../src/app/api/usage/[connectionId]/meoo-daily-claim/route.js"
    );
    const res = await POST(
      new Request(`http://localhost/api/usage/${connectionId}/meoo-daily-claim`, { method: "POST" }),
      { params: Promise.resolve({ connectionId }) },
    );
    return { status: res.status, body: await res.json() };
  };

  // Stateful ledger: the daily grant lands when the login-equivalent
  // identity read happens (paste-key path), mirroring Meoo's
  // first-login-of-the-day grant.
  function mockClaimLedger({ grantOnIdentity = true } = {}) {
    const ledger = { availableBalance: 3000, totalGranted: 5000, totalConsumed: 2000, totalExpired: 0 };
    let granted = false;
    mocks.proxyAwareFetch.mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith("/account/identity")) {
        if (grantOnIdentity && !granted) {
          granted = true;
          ledger.totalGranted += 2000;
          ledger.availableBalance += 2000;
        }
        return jsonResponse(200, { success: true, data: { user: { id: "u-1", name: "alice" } } });
      }
      if (u.endsWith("/account/points")) {
        return jsonResponse(200, { success: true, data: { account: { ...ledger } } });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });
    return ledger;
  }

  it("claims via the identity touch for a paste-key connection and reports the verified delta", async () => {
    mockClaimLedger();
    mocks.getLocalDbConnectionById.mockResolvedValue({
      id: "conn-claim-1",
      provider: "meoo",
      authType: "apikey",
      providerSpecificData: { authMethod: "api_key", meooControlKey: controlKey },
    });

    const res = await postClaim("conn-claim-1");
    expect(res.status).toBe(200);
    expect(res.body.claimed).toBe(true);
    expect(res.body.delta).toBe(2000);
    expect(res.body.balance).toBe(5000);
    // The control key does the work but is never echoed back.
    expect(JSON.stringify(res.body)).not.toContain(controlKey);
    // OAuth refresh chain must not run for a paste-key connection.
    expect(mocks.refreshAndUpdateCredentials).not.toHaveBeenCalled();
  });

  it("reports claimed=false when the ledger does not move", async () => {
    mockClaimLedger({ grantOnIdentity: false });
    mocks.getLocalDbConnectionById.mockResolvedValue({
      id: "conn-claim-2",
      provider: "meoo",
      authType: "apikey",
      providerSpecificData: { authMethod: "api_key", meooControlKey: controlKey },
    });

    const res = await postClaim("conn-claim-2");
    expect(res.status).toBe(200);
    expect(res.body.claimed).toBe(false);
    expect(res.body.delta).toBe(0);
    expect(res.body.balance).toBe(3000);
    expect(res.body.message).toContain("今日可能已领取");
  }, 20000);

  it("claims via the forced OAuth refresh and re-reads with the fresh token", async () => {
    const ledger = { availableBalance: 1000, totalGranted: 4000, totalConsumed: 3000, totalExpired: 0 };
    const pointsAuths = [];
    mocks.proxyAwareFetch.mockImplementation(async (url, opts) => {
      const u = String(url);
      if (u.endsWith("/account/points")) {
        pointsAuths.push(opts?.headers?.Authorization);
        return jsonResponse(200, { success: true, data: { account: { ...ledger } } });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });
    const oauthConn = {
      id: "conn-claim-3",
      provider: "meoo",
      authType: "oauth",
      accessToken: "at-old",
      refreshToken: "rt-1",
      providerSpecificData: {},
    };
    mocks.getLocalDbConnectionById.mockResolvedValue(oauthConn);
    // The token exchange is the login-equivalent action: the grant lands
    // server-side, and the route continues with the rotated pair.
    mocks.refreshAndUpdateCredentials.mockImplementation(async (connection) => {
      ledger.totalGranted += 2000;
      ledger.availableBalance += 2000;
      return { connection: { ...connection, accessToken: "at-new", refreshToken: "rt-2" }, refreshed: true };
    });

    const res = await postClaim("conn-claim-3");
    expect(res.status).toBe(200);
    expect(res.body.claimed).toBe(true);
    expect(res.body.delta).toBe(2000);
    expect(res.body.balance).toBe(3000);
    expect(mocks.refreshAndUpdateCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.refreshAndUpdateCredentials.mock.calls[0][1]).toBe(true); // forced
    // Baseline read carried the old token; the verifying re-read the fresh one.
    expect(pointsAuths[0]).toBe("Bearer at-old");
    expect(pointsAuths[pointsAuths.length - 1]).toBe("Bearer at-new");
  });

  it("rejects non-meoo connections with 400 before any network work", async () => {
    mocks.getLocalDbConnectionById.mockResolvedValue({
      id: "conn-claude-1",
      provider: "claude",
      authType: "oauth",
      providerSpecificData: {},
    });
    const res = await postClaim("conn-claude-1");
    expect(res.status).toBe(400);
    expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("404s for an unknown connection", async () => {
    mocks.getLocalDbConnectionById.mockResolvedValue(null);
    const res = await postClaim("conn-missing");
    expect(res.status).toBe(404);
    expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("guides a meoo connection that has no control-plane credential", async () => {
    mocks.getLocalDbConnectionById.mockResolvedValue({
      id: "conn-claim-4",
      provider: "meoo",
      authType: "apikey",
      providerSpecificData: {},
    });
    const res = await postClaim("conn-claim-4");
    expect(res.status).toBe(200);
    expect(res.body.claimed).toBe(false);
    expect(res.body.balance).toBeNull();
    expect(res.body.message).toContain("控制面凭证");
    expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
  });
});

// ─── Feature B (provider page): 每日领积分 on the connection card ───────
// The quota card (ProviderLimits) got the button first, but the provider
// detail page renders connections through ConnectionRow — the button must
// live there too, wired to the same endpoint with the same inline verdict.
// Client component, so this is asserted at source level (the
// codex-cli-version suite's read-and-scan posture).
describe("Provider page ConnectionRow — meoo daily claim button (feature B)", () => {
  const rowSource = readFileSync(
    resolve(__dirname, "../../src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js"),
    "utf8",
  );
  const pageSource = readFileSync(
    resolve(__dirname, "../../src/app/(dashboard)/dashboard/providers/[id]/page.js"),
    "utf8",
  );
  const limitsSource = readFileSync(
    resolve(__dirname, "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js"),
    "utf8",
  );

  it("is the connection card the provider page renders", () => {
    expect(pageSource).toContain('import ConnectionRow from "./ConnectionRow"');
    expect(pageSource).toContain("<ConnectionRow");
  });

  it("gates the button to meoo, non-external connections — the ProviderLimits condition", () => {
    expect(rowSource).toContain('connection.provider === "meoo" && !connection.external');
    expect(rowSource).toContain("{showMeooDailyClaim && (");
    expect(limitsSource).toContain('conn.provider === "meoo" && !conn.external');
  });

  it("posts to the same daily-claim endpoint as the quota card", () => {
    expect(rowSource).toContain("/api/usage/${connection.id}/meoo-daily-claim");
    expect(rowSource).toContain('method: "POST"');
  });

  it("renders the labeled button with the redeem icon, a claiming spinner, and repeat-click lockout", () => {
    expect(rowSource).toContain("每日领积分");
    expect(rowSource).toContain('"redeem"');
    expect(rowSource).toContain("progress_activity");
    expect(rowSource).toContain("disabled={meooClaiming}");
    expect(rowSource).toContain("if (meooClaiming) return;");
  });

  it("shows the verdict inline — green when claimed, balance appended", () => {
    expect(rowSource).toContain("meooClaimResult.claimed");
    expect(rowSource).toContain("text-green-600 dark:text-green-400");
    expect(rowSource).toContain("余额 ${meooClaimResult.balance} 积分");
  });

  it("leaves the quota-card button in place (both surfaces share the route)", () => {
    expect(limitsSource).toContain("handleMeooDailyClaim");
    expect(limitsSource).toContain("meoo-daily-claim");
  });
});
