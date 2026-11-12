// Meoo （秒悟） provider: registry wiring, CLI client-id resolution, and the
// OAuth provider's auth-url / token-mapping contract. No network — the
// live cli-compat behaviour is covered by the CLI-source parity comments
// in open-sse/services/meooAk.js.
import { describe, expect, it } from "vitest";
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
