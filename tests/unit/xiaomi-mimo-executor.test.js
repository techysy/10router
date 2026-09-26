import { describe, it, expect, vi, beforeEach } from "vitest";

// The account module reaches for MiMo Desktop's local cookie store and the network;
// pin it so the executor tests stay hermetic on a machine that has Desktop installed.
const { accountMock } = vi.hoisted(() => ({ accountMock: { cookie: null } }));
vi.mock("../../open-sse/shared/mimoAccount.js", () => ({
  getMimoAccountCookie: async () => accountMock.cookie,
  invalidateMimoAccountCookieCache: vi.fn(),
  MIMO_API_BASE: "https://mimo-server-cn.xiaomimimo.com",
  MIMO_API_UA: "test-ua",
  mimoApiBaseFor: (psd) =>
    psd?.region && psd.region !== "cn"
      ? `https://mimo-server-${psd.region}.xiaomimimo.com`
      : "https://mimo-server-cn.xiaomimimo.com",
}));

import { XiaomiMimoExecutor, __test__ } from "../../open-sse/executors/xiaomi-mimo.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import registry from "../../open-sse/providers/registry/xiaomi-mimo.js";
import desktop from "../../open-sse/providers/registry/mimo-desktop.js";
import { resolveProviderAlias } from "../../open-sse/services/model.js";

const { COOKIE_KEY, ACCOUNT_SESSION_PROVIDER } = __test__;

const OPENAI_T = { runtimeTransport: { format: "openai", baseUrl: "https://api.xiaomimimo.com/v1/chat/completions" } };
const CLAUDE_T = { runtimeTransport: { format: "claude", baseUrl: "https://api.xiaomimimo.com/anthropic/v1/messages" } };

