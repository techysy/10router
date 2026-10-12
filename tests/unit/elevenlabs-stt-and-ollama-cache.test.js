import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleSttCore } from "../../open-sse/handlers/sttCore.js";
import { toOpenAIUsage } from "../../open-sse/translator/concerns/usage.js";

describe("ElevenLabs Scribe STT Handler", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("dispatches to ElevenLabs transcribe with correct auth headers and form fields", async () => {
    const mockFile = new Blob(["fake-audio"], { type: "audio/wav" });
    const formData = new FormData();
    formData.append("file", mockFile, "audio.wav");
    formData.append("model", "scribe_v1");
    formData.append("language", "zh");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ text: "你好世界", language_code: "zh" }),
    });

    const res = await handleSttCore({
      provider: "elevenlabs",
      model: "scribe_v1",
      formData,
      credentials: { apiKey: "xi-test-key-123" },
      sttConfig: {
        baseUrl: "https://api.elevenlabs.io/v1/speech-to-text",
        authType: "apikey",
        authHeader: "xi-api-key",
        format: "elevenlabs",
      },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(opts.headers["xi-api-key"]).toBe("xi-test-key-123");
    expect(res.success).toBe(true);

    const body = await res.response.json();
    expect(body.text).toBe("你好世界");
  });
});

describe("Ollama Usage with Cached Tokens", () => {
  it("extracts cached_tokens from prompt_tokens_details", () => {
    const rawOllama = {
      prompt_eval_count: 500,
      eval_count: 120,
      prompt_tokens_details: {
        cached_tokens: 350,
      },
    };

    const usage = toOpenAIUsage(rawOllama, "ollama");
    expect(usage).toBeDefined();
    expect(usage.prompt_tokens).toBe(500);
    expect(usage.completion_tokens).toBe(120);
    expect(usage.total_tokens).toBe(620);
    expect(usage.prompt_tokens_details).toBeDefined();
    expect(usage.prompt_tokens_details.cached_tokens).toBe(350);
  });
});
