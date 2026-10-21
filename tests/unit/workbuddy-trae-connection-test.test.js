// Connection validators for WorkBuddy (CN/intl) and Trae (standard channel).
//
// Both used to rely on "token exists" or had no entry at all. The new probes are
// credential-gated account reads:
//   • codebuddy-cn  GET  /v3/config                    (real model catalogue)
//   • codebuddy-intl GET /v3/config → POST billing      (intl publishes no catalogue)
//   • trae          POST /cloudide/api/v3/trae/GetUserInfo
// No inference request is sent, so a test never spends credits.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let db;
let testSingleConnection;
let fetchCalls = [];

beforeAll(async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-validator-test-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  ({ testSingleConnection } = await import("@/app/api/providers/[id]/test/testUtils.js"));
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchCalls = [];
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(handler) {
  const mock = vi.fn(async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });
    return handler(String(url));
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

async function createConnection(fields) {
  return db.createProviderConnection({
    name: fields.provider,
    authType: "oauth",
    ...fields,
  });
}

describe("WorkBuddy / CodeBuddy connection validator", () => {
  it("verifies the selected model against the CN /v3/config catalogue", async () => {
    stubFetch((url) =>
      url === "https://copilot.tencent.com/v3/config"
        ? jsonResponse({ code: 0, data: { models: [{ id: "glm-5.3" }, { id: "kimi-k3" }] } })
        : jsonResponse({})
    );
    const conn = await createConnection({
      provider: "codebuddy-cn",
      accessToken: "cb-token",
    });

    const result = await testSingleConnection(conn.id, { model: "glm-5.3" });
    expect(result.valid).toBe(true);
    expect(result.error).toBeNull();

    const probe = fetchCalls.find((call) => call.url.endsWith("/v3/config"));
    expect(probe).toBeTruthy();
    expect(probe.options.headers.Authorization).toBe("Bearer cb-token");
  });

  it("rejects a model the CN catalogue does not list", async () => {
    stubFetch((url) =>
      url === "https://copilot.tencent.com/v3/config"
        ? jsonResponse({ data: { models: [{ id: "glm-5.3" }] } })
        : jsonResponse({})
    );
    const conn = await createConnection({
      provider: "codebuddy-cn",
      accessToken: "cb-token",
    });

    const result = await testSingleConnection(conn.id, { model: "not-in-catalog" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("not available");
  });

  it("falls back to the billing probe for intl (no /v3/config)", async () => {
    stubFetch((url) => {
      if (url === "https://www.codebuddy.ai/v3/config") return jsonResponse({ error: "not found" }, 404);
      if (url === "https://www.codebuddy.ai/v2/billing/meter/get-user-resource") {
        return jsonResponse({ code: 0, data: { Response: { Data: { Accounts: [] } } } });
      }
      return jsonResponse({});
    });
    const conn = await createConnection({
      provider: "codebuddy-intl",
      accessToken: "intl-token",
    });

    const result = await testSingleConnection(conn.id, {});
    expect(result.valid).toBe(true);
    expect(result.error).toBeNull();
    expect(
      fetchCalls.some((call) => call.url.endsWith("/v2/billing/meter/get-user-resource"))
    ).toBe(true);
  });

  it("marks a revoked intl bearer invalid instead of 'test not supported'", async () => {
    stubFetch(() => jsonResponse({ error: "unauthorized" }, 401));
    const conn = await createConnection({
      provider: "codebuddy-intl",
      accessToken: "dead-token",
    });

    const result = await testSingleConnection(conn.id, {});
    expect(result.valid).toBe(false);
    expect(result.error).not.toBe("Provider test not supported");
    expect(result.error).toBe("Token invalid or revoked");

    const stored = await db.getProviderConnectionById(conn.id);
    expect(stored.testStatus).toBe("error");
  });

  it("routes apikey connections through the same validator", async () => {
    stubFetch((url) =>
      url === "https://www.codebuddy.ai/v3/config"
        ? jsonResponse({ data: { models: [{ id: "gpt-5.5" }] } })
        : jsonResponse({})
    );
    const conn = await db.createProviderConnection({
      provider: "codebuddy-intl",
      authType: "apikey",
      name: "codebuddy-intl-key",
      apiKey: "sk-intl",
    });

    const result = await testSingleConnection(conn.id, { model: "gpt-5.5" });
    expect(result.valid).toBe(true);
    const probe = fetchCalls.find((call) => call.url.endsWith("/v3/config"));
    expect(probe.options.headers.Authorization).toBe("Bearer sk-intl");
  });
});

describe("Trae connection validator", () => {
  it("uses GetUserInfo on the CN origin and validates a known model", async () => {
    stubFetch((url) =>
      url === "https://api.trae.com.cn/cloudide/api/v3/trae/GetUserInfo"
        ? jsonResponse({ Result: { UserID: "u-1", ScreenName: "tester" } })
        : jsonResponse({})
    );
    const conn = await createConnection({
      provider: "trae",
      accessToken: "trae-jwt",
      providerSpecificData: { site: "cn" },
    });

    const result = await testSingleConnection(conn.id, { model: "glm-5.2" });
    expect(result.valid).toBe(true);
    expect(result.error).toBeNull();

    const probe = fetchCalls.find((call) => call.url.includes("/GetUserInfo"));
    expect(probe).toBeTruthy();
    expect(probe.url.startsWith("https://api.trae.com.cn/")).toBe(true);
    expect(probe.options.headers["x-cloudide-token"]).toBe("trae-jwt");
  });

  it("passes an unknown model with a warning rather than calling the credential broken", async () => {
    stubFetch((url) =>
      url.endsWith("/GetUserInfo")
        ? jsonResponse({ Result: { UserID: "u-1" } })
        : jsonResponse({})
    );
    const conn = await createConnection({
      provider: "trae",
      accessToken: "trae-jwt",
      providerSpecificData: { site: "intl" },
    });

    const result = await testSingleConnection(conn.id, { model: "future-model" });
    expect(result.valid).toBe(true);

    const stored = await db.getProviderConnectionById(conn.id);
    expect(stored.lastError).toContain("could not be verified");
  });

  it("reports a revoked Trae token", async () => {
    stubFetch(() =>
      jsonResponse({ ResponseMetadata: { Error: { Code: "20101" } } }, 401)
    );
    const conn = await createConnection({
      provider: "trae",
      accessToken: "dead-jwt",
      providerSpecificData: { site: "intl" },
    });

    const result = await testSingleConnection(conn.id, {});
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Token invalid or revoked");
  });
});