describe("xiaomi-mimo executor", () => {
  let ex; // the cloud card (`xiaomi-mimo`)
  let desktop; // the account-session card (`mimo-desktop`)
  beforeEach(() => {
    ex = new XiaomiMimoExecutor();
    desktop = new XiaomiMimoExecutor("mimo-desktop");
    accountMock.cookie = null;
  });

  it("is registered for xiaomi-mimo", () => {
    expect(getExecutor("xiaomi-mimo")).toBeInstanceOf(XiaomiMimoExecutor);
  });

  it("keys the session path on the provider id, not the model id", () => {
    // Both cards list the same ids, so the model id carries no signal at all.
    expect(ACCOUNT_SESSION_PROVIDER).toBe("mimo-desktop");
    expect(ex.usesAccountSession()).toBe(false);
    expect(desktop.usesAccountSession()).toBe(true);
  });

  it("routes the account-session card to the account-service route regardless of transport", () => {
    const expected = "https://mimo-server-cn.xiaomimimo.com/api/route/chat/completions";
    expect(desktop.buildUrl("mimo-v2.6-pro", true, 0, OPENAI_T)).toBe(expected);
    expect(desktop.buildUrl("mimo-v2.6-pro", true, 0, CLAUDE_T)).toBe(expected);
    expect(desktop.buildUrl("mimo-v2.6-flash", true, 0, OPENAI_T)).toBe(expected);
  });

  it("keeps the very same model id on the cloud route for the base card", () => {
    // The regression this guards: falling back to a model-id rule would send one
    // of these two calls to the wrong upstream — the Desktop one billing the API
    // while holding a cookie.
    expect(ex.buildUrl("mimo-v2.6-pro", true, 0, OPENAI_T)).toBe(OPENAI_T.runtimeTransport.baseUrl);
    expect(desktop.buildUrl("mimo-v2.6-pro", true, 0, OPENAI_T)).not.toBe(OPENAI_T.runtimeTransport.baseUrl);
  });

  it("keeps the sourceFormat-matched endpoint for cloud models", () => {
    // A Claude client must reach /anthropic/v1/messages, not /v1/chat/completions.
    expect(ex.buildUrl("mimo-v2.5-pro", true, 0, CLAUDE_T)).toBe(CLAUDE_T.runtimeTransport.baseUrl);
    expect(ex.buildUrl("mimo-v2.5-pro", true, 0, OPENAI_T)).toBe(OPENAI_T.runtimeTransport.baseUrl);
  });

  it("authenticates account-session calls with the account cookie", () => {
    const headers = desktop.buildHeaders({ [COOKIE_KEY]: "serviceToken=abc", accessToken: "sk-x" }, true, "u", "mimo-v2.6-pro");
    expect(headers.Cookie).toBe("serviceToken=abc");
    expect(headers.Authorization).toBeUndefined();
  });

  it("authenticates cloud calls with the bearer key even when a cookie is present", () => {
    // Same model id as the call above — only the provider differs.
    const headers = ex.buildHeaders({ [COOKIE_KEY]: "serviceToken=abc", accessToken: "sk-x" }, true, "u", "mimo-v2.6-pro");
    expect(headers.Authorization).toBe("Bearer sk-x");
    expect(headers.Cookie).toBeUndefined();
  });

  it("fails fast when an account-session call has no desktop session", async () => {
    await expect(
      desktop.execute({ model: "mimo-v2.6-pro", body: {}, stream: true, credentials: {}, log: null }),
    ).rejects.toThrow(/requires the Xiaomi MiMo desktop account/);
  });

  it("flattens content-part arrays to plain strings on the account-session card", () => {
    const out = desktop.transformRequest(
      "mimo-v2.6-pro",
      { messages: [{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }] },
      true,
      {},
    );
    expect(out.messages[0].content).toBe("ab");
  });

  it("applies account-session defaults without overriding explicit values", () => {
    const body = { messages: [{ role: "user", content: "hi" }], temperature: 0.2 };
    const out = desktop.transformRequest("mimo-v2.6-pro", body, true, {});
    expect(out.temperature).toBe(0.2); // caller's value kept
    expect(out.top_p).toBe(0.95); // default filled in
    expect(out.max_tokens).toBe(4096);
  });

  it("leaves cloud bodies free of account-session defaults", () => {
    const out = ex.transformRequest("mimo-v2.6-pro", { messages: [{ role: "user", content: "hi" }] }, true, {});
    expect(out.thinking).toBeUndefined();
    expect(out.max_tokens).toBeUndefined();
  });

  it("keeps multi-part content for the cloud card's multi-modal models", () => {
    // The flatten rule is scoped to the mimo-desktop PROVIDER, so the very same
    // id keeps its parts when it arrives on the cloud card (V2.6 is multi-modal).
    const content = [{ type: "text", text: "a" }, { type: "image_url", image_url: { url: "x" } }];
    const out = ex.transformRequest("mimo-v2.6-pro", { messages: [{ role: "user", content }] }, true, {});
    expect(Array.isArray(out.messages[0].content)).toBe(true);
  });

  it("bridges high effort to deep thinking directive and expanded max_tokens", () => {
    const body = {
      messages: [{ role: "system", content: "You are an agent." }, { role: "user", content: "solve" }],
      reasoning_effort: "high",
    };
    const out = desktop.transformRequest("mimo-v2.6-pro", body, true, {});
    expect(out.max_tokens).toBe(32768);
    expect(out.messages[0].content).toContain("[Thinking Directive]");
    expect(out.messages[0].content).toContain("Please UltraThinking:");
  });

  it("bridges xhigh effort to extended thinking directive and 64k tokens", () => {
    const body = {
      messages: [{ role: "user", content: "complex task" }],
      reasoning_effort: "xhigh",
    };
    const out = desktop.transformRequest("mimo-v2.6-pro", body, true, {});
    expect(out.max_tokens).toBe(65536);
    expect(out.messages[0].content).toContain("Please UltraThinking (Extended)");
  });

  it("bridges low effort without extra prompt and allocates moderate budget", () => {
    const body = {
      messages: [{ role: "user", content: "quick answer" }],
      reasoning_effort: "low",
    };
    const out = desktop.transformRequest("mimo-v2.6-flash", body, true, {});
    expect(out.max_tokens).toBe(8192);
    expect(out.messages.some((m) => typeof m.content === "string" && m.content.includes("Please UltraThinking"))).toBe(false);
  });

  it("bridges medium effort with expanded budget but no prompt injection", () => {
    const body = {
      messages: [{ role: "user", content: "explain" }],
      reasoning_effort: "medium",
    };
    const out = desktop.transformRequest("mimo-v2.6-pro", body, true, {});
    expect(out.max_tokens).toBe(16384);
    expect(out.messages.length).toBe(1);
    expect(out.messages[0].role).toBe("user");
  });

  it("bridges none effort without prompt injection", () => {
    const body = {
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "none",
    };
    const out = desktop.transformRequest("mimo-v2.6-pro", body, true, {});
    expect(out.max_tokens).toBe(4096);
    expect(out.messages.length).toBe(1);
    expect(out.messages[0].role).toBe("user");
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
    // `mimo-desktop` and `xmd` moved to the Desktop card in the 2026-09-22 split
    // (see the "mimo-desktop registry" block below). They must NOT still answer
    // for this provider, or the two cards would share one alias and
    // ALIAS_TO_PROVIDER_ID order would decide the winner.
    expect(registry.aliases).not.toContain("mimo-desktop");
    expect(registry.aliases).not.toContain("xmd");
  });

  it("leaves the Desktop-exclusive previews to the Desktop card", () => {
    expect(registry.models.filter((m) => /preview/.test(m.id))).toEqual([]);
  });

  it("enables usage for both auth modes", () => {
    expect(registry.features).toMatchObject({ usage: true, usageApikey: true });
  });

  it("keeps the API signup on the cloud console, not the Desktop invite", () => {
    expect(registry.display.notice.apiKeyUrl).toContain("api-keys");
    // This used to point at the MiMo Desktop invite page, so anyone signing up to
    // use the API landed in the desktop app instead of the console that issues the
    // billing key this card actually needs.
    expect(registry.display.notice.signupUrl).toContain("platform.xiaomimimo.com");
    expect(registry.display.notice.signupUrl).not.toContain("/desktop/");
  });
});

