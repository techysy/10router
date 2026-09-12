import { describe, it, expect, vi, beforeEach } from "vitest";

// The account module reaches for MiMo Desktop's local cookie store and the network;
// pin it so the executor tests stay hermetic on a machine that has Desktop installed.
const { accountMock } = vi.hoisted(() => ({ accountMock: { cookie: null } }));
vi.mock("../../open-sse/shared/mimoAccount.js", () => ({
  getMimoAccountCookie: async () => accountMock.cookie,
  invalidateMimoAccountCookieCache: vi.fn(),
  MIMO_API_BASE: "https://mimo-server-cn.xiaomimimo.com",
  MIMO_API_UA: "test-ua",
}));

import { XiaomiMimoExecutor, __test__ } from "../../open-sse/executors/xiaomi-mimo.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import registry from "../../open-sse/providers/registry/xiaomi-mimo.js";
import { resolveProviderAlias } from "../../open-sse/services/model.js";

const { bareModel, COOKIE_KEY } = __test__;

const OPENAI_T = { runtimeTransport: { format: "openai", baseUrl: "https://api.xiaomimimo.com/v1/chat/completions" } };
const CLAUDE_T = { runtimeTransport: { format: "claude", baseUrl: "https://api.xiaomimimo.com/anthropic/v1/messages" } };

describe("xiaomi-mimo executor", () => {
  let ex;
  beforeEach(() => {
    ex = new XiaomiMimoExecutor();
    accountMock.cookie = null;
  });

  it("is registered for xiaomi-mimo", () => {
    expect(getExecutor("xiaomi-mimo")).toBeInstanceOf(XiaomiMimoExecutor);
  });

  it("routes Preview models to the account-service route regardless of transport", () => {
    const expected = "https://mimo-server-cn.xiaomimimo.com/api/route/chat/completions";
    expect(ex.buildUrl("mimo-x-pro-preview", true, 0, OPENAI_T)).toBe(expected);
    expect(ex.buildUrl("mimo-x-pro-preview", true, 0, CLAUDE_T)).toBe(expected);
    // body.model arrives as `xiaomi/<id>` via upstreamModelId
    expect(ex.buildUrl("xiaomi/mimo-x-flash-preview", true, 0, OPENAI_T)).toBe(expected);
  });

  it("keeps the sourceFormat-matched endpoint for cloud models", () => {
    // A Claude client must reach /anthropic/v1/messages, not /v1/chat/completions.
    expect(ex.buildUrl("mimo-v2.5-pro", true, 0, CLAUDE_T)).toBe(CLAUDE_T.runtimeTransport.baseUrl);
    expect(ex.buildUrl("mimo-v2.5-pro", true, 0, OPENAI_T)).toBe(OPENAI_T.runtimeTransport.baseUrl);
  });

  it("authenticates Preview calls with the account cookie", () => {
    const headers = ex.buildHeaders({ [COOKIE_KEY]: "serviceToken=abc", accessToken: "sk-x" }, true, "u", "mimo-x-pro-preview");
    expect(headers.Cookie).toBe("serviceToken=abc");
    expect(headers.Authorization).toBeUndefined();
  });

  it("authenticates cloud calls with the bearer key", () => {
    const headers = ex.buildHeaders({ accessToken: "sk-x" }, true, "u", "mimo-v2.5-pro");
    expect(headers.Authorization).toBe("Bearer sk-x");
    expect(headers.Cookie).toBeUndefined();
  });

  it("fails fast when a Preview call has no account session", async () => {
    await expect(
      ex.execute({ model: "mimo-x-pro-preview", body: {}, stream: true, credentials: {}, log: null }),
    ).rejects.toThrow(/requires the Xiaomi MiMo desktop account/);
  });

  it("flattens content-part arrays to plain strings", () => {
    const out = ex.transformRequest(
      "mimo-x-pro-preview",
      { messages: [{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }] },
      true,
      {},
    );
    expect(out.messages[0].content).toBe("ab");
  });

  it("applies Preview defaults without overriding explicit values", () => {
    const body = { messages: [{ role: "user", content: "hi" }], temperature: 0.2 };
    const out = ex.transformRequest("mimo-x-pro-preview", body, true, {});
    expect(out.temperature).toBe(0.2); // caller's value kept
    expect(out.top_p).toBe(0.95); // default filled in
    expect(out.max_tokens).toBe(4096);
  });

  it("leaves cloud bodies free of Preview defaults", () => {
    const out = ex.transformRequest("mimo-v2.5-pro", { messages: [{ role: "user", content: "hi" }] }, true, {});
    expect(out.thinking).toBeUndefined();
    expect(out.max_tokens).toBeUndefined();
  });

  it("keeps multi-part content for cloud multi-modal models", () => {
    // The flatten rule is scoped to Preview ids — mimo-v2-omni is multi-modal.
    const content = [{ type: "text", text: "a" }, { type: "image_url", image_url: { url: "x" } }];
    const out = ex.transformRequest("mimo-v2-omni", { messages: [{ role: "user", content }] }, true, {});
    expect(Array.isArray(out.messages[0].content)).toBe(true);
  });

  it("strips a provider/model prefix when testing preview ids", () => {
    expect(bareModel("xiaomi/mimo-x-pro-preview")).toBe("mimo-x-pro-preview");
    expect(bareModel("mimo-x-pro-preview")).toBe("mimo-x-pro-preview");
  });
});

describe("xiaomi-mimo registry (dual auth)", () => {
  it("declares both auth modes and the custom ECDH callback", () => {
    expect(registry.category).toBe("oauth");
    expect(registry.authModes).toEqual(["oauth", "apikey"]);
    expect(registry.hasOAuth).toBe(true);
    expect(registry.oauth.custom).toBe(true);
    expect(registry.oauth.callbackParam).toBe("u");
    expect(registry.oauth.kn).toBe("mimocode");
  });

  it("resolves every declared alias to the provider", () => {
    for (const alias of [registry.alias, ...registry.aliases]) {
      expect(resolveProviderAlias(alias)).toBe("xiaomi-mimo");
    }
    expect(registry.aliases).toContain("mimo-desktop");
    expect(registry.aliases).toContain("xmd");
  });

  it("pins the Desktop-exclusive models to the openai transport", () => {
    const preview = registry.models.filter((m) => /preview/.test(m.id));
    expect(preview.map((m) => m.id).sort()).toEqual(["mimo-x-flash-preview", "mimo-x-pro-preview"]);
    for (const m of preview) {
      expect(m.supportedFormats).toEqual(["openai"]);
      expect(m.upstreamModelId).toBe(`xiaomi/${m.id}`);
    }
  });

  it("enables usage for both auth modes", () => {
    expect(registry.features).toMatchObject({ usage: true, usageApikey: true });
  });

  it("keeps the api-key signup links", () => {
    expect(registry.display.notice.apiKeyUrl).toContain("api-keys");
    expect(registry.display.notice.signupUrl).toContain("desktop");
  });
});
