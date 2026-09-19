// A stream that stalled or lost its upstream used to be closed with no terminal
// frame at all, so clients saw "200 OK, a few chunks, then nothing" and could not
// tell a truncated reply from a finished one. The HTTP status can no longer change
// at that point, so the failure has to be reported in-band.
//
// Contract locked here:
//  - OpenAI-compatible clients get data: {"error":…} BEFORE data: [DONE]
//    (openai-python raises APIError on any `data:` payload carrying `error`,
//    checked before the sentinel).
//  - Claude clients get `event: error`.
//  - No synthetic finish_reason ever — a truncated stream must not look clean.
import { describe, expect, it } from "vitest";
import { buildStreamErrorBytes } from "../../open-sse/utils/streamHelpers.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { SSE_DONE } from "../../open-sse/utils/sseConstants.js";

const decode = (bytes) => new TextDecoder().decode(bytes);

describe("buildStreamErrorBytes — in-band terminal frame after HTTP 200", () => {
  it("frames an OpenAI-compatible error before [DONE]", () => {
    const sse = decode(buildStreamErrorBytes(504, "stream stall timeout", FORMATS.OPENAI));

    expect(sse).toContain('"error"');
    expect(sse).toContain("stream stall timeout");

    const errorAt = sse.indexOf('"error"');
    const doneAt = sse.indexOf(SSE_DONE);
    expect(errorAt).toBeGreaterThan(-1);
    expect(doneAt).toBeGreaterThan(-1);
    // The error frame must come FIRST — a [DONE]-then-error order is invisible
    // to the client, which stops reading at the sentinel.
    expect(errorAt).toBeLessThan(doneAt);
  });

  it("uses Claude's native error event for Claude clients", () => {
    const sse = decode(buildStreamErrorBytes(504, "upstream connection lost", FORMATS.CLAUDE));

    expect(sse.startsWith("event: error\n")).toBe(true);
    expect(sse).toContain("upstream connection lost");
    // Claude has its own error channel; the OpenAI sentinel must not leak in.
    expect(sse).not.toContain(SSE_DONE);
  });

  it("maps the status to OpenAI's error type vocabulary, not a bare number", () => {
    // The body follows buildErrorBody's shape: a 5xx must read as a server_error
    // so client retry/backoff logic classifies it correctly.
    const sse = decode(buildStreamErrorBytes(504, "stream stall timeout", FORMATS.OPENAI));

    expect(sse).toContain("server_error");
  });

  it("never fabricates a finish_reason", () => {
    // A synthetic finish_reason is exactly the bug: a truncated stream that the
    // client accepts as a clean stop.
    for (const format of [FORMATS.OPENAI, FORMATS.CLAUDE]) {
      const sse = decode(buildStreamErrorBytes(504, "boom", format));
      expect(sse).not.toContain("finish_reason");
    }
  });

  it("returns bytes the stream can enqueue verbatim", () => {
    const bytes = buildStreamErrorBytes(504, "boom", FORMATS.OPENAI);

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
  });
});
