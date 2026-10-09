import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";

/**
 * The inverse of issue #48. There, a fully delivered answer was booked as an
 * error; here, a stream that the upstream cut mid-answer is booked as a clean
 * success.
 *
 * flush() has to manufacture `data: [DONE]` for any passthrough stream that
 * ended without one (OpenClaw hangs until timeout otherwise), and it then calls
 * finishStream() → onStreamComplete → request-detail row `status: "success"`
 * with ESTIMATED usage. That is exactly the signature of an upstream proxy
 * dropping the connection with a clean FIN: the client sees a complete-looking
 * truncated answer and the dashboard says everything worked. The stall watchdog
 * only fires on byte gaps, never on an early clean EOF, so flush() is the only
 * place that can tell.
 */
function drain(stream) {
  const reader = stream.getReader();
  return (async () => {
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
    return out;
  })();
}

function feed(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
}

async function runPassthrough(chunks, provider = "openai") {
  const completions = [];
  const ts = createPassthroughStreamWithLogger(
    provider,
    null,
    "m",
    "c1",
    { messages: [] },
    (content, usage, ttft) => completions.push({ content, usage, ttft })
  );
  const out = await drain(feed(chunks).pipeThrough(ts));
  return { out, completions };
}

describe("a truncated stream is not recorded as a clean success", () => {
  it("flags a passthrough stream that ended without upstream [DONE]", async () => {
    // Content arrives, then the connection simply ends. No sentinel, no
    // finish_reason — the shape of an early clean FIN.
    const { out, completions } = await runPassthrough([
      'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
    ]);

    // The client still gets its terminator, or it hangs (see the comment in
    // stream.js — OpenClaw does exactly this).
    expect(out).toContain("data: [DONE]");
    expect(completions).toHaveLength(1);
    expect(completions[0].content.incomplete).toBe(true);
  });

  it("does NOT flag a stream the upstream terminated properly", async () => {
    const { out, completions } = await runPassthrough([
      'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);

    // The sentinel was forwarded from upstream, not manufactured by us, so
    // finishStream() ran from the [DONE] branch with the flag unset.
    expect(completions).toHaveLength(1);
    expect(completions[0].content.incomplete).toBeFalsy();
    expect(out).toContain("data: [DONE]");
  });

  it("does not flag Gemini-family passthrough, which has no [DONE] dialect", async () => {
    // `streamDoneSent` is never set for these providers, so treating its
    // absence as truncation would mark every healthy stream as one.
    const { completions } = await runPassthrough(
      ['data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}\n\n'],
      "gemini"
    );
    expect(completions).toHaveLength(1);
    expect(completions[0].content.incomplete).toBeFalsy();
  });

  it("still reports the partial content it did accumulate", async () => {
    // Truncation is information, not a reason to throw away the answer.
    const { completions } = await runPassthrough([
      'data: {"choices":[{"delta":{"content":"partial answer"}}]}\n\n',
    ]);
    expect(completions[0].content.content).toContain("partial answer");
  });
});

describe("the request-detail row agrees (source guards)", () => {
  // The status is chosen in another module and only observable at its call
  // site — see tests/unit/stream-complete-on-done-sentinel.test.js:27 for the
  // repo's convention when a behavior spans modules.
  const rootDir = resolve(__dirname, "../..");
  const read = (p) => readFileSync(resolve(rootDir, p), "utf8").replace(/\r\n/g, "\n");
  const streamingHandler = read("open-sse/handlers/chatCore/streamingHandler.js");
  const stream = read("open-sse/utils/stream.js");

  it("books a truncated stream as truncated, not success", () => {
    expect(streamingHandler).toMatch(/status:\s*contentObj\?\.incomplete\s*\?\s*"truncated"\s*:\s*"success"/);
  });

  it("tells onStreamComplete whether the terminator was manufactured", () => {
    expect(stream).toMatch(/incomplete:\s*endedWithoutTerminal/);
  });

  it("finalizes even when flush() throws, instead of leaving the row at streaming", () => {
    // A thrown flush() used to be logged and dropped, so the row stayed at
    // status "streaming" forever (or was later rewritten as an error even
    // though bytes had been delivered).
    const catchIdx = stream.indexOf('console.log("Error in flush:"');
    expect(catchIdx, "the flush catch not found").toBeGreaterThan(-1);
    const tail = stream.slice(catchIdx - 400, catchIdx);
    expect(tail, "the flush catch must still finalize the stream").toContain("finishStream();");
  });
});
