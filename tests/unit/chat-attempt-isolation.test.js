// Exercise real combo selection and chatCore preprocessing with mock upstreams.
import { describe, expect, it, vi } from "vitest";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));
vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: true, execute: executeMock }),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(), logRawRequest: vi.fn(), logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(), logConvertedResponse: vi.fn(), logError: vi.fn(),
  }),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}), saveRequestDetail: vi.fn(async () => {}),
}));

import { handleChatCore } from "../../open-sse/handlers/chatCore.js";
import { handleComboChat, detectRequiredCapabilities } from "../../open-sse/services/combo.js";

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
function fixture() {
  return {
    model: "fallback-test", stream: false,
    messages: [
      { role: "user", content: [
        { type: "text", text: "Remember this chart" },
        { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
      ] },
      { role: "assistant", content: "What would you like to know?" },
      { role: "user", content: "Read the exact values in that chart" },
    ],
  };
}

async function replay() {
  const body = fixture();
  const before = structuredClone(body);
  const attempts = [];
  executeMock.mockImplementation(async (opts) => {
    attempts.push(structuredClone(opts.body));
    const first = attempts.length === 1;
    return {
      response: new Response(JSON.stringify(first
        ? { error: { message: "upstream unavailable" } }
        : { id: "chatcmpl-test", object: "chat.completion", choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ] }), { status: first ? 503 : 200, headers: { "content-type": "application/json" } }),
      url: "https://offline.invalid/chat/completions", headers: {}, transformedBody: opts.body,
    };
  });
  // Auto-switch considers the current turn. Historical media must survive a
  // failure of the first, text-only model even when auto-switch is enabled.
  expect(detectRequiredCapabilities(body).size).toBe(0);
  const response = await handleComboChat({
    body, models: ["deepseek/deepseek-chat", "openai/gpt-4o"], log,
    comboName: "attempt-isolation-test", comboStrategy: "fallback",
    handleSingleModel: async (shared, modelStr) => {
      const split = modelStr.indexOf("/");
      const provider = modelStr.slice(0, split);
      const model = modelStr.slice(split + 1);
      const result = await handleChatCore({
        // The app handler shallow-copies only the root object for each attempt.
        body: { ...shared, model: modelStr }, modelInfo: { provider, model },
        credentials: { apiKey: "offline-fixture", providerSpecificData: {} }, log,
        connectionId: "offline-" + provider,
        clientRawRequest: { endpoint: "/v1/chat/completions", body: before, headers: { accept: "application/json" } },
        rtkEnabled: false, headroomEnabled: false, cavemanEnabled: false, ponytailEnabled: false,
      });
      return result.response;
    },
  });
  expect(attempts).toHaveLength(2);
  expect(response.status).toBe(200);
  return { body, before, attempts };
}

describe("chat attempt isolation", () => {
  it("strips media only for the failed text-only attempt, preserving it for the vision fallback", async () => {
    const { attempts } = await replay();
    expect(attempts[0].messages[0].content.some(p => p.type === "image_url")).toBe(false);
    expect(attempts[1].messages[0].content.some(p => p.type === "image_url")).toBe(true);
  });

  it("preserves the caller request across failed and successful preprocessing", async () => {
    const { body, before } = await replay();
    expect(body).toEqual(before);
  });
});
