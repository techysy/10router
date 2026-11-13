// Guards the refactored USAGE_HANDLERS dispatch: unsupported → message, supported → routed.
import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub network so handlers don't hit real APIs; each call resolves an empty 200.
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => "{}",
  })),
}));

const load = () => import("../../open-sse/services/usage.js");
const SUPPORTED = [
  "github", "gemini-cli", "antigravity", "claude", "codex", "kiro",
  "qoder", "iflow", "ollama", "glm", "glm-cn",
  "minimax", "minimax-cn", "vercel-ai-gateway", "grok-cli", "kimi",
  "deepseek",
  // The three Xiaomi/MiMo cards. The Desktop card was missed when the three-card
  // split added its id, so it showed no quota while the cloud card showed one.
  "xiaomi-mimo", "mimo-desktop", "xiaomi-tokenplan",
  // Web-cookie provider: quota read from the Baidu console session on the
  // connection's cookies (services/usage/dumate.js).
  "dumate",
];

describe("usage dispatch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("unsupported provider → not-implemented message", async () => {
    const { getUsageForProvider } = await load();
    const res = await getUsageForProvider({ provider: "totally-unknown" });
    expect(res).toEqual({ message: "Usage API not implemented for totally-unknown" });
  });

  it("every supported provider routes to its handler (no fallback message)", async () => {
    const { getUsageForProvider } = await load();
    for (const provider of SUPPORTED) {
      const res = await getUsageForProvider({ provider, accessToken: "t", apiKey: "k" });
      // Routed handler must return an object and never the unsupported fallback
      expect(res, `${provider} routed`).toBeTypeOf("object");
      expect(res?.message).not.toBe(`Usage API not implemented for ${provider}`);
    }
  });
});

describe("MiMo Desktop usage", () => {
  const PLACEHOLDER = "mimo-desktop-session-6786673";

  it("routes the Desktop card to the MiMo account-session handler", async () => {
    // Regression guard: with no entry in USAGE_HANDLERS the card fell through to
    // "Usage API not implemented for mimo-desktop" and rendered no quota at all.
    const { getUsageForProvider } = await load();
    const res = await getUsageForProvider({ provider: "mimo-desktop", accessToken: PLACEHOLDER });
    expect(res?.message).not.toBe("Usage API not implemented for mimo-desktop");
  });

  it("never sends the Desktop session placeholder as a Bearer token", async () => {
    // The Desktop card stores `mimo-desktop-session[-<uid>]` where an API-key
    // connection stores an sk- key. Posting that placeholder as a Bearer token is a
    // request nobody can authorize, and it answers 401 — which used to surface as
    // "the API key alone is insufficient", pointing at a key path this card does not
    // have. It must be recognised and reported as "not signed in" instead.
    const { getUsageForProvider } = await load();
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    proxyAwareFetch.mockClear();

    const res = await getUsageForProvider({
      provider: "mimo-desktop",
      accessToken: PLACEHOLDER,
      providerSpecificData: {},
    });

    expect(res.message).toContain("not signed in");
    expect(res.plan).toBe("Xiaomi MiMo Desktop");
    for (const call of proxyAwareFetch.mock.calls) {
      expect(JSON.stringify(call), "placeholder must not reach the network").not.toContain(
        "mimo-desktop-session",
      );
    }
  });

  it("still falls back to a real sk- key when the account session is unavailable", async () => {
    const { getUsageForProvider } = await load();
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    proxyAwareFetch.mockClear();

    await getUsageForProvider({ provider: "mimo-desktop", accessToken: "sk-real-key", providerSpecificData: {} });

    const sentBearer = proxyAwareFetch.mock.calls.some((c) =>
      JSON.stringify(c).includes("Bearer sk-real-key"),
    );
    expect(sentBearer).toBe(true);
  });
});
