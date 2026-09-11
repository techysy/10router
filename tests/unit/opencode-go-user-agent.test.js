import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: fetchMock,
}));

import { getExecutor } from "../../open-sse/executors/index.js";

const PKG_VERSION = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
).version;
const TRANSPORT = { format: "openai", baseUrl: "https://opencode.ai/zen/go/v1/chat/completions", auth: { combined: true, header: "Authorization", scheme: "bearer" } };

function makeCredentials(rawHeaders = {}) {
  return {
    apiKey: "test-key",
    connectionId: "connection-a",
    rawHeaders,
    runtimeTransport: TRANSPORT,
  };
}

function buildHeaders(rawHeaders) {
  const executor = getExecutor("opencode-go");
  const credentials = executor.prepareRequestCredentials({
    body: { messages: [{ role: "user", content: "hello" }] },
    credentials: makeCredentials(rawHeaders),
    providerSessionId: "conversation-a",
    clientTool: "claude",
  });
  return executor.buildHeaders(credentials, true);
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
});

describe("OpenCode Go user-agent", () => {
  it("identifies as 10router when the client sends no user-agent", () => {
    expect(buildHeaders()["User-Agent"]).toBe(`10router/${PKG_VERSION}`);
  });

  it("forwards a verified client's own identifier verbatim", () => {
    for (const ua of [
      "claude-cli/2.1.92 (external, sdk-cli)",
      "codex_cli_rs/0.154.0",
      "opencode/1.2.3",
      "my-coding-agent/1.0",
    ]) {
      expect(buildHeaders({ "user-agent": ua })["User-Agent"]).toBe(ua);
    }
  });

  it("reads the downstream header case-insensitively", () => {
    expect(buildHeaders({ "User-Agent": "codex_cli_rs/0.154.0" })["User-Agent"])
      .toBe("codex_cli_rs/0.154.0");
  });

  it("replaces generic runtime and HTTP-library names", () => {
    for (const ua of [
      "node",
      "undici",
      "axios/1.7.0",
      "python-requests/2.32.0",
      "curl/8.4.0",
      "Go-http-client/2.0",
      "node-fetch/3.3.2",
    ]) {
      expect(buildHeaders({ "user-agent": ua })["User-Agent"]).toBe(`10router/${PKG_VERSION}`);
    }
  });

  it("treats a blank user-agent like a missing one", () => {
    expect(buildHeaders({ "user-agent": "   " })["User-Agent"]).toBe(`10router/${PKG_VERSION}`);
  });

  it("keeps a registry-pinned user-agent untouched", () => {
    const executor = getExecutor("opencode-go");
    const original = executor.config.headers;
    // No runtimeTransport: the config-level headers are the ones DefaultExecutor merges.
    executor.config.headers = { "User-Agent": "pinned/9.9.9" };
    try {
      const credentials = executor.prepareRequestCredentials({
        body: {},
        credentials: { apiKey: "test-key", connectionId: "connection-a", rawHeaders: {} },
        providerSessionId: "conversation-a",
        clientTool: "claude",
      });
      expect(executor.buildHeaders(credentials, true)["User-Agent"]).toBe("pinned/9.9.9");
    } finally {
      executor.config.headers = original;
    }
  });

  it("sends the resolved user-agent on the actual fetch", async () => {
    const executor = getExecutor("opencode-go");
    const result = await executor.execute({
      model: "glm-5.2",
      body: { messages: [{ role: "user", content: "hello" }] },
      stream: false,
      credentials: makeCredentials({ "user-agent": "claude-cli/2.1.92 (external, sdk-cli)" }),
      providerSessionId: "conversation-fetch",
      clientTool: "claude",
    });

    expect(result.headers["User-Agent"]).toBe("claude-cli/2.1.92 (external, sdk-cli)");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1].headers["User-Agent"])
      .toBe("claude-cli/2.1.92 (external, sdk-cli)");
  });

  it("does not retag unrelated executors", () => {
    const headers = getExecutor("openai").buildHeaders({ apiKey: "test-key" }, false);
    expect(headers["User-Agent"] || "").not.toMatch(/^10router\//);
  });
});
