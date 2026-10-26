import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildGrokCookieHeader } from "../../open-sse/utils/webCookieAuth.js";
import { getImageAdapter, isImageProvider } from "../../open-sse/handlers/imageProviders/index.js";
import { GrokWebExecutor } from "../../open-sse/executors/grok-web.js";

describe("Grok Web cookie normalization", () => {
  it("normalizes bare sso token", () => {
    expect(buildGrokCookieHeader("my-sso-token-123")).toBe("sso=my-sso-token-123");
    expect(buildGrokCookieHeader("sso=my-sso-token-123")).toBe("sso=my-sso-token-123");
  });

  it("preserves paired sso-rw and cf_clearance cookies", () => {
    const raw = "sso=tokenA; sso-rw=tokenB; cf_clearance=cf123; other=ignore";
    const header = buildGrokCookieHeader(raw);
    expect(header).toBe("sso=tokenA; sso-rw=tokenB; cf_clearance=cf123");
  });

  it("returns empty string when sso is absent", () => {
    expect(buildGrokCookieHeader("")).toBe("");
    expect(buildGrokCookieHeader("other=foo; bar=baz")).toBe("");
  });
});

describe("Grok Web image provider adapter registration", () => {
  it("is registered in imageProviders index", () => {
    expect(isImageProvider("grok-web")).toBe(true);
    const adapter = getImageAdapter("grok-web");
    expect(adapter).toBeDefined();
    expect(adapter.useExecutor).toBe(true);
    expect(typeof adapter.executeViaExecutor).toBe("function");
  });
});

describe("Grok Web generateMedia executor integration", () => {
  let fetchMock;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("successfully parses image_chunk SSE and downloads asset as base64", async () => {
    const executor = new GrokWebExecutor();

    // 1. First fetch: Grok chat completion stream returning completed image chunk
    const sseResponseText = [
      `data: {"statusCodeValue":200,"body":"{\\"choices\\\":[]}"}`,
      `data: ${JSON.stringify({
        result: {
          response: {
            cardAttachment: {
              jsonData: JSON.stringify({
                image_chunk: {
                  progress: 100,
                  imageUrl: "/generated/test-image.png",
                  mimeType: "image/png",
                },
              }),
            },
          },
        },
      })}`,
    ].join("\n\n");

    const chatResponse = new Response(sseResponseText, { status: 200 });

    // 2. Second fetch: image download from assets.grok.com
    const dummyImageBuffer = Buffer.from("fake-png-data");
    const downloadResponse = new Response(dummyImageBuffer, {
      status: 200,
      headers: { "content-type": "image/png" },
    });

    fetchMock
      .mockResolvedValueOnce(chatResponse)
      .mockResolvedValueOnce(downloadResponse);

    const media = await executor.generateMedia({
      prompt: "a beautiful cyberpunk sunset",
      credentials: { apiKey: "sso=valid-sso-token" },
    });

    expect(media).toHaveLength(1);
    expect(media[0].mime).toBe("image/png");
    expect(media[0].b64).toBe(dummyImageBuffer.toString("base64"));

    // Verify first call hit grok.com/rest/app-chat/conversations/new
    expect(fetchMock.mock.calls[0][0]).toBe("https://grok.com/rest/app-chat/conversations/new");
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody.enableImageGeneration).toBe(true);
    expect(sentBody.message).toContain("a beautiful cyberpunk sunset");

    // Verify second call fetched from assets.grok.com
    expect(fetchMock.mock.calls[1][0]).toBe("https://assets.grok.com/generated/test-image.png");
  });

  it("handles Cloudflare challenge with an actionable message", async () => {
    const executor = new GrokWebExecutor();
    const challengeHtml = "<html><title>Just a moment...</title><body>challenge-running</body></html>";
    fetchMock.mockResolvedValueOnce(new Response(challengeHtml, { status: 403 }));

    await expect(
      executor.generateMedia({
        prompt: "test",
        credentials: { apiKey: "sso=my-token" },
      })
    ).rejects.toThrow(/Cloudflare challenge/);
  });
});
