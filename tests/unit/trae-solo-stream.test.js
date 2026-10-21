import { describe, it, expect, vi, beforeEach } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));

const { default: TraeSoloExecutor } = await import("../../open-sse/executors/trae-solo.js");
const { checkFallbackError } = await import("../../open-sse/services/accountFallback.js");

function sseResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function jsonResponse(payload, status) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function run(upstreamResponse, stream = true) {
  fetchMock.mockResolvedValueOnce(upstreamResponse);
  const executor = new TraeSoloExecutor();
  return executor.execute({
    model: "glm-5.2",
    body: { model: "glm-5.2", messages: [{ role: "user", content: "hi" }] },
    stream,
    credentials: { accessToken: "tok-test", providerSpecificData: {} },
  });
}

function dataFrames(text) {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6));
}

function parsedChunks(text) {
  return dataFrames(text)
    .filter((payload) => payload !== "[DONE]")
    .map((payload) => JSON.parse(payload));
}

describe("trae-solo stream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("appends [DONE] even when upstream only sends event: done, and carries usage", async () => {
    const upstream =
      'event: output\ndata: {"response":"hel"}\n\n' +
      'event: output\ndata: {"response":"lo"}\n\n' +
      'event: token_usage\ndata: {"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}\n\n' +
      'event: done\ndata: {"finish_reason":"stop"}\n\n';

    const out = await run(sseResponse(upstream));
    expect(out.response.status).toBe(200);
    const text = await out.response.text();

    expect(dataFrames(text).filter((payload) => payload === "[DONE]")).toHaveLength(1);
    const chunks = parsedChunks(text);
    expect(chunks.filter((chunk) => chunk.choices?.[0]?.delta?.content).map((c) => c.choices[0].delta.content)).toEqual([
      "hel",
      "lo",
    ]);
    const finish = chunks.find((chunk) => chunk.choices?.[0]?.finish_reason);
    expect(finish.choices[0].finish_reason).toBe("stop");
    expect(finish.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
  });

  it("synthesizes a finish frame and [DONE] when the stream closes without event: done", async () => {
    const upstream = 'event: output\ndata: {"response":"partial"}\n\n';
    const out = await run(sseResponse(upstream));
    const text = await out.response.text();
    const chunks = parsedChunks(text);

    expect(chunks.some((chunk) => chunk.choices?.[0]?.finish_reason === "stop")).toBe(true);
    expect(dataFrames(text).at(-1)).toBe("[DONE]");
  });

  it("turns a first-frame business error into a real HTTP error (no 200 fake success)", async () => {
    const upstream = 'event: error\ndata: {"code":4008,"message":"Your requests have exceeded the quota"}\n\n';
    const out = await run(sseResponse(upstream));

    expect(out.response.status).toBe(429);
    const payload = await out.response.json();
    expect(payload.error.code).toBe(4008);
    expect(payload.error.message).toContain("4008");
  });

  it("maps model_context_window_exceeded to length instead of stop", async () => {
    const upstream =
      'event: output\ndata: {"response":"cut"}\n\n' +
      'event: done\ndata: {"finish_reason":"model_context_window_exceeded"}\n\n';

    const out = await run(sseResponse(upstream));
    const chunks = parsedChunks(await out.response.text());
    const finish = chunks.find((chunk) => chunk.choices?.[0]?.finish_reason);
    expect(finish.choices[0].finish_reason).toBe("length");
    expect(chunks.some((chunk) => chunk.choices?.[0]?.finish_reason === "stop")).toBe(false);
  });

  it("aggregates non-stream requests and keeps finish_reason=length", async () => {
    const upstream =
      'event: output\ndata: {"response":"cut"}\n\n' +
      'event: token_usage\ndata: {"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}\n\n' +
      'event: done\ndata: {"finish_reason":"length"}\n\n';

    const out = await run(sseResponse(upstream), false);
    expect(out.response.status).toBe(200);
    const payload = await out.response.json();
    expect(payload.choices[0].message.content).toBe("cut");
    expect(payload.choices[0].finish_reason).toBe("length");
    expect(payload.usage.total_tokens).toBe(2);
  });

  it("classifies 9074 as a short device-level cooldown, never a channel block", async () => {
    const upstream = 'event: error\ndata: {"code":9074,"message":"device rate limited"}\n\n';
    const out = await run(sseResponse(upstream));
    expect(out.response.status).toBe(429);

    const payload = await out.response.json();
    expect(payload.error.type).toBe("device_rate_limit");
    const fallback = checkFallbackError(429, payload.error.message, 0, "trae-solo");
    expect(fallback.shouldFallback).toBe(true);
    expect(fallback.channelScope).toBe(false);
    expect(fallback.cooldownMs).toBe(5000);
  });

  it("keeps streaming after content and reports a late error frame", async () => {
    const upstream =
      'event: output\ndata: {"response":"hi"}\n\n' +
      'event: error\ndata: {"code":4011,"message":"rate limited"}\n\n';

    const out = await run(sseResponse(upstream));
    expect(out.response.status).toBe(200);
    const text = await out.response.text();
    expect(text).toContain('"content":"hi"');
    expect(parsedChunks(text).some((chunk) => chunk.error?.code === 4011)).toBe(true);
    expect(dataFrames(text).at(-1)).toBe("[DONE]");
  });

  it("keeps an HTTP-level 401 as a real error", async () => {
    const out = await run(jsonResponse({ code: 401, message: "unauthorized" }, 401));
    expect(out.response.status).toBe(401);
  });
});
