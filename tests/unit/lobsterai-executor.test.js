import { describe, it, expect, vi, beforeEach } from "vitest";

// proxyAwareFetch is the executor's only network entry (BaseExecutor.execute).
// Mock the module rather than global fetch: the version probe deliberately uses
// global fetch, so the two have to be stubbable independently.
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { LobsterAiExecutor } = await import("../../open-sse/executors/lobsterai.js");
const { resetClientVersionCache, resolveClientVersion, clientVersionSnapshot } =
  await import("../../open-sse/shared/lobsterai/client.js");

function sseResponse(text) {
  return new Response(text, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function requestResult() {
  return {
    url: "https://lobsterai-server.youdao.com/api/proxy/v1/chat/completions",
    headers: {},
    transformedBody: {},
  };
}

async function runExecute(body = {}, response = sseResponse('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')) {
  fetchMock.mockResolvedValueOnce(response);
  const executor = new LobsterAiExecutor();
  return executor.execute({
    ...requestResult(),
    model: "glm-5.2",
    body: { model: "glm-5.2", messages: [{ role: "user", content: "hi" }], ...body },
    stream: false,
    credentials: { accessToken: "at-test" },
  });
}

describe("lobsterai executor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetClientVersionCache();
    // The executor kicks off an async version probe; keep it off the network.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ data: { value: { version: "2026.10.1" } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
  });

  it("forces stream:true and sends both functional client headers", async () => {
    await resolveClientVersion(); // populate the snapshot deterministically
    fetchMock.mockResolvedValueOnce(sseResponse('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));

    const executor = new LobsterAiExecutor();
    const out = await executor.execute({
      ...requestResult(),
      model: "glm-5.2",
      body: {
        model: "glm-5.2",
        stream: false,
        messages: [{ role: "developer", content: "rules" }],
        tool_choice: "none",
        prompt_cache_key: "must-not-leak",
      },
      stream: false,
      credentials: { accessToken: "at-test" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/proxy/v1/chat/completions");
    const sent = JSON.parse(init.body);
    expect(sent.stream).toBe(true);
    expect(sent.messages[0].role).toBe("system");
    expect(sent.tool_choice).toBeUndefined();
    expect(sent.prompt_cache_key).toBeUndefined();

    expect(init.headers["X-LobsterAI-Client-Capabilities"]).toBe("kimi-k3-agentic-v1");
    expect(init.headers["X-LobsterAI-Client-Version"]).toBe("2026.10.1");
    expect(init.headers["X-LobsterAI-Client-Version"]).not.toBe("");

    // Normal first frame is replayed byte-for-byte.
    expect(await out.response.text()).toContain('"content":"hi"');
  });

  it("turns a 200 event:error frame with code 40201 + Chinese copy into HTTP 402", async () => {
    const frame = [
      "event:error",
      'data: {"type":"proxy_error","code":40201,"message":"免费额度已用完，请升级套餐"}',
      "",
      "",
    ].join("\n");
    const out = await runExecute({}, sseResponse(frame));

    expect(out.response.status).toBe(402);
    const body = JSON.parse(await out.response.text());
    expect(body.error.message).toContain("积分不足");
    expect(body.error.message).toContain("免费额度已用完");
  });

  it("treats 40100/40101 in a 200 error frame as a dead session (401)", async () => {
    const frame = 'event:error\ndata: {"code":40100,"message":"token rejected"}\n\n';
    const out = await runExecute({}, sseResponse(frame));

    expect(out.response.status).toBe(401);
    expect((await out.response.text()).includes("重新登录")).toBe(true);
  });

  it("maps an unmatched 200 error frame to 400 instead of cooling the account", async () => {
    const frame = 'event:error\ndata: {"type":"proxy_error","code":40300,"message":"unknown model"}\n\n';
    const out = await runExecute({}, sseResponse(frame));

    expect(out.response.status).toBe(400);
    expect((await out.response.text()).includes("unknown model")).toBe(true);
  });

  it("does not mistake a normal 200 stream for a fake success", async () => {
    const frame = 'data: {"id":"c1","choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\n';
    const out = await runExecute({}, sseResponse(frame));

    expect(out.response.status).toBe(200);
    expect(await out.response.text()).toBe(frame);
  });

  it("re-classifies a non-2xx HTTP 400 carrying the Chinese credit marker as 402", async () => {
    const executor = new LobsterAiExecutor();
    const parsed = executor.parseError(
      new Response("", { status: 400 }),
      JSON.stringify({ code: 1, msg: "积分不足" }),
    );
    expect(parsed.status).toBe(402);
    expect(parsed.message).toContain("积分不足");
  });
});
