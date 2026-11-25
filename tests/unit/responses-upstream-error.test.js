// 2026-11-25 12:09 incident: Xingchi sent a mid-stream Responses
// `response.failed` ("gpt-6.1-sol requires Responses for tool calls; this
// account only supports Chat Completions" — itself bogus: the same key/model
// did Responses tool calls minutes before and after). The gateway then:
//   (a) poured the upstream error text into the assistant message as
//       `[Error] ...` and answered HTTP 200, so the client kept chatting
//       with a dead turn;
//   (b) wrote NO usageHistory row for the failed turn;
//   (c) had already logged `[COMBO] Model xc/gpt-6.1-sol succeeded` when
//       the stream STARTED, and never corrected it.
// This file pins the fixed behavior at every layer the incident touched.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import "../translator/registerAll.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { translateResponse, initState } from "../../open-sse/translator/index.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(),
}));

const { parseSSEToOpenAIResponse } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");
const { buildOnStreamComplete } = await import("../../open-sse/handlers/chatCore/streamingHandler.js");
const usageDb = await import("@/lib/usageDb.js");

const UPSTREAM_MESSAGE = "gpt-6.1-sol requires Responses for tool calls; this account only supports Chat Completions";
const FAILED_EVENT = {
  type: "response.failed",
  response: {
    id: "resp_bfd108b1ca374ac79448305c35de765f",
    status: "failed",
    error: { message: UPSTREAM_MESSAGE, type: "invalid_request_error", code: "unsupported_tool_calls" },
  },
};

function responsesSSE(...events) {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}`).join("\n\n") + "\n";
}

async function runTransform(targetFormat, sourceFormat, input, onStreamComplete) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(input));
      controller.close();
    },
  });
  const output = stream.pipeThrough(
    createSSETransformStreamWithLogger(targetFormat, sourceFormat, "testprov", null, null, "xc/gpt-6.1-sol", null, null, onStreamComplete),
  );
  const reader = output.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

describe("translator: upstream Responses error is a real error frame, not text", () => {
  it("response.failed returns { error } — never a [Error] content chunk", () => {
    const state = initState(FORMATS.OPENAI);
    const out = translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, FAILED_EVENT, state);
    expect(Array.isArray(out)).toBe(true);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      error: {
        message: UPSTREAM_MESSAGE,
        type: "invalid_request_error",
        code: "unsupported_tool_calls",
      },
    });
    expect(JSON.stringify(out)).not.toContain("[Error]");
    // The translator still records the error on state — the stream layer
    // reads it to book the turn as a failure.
    expect(state.error).toBeTruthy();
    expect(state.error.message).toBe(UPSTREAM_MESSAGE);
  });

  it("a bare error event is also an error frame", () => {
    const state = initState(FORMATS.OPENAI);
    const out = translateResponse(
      FORMATS.OPENAI_RESPONSES,
      FORMATS.OPENAI,
      { type: "error", error: { message: "model_not_found" } },
      state,
    );
    expect(out).toHaveLength(1);
    expect(out[0].error.message).toBe("model_not_found");
    expect(JSON.stringify(out)).not.toContain("[Error]");
  });
});

describe("stream translate lane (Pi path: Responses upstream → OpenAI client)", () => {
  const input = responsesSSE(
    { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
    { type: "response.output_text.delta", delta: "OK" },
    FAILED_EVENT,
  );

  it("emits a data: {\"error\": ...} frame and no [Error] text", async () => {
    const seen = [];
    const output = await runTransform(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, input, (c) => seen.push(c));
    expect(output).toContain(`"error":{"message":"${UPSTREAM_MESSAGE}"`);
    expect(output).not.toContain("[Error]");
    // The partial text the model produced before dying is still delivered.
    expect(output).toContain("OK");
  });

  it("books the turn as failed via onStreamComplete (upstreamError set)", async () => {
    const seen = [];
    await runTransform(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, input, (c) => seen.push(c));
    expect(seen).toHaveLength(1);
    expect(seen[0].upstreamError).toBeTruthy();
    expect(seen[0].upstreamError.message).toBe(UPSTREAM_MESSAGE);
    expect(seen[0].upstreamError.type).toBe("invalid_request_error");
    // A failed turn is not a completed turn, even though a terminal event
    // arrived.
    expect(seen[0].upstreamTurnComplete).toBe(false);
  });
});

describe("stream passthrough lane (Responses upstream → Responses client)", () => {
  it("forwards the raw response.failed AND books the turn as failed", async () => {
    const input = responsesSSE(
      { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
      FAILED_EVENT,
    );
    const seen = [];
    const output = await runTransform(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSES, input, (c) => seen.push(c));
    expect(output).toContain("response.failed");
    expect(output).toContain(UPSTREAM_MESSAGE);
    expect(seen).toHaveLength(1);
    expect(seen[0].upstreamError).toBeTruthy();
    expect(seen[0].upstreamError.message).toBe(UPSTREAM_MESSAGE);
  });
});

describe("non-streaming SSE→JSON: response.failed is an HTTP error, not 200 + empty", () => {
  it("detects the error nested under response.error", () => {
    const rawSSE = [
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "partial" })}`,
      `data: ${JSON.stringify(FAILED_EVENT)}`,
      "data: [DONE]",
    ].join("\n");
    const parsed = parseSSEToOpenAIResponse(rawSSE, "gpt-6.1-sol");
    expect(parsed).toBeTruthy();
    expect(parsed.error).toBeTruthy();
    expect(parsed.error.message).toBe(UPSTREAM_MESSAGE);
    expect(parsed.error.type).toBe("invalid_request_error");
  });

  it("a failed response with no error object still surfaces as an error", () => {
    const rawSSE = `data: ${JSON.stringify({ type: "response.failed", response: { id: "resp_1", status: "failed" } })}\n`;
    const parsed = parseSSEToOpenAIResponse(rawSSE, "gpt-6.1-sol");
    expect(parsed?.error).toBeTruthy();
  });
});

