// Guards the spec-default stream semantics (issue #4): an omitted `stream`
// field means a plain JSON response (OpenAI Chat Completions / Anthropic
// Messages contract). Streaming is opt-in: explicit stream:true, a pure
// `Accept: text/event-stream` header, or a forceStream provider (drained back
// to JSON downstream). Peers agree: CLIProxyAPI streams only on explicit
// stream:true; OmniRoute's resolveStreamFlag defaults openai/claude formats to
// non-stream (their #302/#656/#5305 lineage).
import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({
    execute: executeMock,
    refreshCredentials: vi.fn().mockResolvedValue(null),
  })),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logError: vi.fn(),
  })),
}));

vi.mock("../../open-sse/utils/clientDetector.js", () => ({
  detectClientTool: vi.fn(() => null),
  isNativePassthrough: vi.fn(() => false),
}));

vi.mock("../../open-sse/utils/bypassHandler.js", () => ({
  handleBypassRequest: vi.fn(() => null),
}));

vi.mock("../../open-sse/utils/streamHandler.js", () => ({
  createStreamController: vi.fn(() => ({
    signal: undefined,
    handleComplete: vi.fn(),
    handleError: vi.fn(),
  })),
}));

vi.mock("../../open-sse/services/tokenRefresh.js", () => ({
  refreshWithRetry: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  default: vi.fn(),
  proxyAwareFetch: vi.fn(),
}));

vi.mock("../../open-sse/translator/formats/claude.js", () => ({
  normalizeClaudePassthrough: vi.fn(),
}));

vi.mock("../../open-sse/utils/toolDeduper.js", () => ({
  dedupeTools: vi.fn((tools) => ({ tools, stripped: [] })),
}));

vi.mock("../../open-sse/rtk/caveman.js", () => ({
  injectCaveman: vi.fn(),
}));

vi.mock("../../open-sse/rtk/ponytail.js", () => ({
  injectPonytail: vi.fn(),
}));

vi.mock("../../open-sse/rtk/index.js", () => ({
  compressMessages: vi.fn(() => null),
  formatRtkLog: vi.fn(() => ""),
}));

// Must cover every export chatCore.js imports — a factory mock replaces the
// module wholesale, so anything omitted throws "No export is defined" rather
// than falling through to the real implementation.
vi.mock("../../open-sse/rtk/headroom.js", () => ({
  compressWithHeadroom: vi.fn(async () => null),
  formatHeadroomLog: vi.fn(() => ""),
  formatHeadroomSizeLog: vi.fn(() => ""),
  isHeadroomPhantomSavings: vi.fn(() => false),
}));

vi.mock("../../open-sse/providers/capabilities.js", () => ({
  getCapabilitiesForModel: vi.fn(() => ({})),
}));

vi.mock("../../open-sse/translator/concerns/modality.js", () => ({
  stripUnsupportedModalities: vi.fn(() => false),
}));

vi.mock("../../open-sse/translator/concerns/prefetch.js", () => ({
  prefetchRemoteImages: vi.fn(async () => 0),
}));

vi.mock("../../open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: vi.fn((detail) => detail),
  extractRequestConfig: vi.fn((body, stream) => ({ body, stream })),
}));

vi.mock("../../open-sse/utils/error.js", () => ({
  createErrorResult: vi.fn((status, message) => ({ success: false, status, error: message })),
  formatProviderError: vi.fn((error) => error.message),
  parseUpstreamError: vi.fn(),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
}));


// deepseek has no forceStream — the pure spec-default path.
function makeOptions({ bodyStream, accept } = {}) {
  const body = {
    model: "deepseek-chat",
    messages: [{ role: "user", content: "hello" }],
  };
  if (bodyStream !== undefined) body.stream = bodyStream;

  const headers = {};
  if (accept !== undefined) headers.accept = accept;

  return {
    body,
    modelInfo: { provider: "deepseek", model: "deepseek-chat" },
    credentials: { apiKey: "sk-test" },
    clientRawRequest: { endpoint: "/v1/chat/completions", body, headers },
    connectionId: "test-connection",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

async function executedStreamFlag(options) {
  const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
  await handleChatCore(options);
  expect(executeMock).toHaveBeenCalledTimes(1);
  return executeMock.mock.calls[0][0].stream;
}

describe("stream default semantics (issue #4)", () => {
  beforeEach(() => {
    executeMock.mockReset();
    executeMock.mockRejectedValue(new Error("boom"));
  });

  it("omitted stream + no Accept → non-streaming (spec default)", async () => {
    expect(await executedStreamFlag(makeOptions())).toBe(false);
  });

  it("omitted stream + Accept */* (curl/SDK default) → non-streaming", async () => {
    expect(await executedStreamFlag(makeOptions({ accept: "*/*" }))).toBe(false);
  });

  it("explicit stream:true → streaming", async () => {
    expect(await executedStreamFlag(makeOptions({ bodyStream: true }))).toBe(true);
  });

  it("explicit stream:false → non-streaming", async () => {
    expect(await executedStreamFlag(makeOptions({ bodyStream: false }))).toBe(false);
  });

  it("omitted stream + pure Accept: text/event-stream → SSE opt-in", async () => {
    expect(await executedStreamFlag(makeOptions({ accept: "text/event-stream" }))).toBe(true);
  });

  it("omitted stream + Accept: application/json, text/event-stream (AI SDK non-stream signature) → non-streaming", async () => {
    expect(
      await executedStreamFlag(makeOptions({ accept: "application/json, text/event-stream" }))
    ).toBe(false);
  });

  it("explicit stream:false beats an SSE Accept header", async () => {
    expect(
      await executedStreamFlag(makeOptions({ bodyStream: false, accept: "text/event-stream" }))
    ).toBe(false);
  });
});