describe("mimo-desktop registry (account session)", () => {
  it("keeps the same connect surface as the base card", () => {
    expect(desktop.category).toBe("oauth");
    expect(desktop.hasOAuth).toBe(true);
    expect(desktop.oauth.custom).toBe(true);
    expect(desktop.oauth.callbackParam).toBe("u");
  });

  it("offers no API-key path — the Desktop credential is the account session", () => {
    // `oauth` only, deliberately unlike the base card. An sk- key entered here would
    // never be used: the executor refuses anything arriving without the Desktop
    // cookie (MIMO_DESKTOP_SESSION_REQUIRED). Leaving "apikey" in authModes rendered
    // an "API Key" button whose connections were dead on arrival.
    expect(desktop.authModes).toEqual(["oauth"]);
    expect(desktop.authModes).not.toContain("apikey");
  });

  it("resolves every declared alias to the Desktop card, not the base card", () => {
    for (const alias of [desktop.alias, ...desktop.aliases]) {
      expect(resolveProviderAlias(alias)).toBe("mimo-desktop");
    }
    expect(resolveProviderAlias("mimo")).toBe("xiaomi-mimo");
  });

  it("lists the Desktop plan's models with the credit multipliers it publishes", () => {
    // The Desktop app's own picker prints these rates (积分倍率): usage there is
    // metered in credits, so the badge has to come from the registry.
    const byId = Object.fromEntries(desktop.models.map((m) => [m.id, m]));
    expect(Object.keys(byId).sort()).toEqual([
      "mimo-v2.6-flash",
      "mimo-v2.6-pro",
    ]);
    expect(byId["mimo-v2.6-pro"].rateMultiplier).toBe(1);
    expect(byId["mimo-v2.6-flash"].rateMultiplier).toBe(0.4);
    for (const m of desktop.models) {
      // The account-service route accepts only OpenAI format, and only the cookie.
      expect(m.supportedFormats).toEqual(["openai"]);
      expect(m.requiresSession).toBe(true);
    }
  });

  it("wires the same executor as the base card, distinguished by provider id", () => {
    const desktopEx = getExecutor("mimo-desktop");
    expect(desktopEx).toBeInstanceOf(XiaomiMimoExecutor);
    // Same class, different card — this is exactly what lets both cards sell
    // `mimo-v2.6-pro` while reaching different upstreams.
    expect(desktopEx.usesAccountSession()).toBe(true);
    expect(getExecutor("xiaomi-mimo").usesAccountSession()).toBe(false);
  });
});

describe("mimo-desktop region clusters (对照上游 910db749)", () => {
  const desktopEx = new XiaomiMimoExecutor("mimo-desktop");
  it("routes the account-service call to the connection's region cluster", () => {
    const sgp = { ...OPENAI_T, providerSpecificData: { region: "sgp" } };
    expect(desktopEx.buildUrl("mimo-v2.6-pro", true, 0, sgp)).toBe(
      "https://mimo-server-sgp.xiaomimimo.com/api/route/chat/completions"
    );
  });

  it("defaults to the CN cluster when no region is set (legacy connections)", () => {
    expect(desktopEx.buildUrl("mimo-v2.6-pro", true, 0, OPENAI_T)).toBe(
      "https://mimo-server-cn.xiaomimimo.com/api/route/chat/completions"
    );
  });
});
