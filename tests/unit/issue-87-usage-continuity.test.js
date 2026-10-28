import { describe, it, expect, vi, afterEach } from "vitest";
import { canonicalizeUsage } from "../../open-sse/utils/usageTracking.js";
import { toOpenAIUsage } from "../../open-sse/translator/concerns/usage.js";
import { translateSessionId as opencodeTranslateSessionId } from "../../open-sse/executors/opencode.js";
import { translateSessionId as zenTranslateSessionId } from "../../open-sse/executors/opencode-zen.js";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";

describe("Issue #87 - Bug 1: Claude-to-OpenAI stream usage cache folding", () => {
  it("sets cached_tokens so canonicalizeUsage does not double-count cached tokens", async () => {
    const { claudeToOpenAIResponse } = await import(
      "../../open-sse/translator/response/claude-to-openai.js"
    );

    const state = {
      model: "claude-3-5-sonnet",
      toolCalls: new Map(),
      toolCallIndex: 0,
    };

    // 1. message_start event with cache usage
    claudeToOpenAIResponse(
      {
        type: "message_start",
        message: {
          id: "msg_123",
          model: "claude-3-5-sonnet",
          usage: {
            input_tokens: 42,
            cache_read_input_tokens: 1664,
            cache_creation_input_tokens: 10,
          },
        },
      },
      state
    );

    expect(state.usage.prompt_tokens).toBe(42 + 1664 + 10);
    expect(state.usage.cached_tokens).toBe(1664);

    // canonicalizeUsage should recognize cached_tokens and NOT add cached tokens again
    const canonicalStart = canonicalizeUsage(state.usage);
    expect(canonicalStart.prompt_tokens).toBe(1716); // 42 + 1664 + 10, NOT 1716 + 1664 = 3380!
    expect(canonicalStart.cached_tokens).toBe(1664);

    // 2. message_delta event with output tokens
    claudeToOpenAIResponse(
      {
        type: "message_delta",
        usage: {
          output_tokens: 88,
        },
        delta: {
          stop_reason: "end_turn",
        },
      },
      state
    );

    expect(state.usage.prompt_tokens).toBe(1716);
    expect(state.usage.completion_tokens).toBe(88);
    expect(state.usage.cached_tokens).toBe(1664);

    const canonicalEnd = canonicalizeUsage(state.usage);
    expect(canonicalEnd.prompt_tokens).toBe(1716);
    expect(canonicalEnd.completion_tokens).toBe(88);
    expect(canonicalEnd.total_tokens).toBe(1716 + 88);
    expect(canonicalEnd.cached_tokens).toBe(1664);
  });
});

describe("Issue #87 - Bug 2: Non-streaming Claude response preserves cache tokens", () => {
  it("toOpenAIUsage folds cache tokens and populates prompt_tokens_details", () => {
    const rawClaudeUsage = {
      input_tokens: 42,
      output_tokens: 88,
      cache_read_input_tokens: 1664,
      cache_creation_input_tokens: 10,
    };

    const usage = toOpenAIUsage(rawClaudeUsage, "claude");
    expect(usage.prompt_tokens).toBe(42 + 1664 + 10);
    expect(usage.completion_tokens).toBe(88);
    expect(usage.total_tokens).toBe(1716 + 88);
    expect(usage.prompt_tokens_details).toBeDefined();
    expect(usage.prompt_tokens_details.cached_tokens).toBe(1664);
    expect(usage.prompt_tokens_details.cache_creation_tokens).toBe(10);
  });
});

