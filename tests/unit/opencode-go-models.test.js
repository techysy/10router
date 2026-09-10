// Endpoint declarations for opencode-go are load-bearing: chatCore only uses the
// sourceFormat-matched transport when the model declares that format, so a missing
// declaration sends e.g. a claude-format request for a chat-only model to /messages.
//
// Ids mirror the provider's public catalog — `GET https://opencode.ai/zen/go/v1/models`
// (no auth), which their docs call "the full list of available models". Endpoints follow
// the endpoint table in https://opencode.ai/docs/go/; ids that table does not cover
// inherit their family's endpoint. Snapshot taken 2026-09-10: 37 ids, none of ours stale.
import { describe, expect, it } from "vitest";
import { PROVIDER_MODELS, getModelSupportedFormats, getModelTargetFormat } from "../../open-sse/config/providerModels.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { resolveTransport } from "../../open-sse/services/provider.js";

// /v1/responses only: /chat/completions would 4xx, so every other client format is
// translated to the responses format instead.
const RESPONSES_ONLY = [
  "grok-4.6", "gpt-5.6-luna", "muse-spark-1.3-contributor", "muse-spark-1.2-contributor", "grok-4.5",
];
// /chat/completions only (no /messages, no /responses support on opencode-go).
const CHAT_ONLY = [
  "glm-5.3-flash", "glm-5.3", "glm-5.2", "glm-5.1", "glm-5",
  "kimi-k3", "kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5",
  "longcat-2.0",
  "mimo-v2.5", "mimo-v2.5-pro", "mimo-v2-pro", "mimo-v2-omni",
  "hy4-preview", "hy3", "hy3-preview",
];
// Also expose the Anthropic /messages endpoint.
const CLAUDE_CAPABLE = [
  "minimax-m3", "minimax-m2.7", "minimax-m2.5",
  "qwen3.8-max", "qwen3.8-flash", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus", "qwen3.5-plus",
];
// DeepSeek: the docs table only lists /chat/completions as the recommended endpoint, but
// all three are live on this channel (deepseek-v4-flash routes to V4.1 Flash upstream).
const DEEPSEEK = ["deepseek-v4.1-flash", "deepseek-flash", "deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"];
// Declared without supportedFormats on purpose (no family, no first-party spec) so it keeps
// the sourceFormat-matched transport instead of being funnelled to an unverified endpoint.
const UNDECLARED = ["omen-alpha"];

// Mirror of chatCore's per-model transport guard: use the sourceFormat-matched
// transport only when the model declares support for that sourceFormat.
function pickTransport(provider, sourceFormat, alias, model) {
  const supported = getModelSupportedFormats(alias, model);
  const rt = resolveTransport(provider, sourceFormat);
  return supported?.includes(sourceFormat) ? rt : null;
}

describe("OpenCode Go model catalog", () => {
  it("matches the provider's public catalog", () => {
    const ids = (PROVIDER_MODELS["opencode-go"] || []).map((m) => m.id);
    // Order is a presentation choice (grouped by endpoint, then family); the id *set* is the
    // invariant that must track the live catalog.
    expect([...ids].sort()).toEqual(
      [...RESPONSES_ONLY, ...CHAT_ONLY, ...DEEPSEEK, ...CLAUDE_CAPABLE, ...UNDECLARED].sort()
    );
  });

  it("has no duplicate ids", () => {
    const ids = (PROVIDER_MODELS["opencode-go"] || []).map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("declares an endpoint for every model except the explicitly undeclared one", () => {
    const missing = (PROVIDER_MODELS["opencode-go"] || [])
      .filter((m) => !Array.isArray(m.supportedFormats))
      .map((m) => m.id);
    expect(missing).toEqual(UNDECLARED);
  });
});

describe("OpenCode Go per-model supportedFormats", () => {
  it("keeps the responses-only models on /responses", () => {
    for (const m of RESPONSES_ONLY) {
      expect(getModelSupportedFormats("opencode-go", m), m).toEqual(["openai-responses"]);
      expect(getModelTargetFormat("opencode-go", m), m).toBe("openai-responses");
    }
  });

  it("declares [openai, claude] for MiniMax + Qwen models", () => {
    for (const m of CLAUDE_CAPABLE) {
      expect(getModelSupportedFormats("opencode-go", m), m).toEqual(["openai", "claude"]);
    }
  });

  it("declares [openai, claude, openai-responses] for DeepSeek models", () => {
    for (const m of DEEPSEEK) {
      expect(getModelSupportedFormats("opencode-go", m), m).toEqual(["openai", "claude", "openai-responses"]);
    }
  });

  it("declares [openai] only for chat-only models → guards /messages routing", () => {
    for (const m of CHAT_ONLY) {
      expect(getModelSupportedFormats("opencode-go", m), m).toEqual(["openai"]);
    }
  });
});

describe("OpenCode Go multi-endpoint transports", () => {
  it("declares openai / claude / openai-responses transports", () => {
    const formats = (PROVIDERS["opencode-go"].transports || []).map((t) => t.format);
    expect(formats).toEqual(["openai", "claude", "openai-responses"]);
  });

  it("resolveTransport picks the endpoint matching the client sourceFormat", () => {
    expect(resolveTransport("opencode-go", "claude").baseUrl).toBe("https://opencode.ai/zen/go/v1/messages");
    expect(resolveTransport("opencode-go", "openai-responses").baseUrl).toBe("https://opencode.ai/zen/go/v1/responses");
    expect(resolveTransport("opencode-go", "openai").baseUrl).toBe("https://opencode.ai/zen/go/v1/chat/completions");
  });

  it("uses x-api-key + anthropicVersion on the claude transport", () => {
    const t = resolveTransport("opencode-go", "claude");
    expect(t.auth.header).toBe("x-api-key");
    expect(t.auth.anthropicVersion).toBe(true);
  });
});

describe("OpenCode Go per-model transport guard (chatCore logic)", () => {
  it("routes MiniMax/Qwen + claude-format client to /messages", () => {
    for (const m of CLAUDE_CAPABLE) {
      expect(pickTransport("opencode-go", "claude", "opencode-go", m)?.baseUrl, m).toBe("https://opencode.ai/zen/go/v1/messages");
    }
  });

  it("does NOT route chat-only models to /messages on a claude-format request", () => {
    for (const m of CHAT_ONLY) {
      expect(pickTransport("opencode-go", "claude", "opencode-go", m), m).toBeNull();
    }
  });

  it("does NOT route responses-only models to /chat/completions or /messages", () => {
    // Translation to the responses format is what makes these reachable for other clients.
    for (const m of RESPONSES_ONLY) {
      expect(pickTransport("opencode-go", "openai", "opencode-go", m), m).toBeNull();
      expect(pickTransport("opencode-go", "claude", "opencode-go", m), m).toBeNull();
      expect(pickTransport("opencode-go", "openai-responses", "opencode-go", m)?.baseUrl, m).toBe(
        "https://opencode.ai/zen/go/v1/responses"
      );
    }
  });

  it("routes DeepSeek + responses-format client to /responses", () => {
    for (const m of DEEPSEEK) {
      expect(pickTransport("opencode-go", "openai-responses", "opencode-go", m)?.baseUrl, m).toBe("https://opencode.ai/zen/go/v1/responses");
    }
  });

  it("does NOT route MiniMax (no responses support) to /responses", () => {
    for (const m of CLAUDE_CAPABLE) {
      expect(pickTransport("opencode-go", "openai-responses", "opencode-go", m), m).toBeNull();
    }
  });
});
