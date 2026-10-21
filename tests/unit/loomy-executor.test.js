import { describe, it, expect, vi, beforeEach } from "vitest";

// BaseExecutor only reaches the network through proxyAwareFetch.
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { LoomyExecutor, QUOTA_STRONG_RE } = await import("../../open-sse/executors/loomy.js");

function sseResponse(text = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n') {
  return new Response(text, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function execute(body = {}, response = sseResponse(), credentials = { apiKey: "session-1" }) {
  fetchMock.mockResolvedValueOnce(response);
  const executor = new LoomyExecutor();
  return executor.execute({
    url: "https://loomyad.xunfei.cn/api/v1/chat/completions",
    headers: {},
    transformedBody: {},
    model: "GLM-5.3-Flash",
    body: { model: "GLM-5.3-Flash", messages: [{ role: "user", content: "hi" }], ...body },
    stream: false,
    credentials,
  });
}

describe("loomy executor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends both auth headers (chat Bearer + business token) and defaults max_tokens to 32768", async () => {
    const out = await execute();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://loomyad.xunfei.cn/api/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer session-1");
    expect(init.headers.token).toBe("session-1");

    const sent = JSON.parse(init.body);
    expect(sent.max_tokens).toBe(32768);
    expect(sent.max_completion_tokens).toBeUndefined();
    expect(await out.response.text()).toContain('"content":"hi"');
  });

  it("keeps an explicit max_tokens instead of overwriting it", async () => {
    await execute({ max_tokens: 1024 });
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.max_tokens).toBe(1024);
  });

  it("turns a 200 auth envelope (100002) into HTTP 401", async () => {
    const out = await execute({}, jsonResponse({ code: "100002", desc: "登录态已失效" }));

    expect(out.response.status).toBe(401);
    const body = await out.response.json();
    expect(body.error.message).toContain("登录态已失效");
    expect(body.error.message).toContain("重新导入");
  });

  it("turns a non-success 200 envelope into a non-2xx upstream error", async () => {
    const out = await execute({}, jsonResponse({ code: "500001", desc: "参数错误" }));

    expect(out.response.status).toBe(502);
    const body = await out.response.json();
    expect(body.error.message).toContain("参数错误");
  });

  it("passes a normal 200 JSON completion through untouched", async () => {
    const payload = {
      id: "c1",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    };
    const out = await execute({}, jsonResponse(payload));
    expect(await out.response.json()).toEqual(payload);
  });

  it("separates a quota wall from a bare 429", () => {
    const executor = new LoomyExecutor();

    const quota = executor.parseError(
      { status: 429 },
      JSON.stringify({ code: "429", desc: "积分已用完，请充值" })
    );
    expect(quota.status).toBe(429);
    expect(quota.message).toContain("积分已耗尽");
    expect(QUOTA_STRONG_RE.test("积分已用完，请充值")).toBe(true);

    const bare = executor.parseError(
      { status: 429 },
      JSON.stringify({ code: "429", desc: "too many requests" })
    );
    expect(bare.status).toBe(429);
    expect(bare.message).toContain("限流");
    expect(bare.message).not.toContain("积分已耗尽");
    expect(QUOTA_STRONG_RE.test("too many requests")).toBe(false);
  });
});
