/**
 * Queue-wait tests for the Qoder executor's 10605 handling (A/B/C):
 *
 *   A. execute() stands in the upstream queue — wait retryAfterSeconds,
 *      re-sign, resend the SAME body — instead of failing the account on the
 *      first 10605 (bounded by QUEUE_WAIT_*).
 *   B. when the budget runs out, a per-(provider,model) flag makes the
 *      account walk fail fast: the queue is GLOBAL (NAS 2026-10-27, five
 *      accounts quoting the same queueCount=1742), so sibling attempts only
 *      re-learn the same verdict.
 *   C. the 429 text carries waitTime (queue-drain estimate), so
 *      extractRetrySeconds locks the model for the real window instead of
 *      the 30s re-poll interval.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { proxyAwareFetchMock, scripted, calls } = vi.hoisted(() => ({
  proxyAwareFetchMock: vi.fn(),
  scripted: [],
  calls: [],
}));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: proxyAwareFetchMock }));

vi.mock("../../open-sse/services/qoderModels.js", () => ({
  getQoderModelConfig: vi.fn(async (_credentials, key) => ({
    key,
    is_reasoning: true,
    max_output_tokens: 8192,
    source: "system",
  })),
  resolveQoderModels: vi.fn(async () => null),
  isQoderPat: (t) => typeof t === "string" && t.startsWith("pt-"),
  resolveQoderCredentials: vi.fn(async (c) => c),
}));

import { QoderExecutor, __test__ } from "../../open-sse/executors/qoder.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

const { queueFlags, setQueueSleeper, resetQueueSleeper, QUEUE_WAIT_MAX_RESENDS, QUEUE_WAIT_MAX_TOTAL_MS, QUEUE_FLAG_MAX_MS } = __test__;

function sseResponse(frames, { status = 200 } = {}) {
  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status });
}

// Real upstream shape (NAS 2026-10-27): 10605 nested inside a 403 envelope,
// with both the re-poll interval and the queue-drain estimate.
function queueFrame({ waitTime = 30, retryAfter = 30, queueCount = 1742 } = {}) {
  const inner = JSON.stringify({
    isQueued: true,
    modelKey: "qfmodel",
    queueCount,
    queueType: "p3",
    retryAfterSeconds: retryAfter,
    serviceAvailable: true,
    subCode: "CALL_COUNT_LIMIT",
    waitTime,
  });
  const body = JSON.stringify({ code: "403", message: JSON.stringify({ code: "10605", message: inner }) });
  return `data: ${JSON.stringify({ statusCodeValue: 403, body })}\n\n`;
}

function hard429Frame() {
  const body = JSON.stringify({ code: "provider_error", message: "All backends failed", type: "provider_error" });
  return `data: ${JSON.stringify({ statusCodeValue: 429, body })}\n\n`;
}

function okFrames() {
  const env = (inner) => `data: ${JSON.stringify({ statusCodeValue: 200, body: inner })}\n\n`;
  return [env(JSON.stringify({ id: "1", choices: [{ delta: { content: "pong" } }] })), "data: [DONE]\n\n"];
}

const executor = new QoderExecutor("qoder");
const credentials = { accessToken: "dt-testtoken", providerSpecificData: { userId: "u-1", machineId: "" } };

function run(signal) {
  return executor.execute({
    model: "qoder/qfmodel",
    body: { messages: [{ role: "user", content: "say pong" }], max_tokens: 100 },
    stream: true,
    credentials,
    signal,
    log: { info() {}, warn() {}, error() {} },
    proxyOptions: null,
  });
}

let waits;

beforeEach(() => {
  scripted.length = 0;
  calls.length = 0;
  waits = [];
  queueFlags.clear();
  proxyAwareFetchMock.mockImplementation(async (url, init) => {
    calls.push({ url, init });
    const next = scripted.shift();
    if (!next) throw new Error("no scripted response left");
    return next();
  });
  setQueueSleeper(async (ms) => {
    waits.push(ms);
  });
});

afterEach(() => {
  resetQueueSleeper();
  proxyAwareFetchMock.mockReset();
});

describe("A: standing in the 10605 queue", () => {
  it("waits the poll interval, re-signs, resends the same body, and serves the stream", async () => {
    scripted.push(
      () => sseResponse([queueFrame({ waitTime: 20, retryAfter: 30 })]),
      () => sseResponse(okFrames()),
    );

    const { response } = await run();
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([30_000]);
    // Re-signed: fresh COSY signature per attempt, identical body bytes.
    expect(calls[0].init.headers.Authorization).not.toBe(calls[1].init.headers.Authorization);
    expect(Buffer.compare(calls[0].init.body, calls[1].init.body)).toBe(0);

    expect(response.ok).toBe(true);
    const text = await response.text();
    expect(text).toContain("pong");
    expect(text).toContain("data: [DONE]");
  });

  it("gives up once the wait would exceed the standing-in-line budget", async () => {
    // waitTime 60s: round 1 fits (60s ≤ 90s), round 2 would exceed → give up.
    scripted.push(
      () => sseResponse([queueFrame({ waitTime: 60 })]),
      () => sseResponse([queueFrame({ waitTime: 60 })]),
    );

    const { response } = await run();
    expect(calls).toHaveLength(2);
    expect(response.status).toBe(429);
    const { error } = await response.json();
    expect(error.message).toContain("10605");
  });

  it("never stands in line when the queue is deeper than the budget (waitTime 390s)", async () => {
    scripted.push(() => sseResponse([queueFrame({ waitTime: 390 })]));

    const { response } = await run();
    expect(calls).toHaveLength(1); // no blind resend against a 6.5min queue
    expect(response.status).toBe(429);
  });

  it("respects QUEUE_WAIT_MAX_RESENDS", async () => {
    for (let i = 0; i < QUEUE_WAIT_MAX_RESENDS + 1; i++) {
      scripted.push(() => sseResponse([queueFrame({ waitTime: 30 })]));
    }
    const { response } = await run();
    expect(calls).toHaveLength(QUEUE_WAIT_MAX_RESENDS + 1); // initial + N re-sends
    expect(waits).toHaveLength(QUEUE_WAIT_MAX_RESENDS);
    expect(response.status).toBe(429);
    expect(QUEUE_WAIT_MAX_TOTAL_MS).toBeGreaterThan(0);
  });

  it("does not blind-resend a hard 429 (All backends failed)", async () => {
    scripted.push(() => sseResponse([hard429Frame()]));

    const { response } = await run();
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
    expect(response.status).toBe(429);
    const { error } = await response.json();
    expect(error.message).toContain("All backends failed");
  });
});

describe("B: fast-fail flag stops the account walk", () => {
  it("sibling attempts skip upstream entirely while the verdict is fresh", async () => {
    scripted.push(() => sseResponse([queueFrame({ waitTime: 390 })]));
    const first = await run();
    expect(first.response.status).toBe(429);
    expect(calls).toHaveLength(1);

    const second = await run();
    expect(calls).toHaveLength(1); // zero new upstream calls
    expect(second.response.status).toBe(429);
    const { error } = await second.response.json();
    expect(error.message).toContain("still queued upstream");
    expect(error.message).toMatch(/retry after \d+ seconds/);
    // The fast-fail cooldown honors the remaining window, not the full depth.
    const verdict = checkFallbackError(429, error.message, 0);
    expect(verdict.shouldFallback).toBe(true);
    expect(verdict.cooldownMs).toBeGreaterThan(0);
    expect(verdict.cooldownMs).toBeLessThanOrEqual(QUEUE_FLAG_MAX_MS + 1000);
  });

  it("flag expires so recovery is probed again", async () => {
    scripted.push(() => sseResponse([queueFrame({ waitTime: 390 })]));
    await run();
    const flag = queueFlags.get("qoder:qfmodel");
    expect(flag).toBeDefined();
    expect(flag.until - Date.now()).toBeLessThanOrEqual(120_000);

    queueFlags.get("qoder:qfmodel").until = Date.now() - 1;
    scripted.push(() => sseResponse(okFrames()));
    const { response } = await run();
    expect(calls).toHaveLength(2); // went upstream again
    expect(response.ok).toBe(true);
  });

  it("a served request clears the flag", async () => {
    queueFlags.set("qoder:qfmodel", { until: Date.now() - 1, waitSec: 30 });
    scripted.push(() => sseResponse(okFrames()));
    const { response } = await run();
    expect(response.ok).toBe(true);
    expect(queueFlags.has("qoder:qfmodel")).toBe(false);
  });
});

describe("C: the 429 cooldown honors waitTime", () => {
  it("qoderErrorResponse prefers waitTime over retryAfterSeconds", async () => {
    scripted.push(() => sseResponse([queueFrame({ waitTime: 390 })]));
    const { response } = await run();
    const { error } = await response.json();
    expect(error.message).toContain("retry after 390 seconds");
    expect(error.message).not.toContain("retry after 30 seconds");

    const verdict = checkFallbackError(429, error.message, 0);
    expect(verdict.shouldFallback).toBe(true);
    expect(verdict.cooldownMs).toBe(390_000); // the real queue window, not 30s
  });

  it("falls back to retryAfterSeconds when no waitTime is present", () => {
    const { qoderErrorResponse } = __test__;
    const msg = '{"code":"10605","message":"{\\"retryAfterSeconds\\":30}"}';
    const res = qoderErrorResponse("10605", 403, msg);
    expect(res.status).toBe(429);
  });
});
