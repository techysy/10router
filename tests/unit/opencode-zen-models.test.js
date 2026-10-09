import { describe, expect, it } from "vitest";
import { PROVIDER_MODELS, getModelSupportedFormats } from "../../open-sse/config/providerModels.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { resolveTransport } from "../../open-sse/services/provider.js";

// Chat-only models (no /messages, no /responses support on opencode-zen)
const CHAT_ONLY = ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp", "deepseek-v4.1-flash",
  "glm-5.3-flash", "glm-5.3", "glm-5.2", "glm-5.1", "glm-5",
  "minimax-m3", "minimax-m2.7", "minimax-m2.5",
  "kimi-k3", "kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5",
  "big-pickle", "deepseek-v4-flash-free",
  "mimo-v2.6-flash-free", "mimo-v2.5-free", "ling-3.0-flash-fin-free",
  "ling-3.1-flash-free", "fledge-alpha-free", "exo-free", "mistral-large-4",
  "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite",
  "gemini-3.5-flash", "gemini-3.1-pro", "gemini-3-flash",
  "nemotron-3-ultra-free", "nemotron-3.5-lightning-free"];
// Models that also expose the Anthropic /messages endpoint
const CLAUDE_CAPABLE = ["claude-fable-5", "claude-fable-5-1", "claude-opus-5-5", "claude-opus-5",
  "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5",
  "claude-sonnet-5-5", "claude-sonnet-5", "claude-sonnet-4-6", "claude-sonnet-4-5", "claude-sonnet-4",
  "claude-haiku-5-5", "claude-haiku-4-5", "qwen3.8-max", "qwen3.8-flash", "qwen3.7-max", "qwen3.7-plus",
  "qwen3.6-plus", "qwen3.5-plus", "union-alpha"];
// Models that also expose the OpenAI /responses endpoint
const RESPONSES_CAPABLE = ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol",
  "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
  "gpt-5.5", "gpt-5.5-pro",
  "gpt-5.4", "gpt-5.4-pro", "gpt-5.4-mini", "gpt-5.4-nano",
  "gpt-5.3-codex-spark", "gpt-5.3-codex",
  "gpt-5.2", "gpt-5.2-codex",
  "gpt-5.1", "gpt-5.1-codex-max", "gpt-5.1-codex", "gpt-5.1-codex-mini",
  "gpt-5", "gpt-5-codex", "gpt-5-nano",
  "grok-build-0.1", "grok-4.7", "grok-4.6", "grok-4.5",
  "muse-spark-1.3", "muse-spark-1.2",
  "muse-spark-1.3-contributor-free", "muse-spark-1.2-contributor-free"];

// Mirror of chatCore's per-model transport guard: use the sourceFormat-matched
// transport only when the model declares support for that sourceFormat.
function pickTransport(provider, sourceFormat, alias, model) {
  const supported = getModelSupportedFormats(alias, model);
  const rt = resolveTransport(provider, sourceFormat);
  return supported?.includes(sourceFormat) ? rt : null;
}