describe("onStreamComplete: a failed combo leg is booked as failed, not succeeded", () => {
  function buildCompleted({ comboLegLabel = "xc/gpt-6.1-sol" } = {}) {
    const log = { line: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const onCompletedResponse = vi.fn();
    const { onStreamComplete } = buildOnStreamComplete({
      provider: "xc",
      model: "xc/gpt-6.1-sol",
      connectionId: "conn-1",
      apiKey: "test-key",
      requestStartTime: Date.now(),
      body: { model: "GPT-6.1-Sol", messages: [{ role: "user", content: "hello" }] },
      stream: true,
      finalBody: null,
      translatedBody: null,
      clientRawRequest: { endpoint: "/v1/chat/completions" },
      pxpipe: null,
      reqTag: "TEST",
      log,
      onCompletedResponse,
      comboLegLabel,
    });
    return { onStreamComplete, log, onCompletedResponse };
  }

  beforeEach(() => vi.clearAllMocks());

  it("writes an error usage row (status error, upstream message in meta) even with no tokens", () => {
    const { onStreamComplete } = buildCompleted();
    onStreamComplete(
      { content: "partial", upstreamError: { message: UPSTREAM_MESSAGE, type: "invalid_request_error", code: "unsupported_tool_calls" }, upstreamTerminalSeen: true, upstreamTurnComplete: false },
      null,
      null,
    );
    expect(usageDb.saveRequestUsage).toHaveBeenCalledTimes(1);
    const row = usageDb.saveRequestUsage.mock.calls[0][0];
    expect(row.status).toBe("error");
    expect(row.meta.upstreamError.message).toBe(UPSTREAM_MESSAGE);
    expect(row.meta.upstreamError.type).toBe("invalid_request_error");
    // A failed turn still records the model/provider it ran on.
    expect(row.model).toBe("xc/gpt-6.1-sol");
    // And the detail row carries the failure too.
    expect(usageDb.saveRequestDetail).toHaveBeenCalledTimes(1);
    const detail = usageDb.saveRequestDetail.mock.calls[0][0];
    expect(detail.status).toBe("error");
  });

  it("logs COMBO failed (warn) and never succeeded for the failed leg", () => {
    const { onStreamComplete, log, onCompletedResponse } = buildCompleted();
    onStreamComplete(
      { content: "partial", upstreamError: { message: UPSTREAM_MESSAGE }, upstreamTerminalSeen: true, upstreamTurnComplete: false },
      null,
      null,
    );
    expect(log.warn).toHaveBeenCalledWith("COMBO", expect.stringContaining("Model xc/gpt-6.1-sol failed"));
    expect(log.info).not.toHaveBeenCalledWith("COMBO", expect.stringContaining("succeeded"));
    expect(onCompletedResponse).not.toHaveBeenCalled();
  });

  it("still logs COMBO succeeded for a genuinely completed leg", async () => {
    const { onStreamComplete, log, onCompletedResponse } = buildCompleted();
    onStreamComplete(
      { content: "done", upstreamTerminalSeen: true, upstreamTurnComplete: true },
      { prompt_tokens: 10, completion_tokens: 5 },
      null,
    );
    expect(log.info).toHaveBeenCalledWith("COMBO", "Model xc/gpt-6.1-sol succeeded");
    expect(log.warn).not.toHaveBeenCalled();
    // onCompletedResponse fires via Promise.resolve().then — one tick later.
    await new Promise((r) => setTimeout(r, 0));
    expect(onCompletedResponse).toHaveBeenCalledTimes(1);
    const row = usageDb.saveRequestUsage.mock.calls[0][0];
    expect(row.status).toBe("ok");
    expect(row.meta?.upstreamError).toBeUndefined();
  });
});

describe("source guards: the three fixes stay wired", () => {
  const rootDir = resolve(__dirname, "../..");
  const comboSrc = readFileSync(resolve(rootDir, "open-sse/services/combo.js"), "utf8");
  const streamSrc = readFileSync(resolve(rootDir, "open-sse/utils/stream.js"), "utf8");
  const requestDetailSrc = readFileSync(resolve(rootDir, "open-sse/handlers/chatCore/requestDetail.js"), "utf8");

  it("combo: a streaming leg never logs succeeded at head time", () => {
    // Both succeeded logs sit behind an isStream gate; a stream logs
    // "streaming (HTTP …)" instead and the real outcome is logged from
    // onStreamComplete.
    expect(comboSrc).toContain('const isStream = (result.headers?.get?.("content-type") || "").includes("text/event-stream")');
    expect(comboSrc).toContain('if (isStream) log.info("COMBO", `Model ${modelStr} streaming (HTTP ${result.status})`)');
    const bareSucceeded = comboSrc.match(/^\s*log\.info\("COMBO", `Model \$\{modelStr\} succeeded`\);$/gm) || [];
    expect(bareSucceeded).toHaveLength(0);
  });

  it("stream layer captures the upstream error in every lane", () => {
    expect(streamSrc).toContain("let upstreamError = null;");
    expect(streamSrc).toContain("if (state?.error && !upstreamError) upstreamError = normalizeUpstreamError(state.error);");
    expect(streamSrc).toContain("parsed?.response?.error");
    expect(streamSrc).toContain("upstreamError,");
  });

  it("saveUsageStats writes a row for a failed turn with no tokens", () => {
    expect(requestDetailSrc).toContain("if (inTokens === 0 && outTokens === 0 && !isError) return;");
    expect(requestDetailSrc).toContain("status,");
    expect(requestDetailSrc).toContain("meta.upstreamError");
  });
});