describe("Issue #87 - Bug 3: Private and loopback IPs bypass env proxy", () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
    vi.restoreAllMocks();
  });

  it("does not route private IPs to HTTP_PROXY/HTTPS_PROXY", async () => {
    const { getEnvProxyUrl, isPrivateOrLoopbackHost } = await import(
      "../../open-sse/utils/proxyFetch.js"
    );

    process.env.HTTPS_PROXY = "http://proxy.corp.internal:8888";
    process.env.HTTP_PROXY = "http://proxy.corp.internal:8888";

    // Private / loopback / CGNAT IPs
    const targets = [
      "http://127.0.0.1:47860/gateway",
      "http://localhost:47860/gateway",
      "http://sub.localhost:8080/v1",
      "http://192.168.1.100:20127/api/health",
      "http://10.0.0.5:8080/v1/models",
      "http://172.20.0.2:8000/test",
      "http://169.254.1.1:80/status",
      "http://100.64.0.1:47860/gateway",
      "http://100.127.255.254:47860/gateway",
      "http://0.0.0.0:8000/api",
      "http://[::1]:8080/api",
    ];

    for (const target of targets) {
      expect(getEnvProxyUrl(target)).toBeNull();
    }

    // Public IPs and domains should still resolve to env proxy
    expect(getEnvProxyUrl("https://api.openai.com/v1/chat")).toBe("http://proxy.corp.internal:8888");
    expect(getEnvProxyUrl("http://8.8.8.8:80/test")).toBe("http://proxy.corp.internal:8888");
    expect(getEnvProxyUrl("http://100.63.255.255:80/test")).toBe("http://proxy.corp.internal:8888");
    expect(getEnvProxyUrl("http://100.128.0.1:80/test")).toBe("http://proxy.corp.internal:8888");
  });

  it("does not misclassify public domains that merely start with fc/fd/fe80 as private", async () => {
    const { getEnvProxyUrl, isPrivateOrLoopbackHost } = await import(
      "../../open-sse/utils/proxyFetch.js"
    );

    process.env.HTTPS_PROXY = "http://proxy.corp.internal:8888";
    process.env.HTTP_PROXY = "http://proxy.corp.internal:8888";

    // The fc/fd/fe80 prefixes are IPv6 UNIQUE-LOCAL/LINK-LOCAL literals, not
    // hostname prefixes: fda.gov / fcm.googleapis.com / fdroid.org are public
    // and must go through the proxy like any other domain.
    for (const target of [
      "https://fda.gov/",
      "https://fcm.googleapis.com/",
      "https://fdroid.org/",
      "https://fe80.example.com/",
    ]) {
      expect(getEnvProxyUrl(target)).toBe("http://proxy.corp.internal:8888");
      expect(isPrivateOrLoopbackHost(new URL(target).hostname)).toBe(false);
    }

    // Real IPv6 literals keep their classification.
    expect(isPrivateOrLoopbackHost("fd00::1")).toBe(true);
    expect(isPrivateOrLoopbackHost("[fc00::abcd]")).toBe(true);
    expect(isPrivateOrLoopbackHost("fe80::1")).toBe(true);
    expect(getEnvProxyUrl("http://[fd00::1]:8080/api")).toBeNull();
    expect(getEnvProxyUrl("http://[2001:db8::1]:8080/api")).toBe("http://proxy.corp.internal:8888");
  });
});

describe("Issue #87 - Bug 4: translateSessionId is a deterministic pure function", () => {
  it("returns identical session IDs across time for both opencode and opencode-zen", () => {
    const rawSessions = [
      "session-conv-12345",
      "antigravity:conv-abc-123",
      "my-custom-cli-session-key",
      "random_user_turn_input",
    ];

    for (const raw of rawSessions) {
      // First call
      const id1 = opencodeTranslateSessionId(raw, "claude");
      const zenId1 = zenTranslateSessionId(raw, "claude");

      // Advance time by 5 seconds
      vi.setSystemTime(new Date(Date.now() + 5000));

      const id2 = opencodeTranslateSessionId(raw, "claude");
      const zenId2 = zenTranslateSessionId(raw, "claude");

      expect(id2).toBe(id1);
      expect(zenId2).toBe(zenId1);
      expect(id1).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
      expect(zenId1).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    }
    vi.useRealTimers();
  });
});