describe("OpenCode Zen model catalog", () => {
  it("matches the live PAYG catalog ids exactly", () => {
    // Was six `toContain` + `length > 60`, which pinned 71 of 87 rows: a new id
    // could land with a wrong (or missing) endpoint declaration and nothing
    // went red. Match the whole set instead, the way opencode-go's test does —
    // the id *set* is the invariant that must track the live catalogue.
    const ids = (PROVIDER_MODELS["ocz"] || []).map((m) => m.id);
    expect([...ids].sort()).toEqual(
      [...CHAT_ONLY, ...CLAUDE_CAPABLE, ...RESPONSES_CAPABLE].sort()
    );
  });

  it("has no duplicate ids", () => {
    const ids = (PROVIDER_MODELS["ocz"] || []).map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("declares an endpoint for every model", () => {
    // Unlike opencode-go there is no deliberately-undeclared id here: all 87
    // rows carry supportedFormats, so any gap is a real omission.
    const missing = (PROVIDER_MODELS["ocz"] || [])
      .filter((m) => !Array.isArray(m.supportedFormats))
      .map((m) => m.id);
    expect(missing).toEqual([]);
  });
});

describe("OpenCode Zen per-model supportedFormats", () => {
  it("declares [claude] for Claude + Qwen + union-alpha models", () => {
    for (const m of CLAUDE_CAPABLE) {
      expect(getModelSupportedFormats("ocz", m)).toEqual(["claude"]);
    }
  });

  it("declares [openai-responses] for GPT/Grok/Spark responses models", () => {
    for (const m of RESPONSES_CAPABLE) {
      expect(getModelSupportedFormats("ocz", m)).toEqual(["openai-responses"]);
    }
  });

  it("declares [openai] only for chat-only models (GLM/Kimi/MiMo) → guards /messages routing", () => {
    for (const m of CHAT_ONLY) {
      expect(getModelSupportedFormats("ocz", m)).toEqual(["openai"]);
    }
  });
});

describe("OpenCode Zen multi-endpoint transports", () => {
  it("declares openai / claude / openai-responses transports", () => {
    const formats = (PROVIDERS["opencode-zen"].transports || []).map((t) => t.format);
    expect(formats).toEqual(["openai", "claude", "openai-responses"]);
  });

  it("resolveTransport picks the endpoint matching the client sourceFormat", () => {
    expect(resolveTransport("opencode-zen", "claude").baseUrl).toBe("https://opencode.ai/zen/v1/messages");
    expect(resolveTransport("opencode-zen", "openai-responses").baseUrl).toBe("https://opencode.ai/zen/v1/responses");
    expect(resolveTransport("opencode-zen", "openai").baseUrl).toBe("https://opencode.ai/zen/v1/chat/completions");
  });

  it("uses x-api-key + anthropicVersion on the claude transport", () => {
    const t = resolveTransport("opencode-zen", "claude");
    expect(t.auth.header).toBe("x-api-key");
    expect(t.auth.anthropicVersion).toBe(true);
  });

  it("carries the usage URL for the quota card", () => {
    expect(PROVIDERS["opencode-zen"].usage?.url).toBe("https://opencode.ai/zen/v1/usage");
  });
});

describe("OpenCode Zen per-model transport guard (chatCore logic)", () => {
  it("routes MiniMax/Qwen + claude-format client to /messages", () => {
    for (const m of CLAUDE_CAPABLE) {
      expect(pickTransport("opencode-zen", "claude", "ocz", m)?.baseUrl).toBe("https://opencode.ai/zen/v1/messages");
    }
  });

  it("does NOT route chat-only models to /messages on a claude-format request", () => {
    for (const m of CHAT_ONLY) {
      expect(pickTransport("opencode-zen", "claude", "ocz", m)).toBeNull();
    }
  });

  it("routes DeepSeek + responses-format client to /responses", () => {
    for (const m of RESPONSES_CAPABLE) {
      expect(pickTransport("opencode-zen", "openai-responses", "ocz", m)?.baseUrl).toBe("https://opencode.ai/zen/v1/responses");
    }
  });

  it("routes Muse Spark (responses-only) to /responses, never to /messages", () => {
    for (const m of ["muse-spark-1.2", "muse-spark-1.3", "muse-spark-1.2-contributor-free", "muse-spark-1.3-contributor-free", "grok-4.6", "gpt-5.6-luna"]) {
      expect(getModelSupportedFormats("ocz", m)).toEqual(["openai-responses"]);
      expect(pickTransport("opencode-zen", "openai-responses", "ocz", m)?.baseUrl).toBe("https://opencode.ai/zen/v1/responses");
      expect(pickTransport("opencode-zen", "claude", "ocz", m)).toBeNull();
      expect(pickTransport("opencode-zen", "openai", "ocz", m)).toBeNull();
    }
  });

  it("does NOT route Claude models (no responses support) to /responses", () => {
    for (const m of CLAUDE_CAPABLE) {
      expect(pickTransport("opencode-zen", "openai-responses", "ocz", m)).toBeNull();
    }
  });
});
