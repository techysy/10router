// Issue #48, the one that survived the first fix: a stream that delivered its
// WHOLE answer was still recorded as `error` with 0/0 tokens.
//
// Mechanism (reproduced live against the NAS instance, 2026-10-08):
//   1. Upstream sends `data: [DONE]` — the OpenAI/client dialect terminator.
//   2. The client (OpenAI SDK, Hermes, any card sidecar) closes the connection
//      the instant it reads the sentinel.
//   3. That close lands on createDisconnectAwareStream's cancel() →
//      streamController.handleDisconnect() → the wrapped hook in
//      streamingHandler.js → recordAbort() → status:"error", "[Streaming
//      aborted]", tokens 0/0.
//   4. The transform stream's flush() — the ONLY place that used to call
//      onStreamComplete, i.e. the only writer of the success row — never runs:
//      a TransformStream's flush() does not fire when the downstream reader is
//      cancelled. Verified with a standalone Node simulation.
// So a fully-delivered, usage-bearing response was logged as a failure. This is
// what made the CodeBuddy lines in the dashboard read as 0-token errors while
// Hermes showed a complete answer for the same request.
//
// Fix, in three places that must agree:
//   A. stream.js finalizes on the [DONE] sentinel itself (once-guarded
//      finishStream()), because [DONE] is the whole point of no return.
//   B. streamHandler.js cancel() distinguishes "upstream [DONE] seen" from a
//      real mid-flight abort, so a post-sentinel client close is a completion.
//   C. streamingHandler.js latches the row (finalized) so whichever writer
//      arrives first owns it and a later abort cannot overwrite a real answer.
//
// Source-text guards: the behavior is split across three modules and only
// observable at their call sites (see tests/unit/disabled-models-ux.test.js:9
// for the repo's convention on this).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const rootDir = resolve(__dirname, "../..");
// These files are committed with CRLF; normalise so the guards read the same
// regardless of the checkout's line endings.
const read = (p) => readFileSync(resolve(rootDir, p), "utf8").replace(/\r\n/g, "\n");
const stream = read("open-sse/utils/stream.js");
const streamHandler = read("open-sse/utils/streamHandler.js");
const streamingHandler = read("open-sse/handlers/chatCore/streamingHandler.js");

describe("a completed stream is recorded as success even if the client hangs up right after [DONE] (#48)", () => {
  it("A. finalizes on the [DONE] sentinel instead of waiting for flush()", () => {
    // The [DONE] branch must call finishStream() AFTER it has emitted the
    // Responses-framing terminal bytes, so the row it writes describes the wire
    // that was actually sent.
    const doneBranch = /if \(parsed && parsed\.done && targetFormat !== FORMATS\.OLLAMA\) \{([\s\S]*?)\n        \}/.exec(stream);
    expect(doneBranch, "the [DONE] sentinel branch not found in stream.js").toBeTruthy();
    expect(doneBranch[1], "[DONE] branch must finalize the stream itself").toContain("finishStream();");
    // ...and must do it last in the branch, after the Responses terminal bytes.
    const body = doneBranch[1];
    expect(body.lastIndexOf("finishStream();")).toBeGreaterThan(body.lastIndexOf("openAIResponsesDoneSent = true;"));
  });

  it("A. finishStream is once-guarded, so [DONE] + flush() cannot double-write", () => {
    const fn = /const finishStream = \(\) => \{([\s\S]*?)\n  \};/.exec(stream);
    expect(fn, "finishStream not found").toBeTruthy();
    expect(fn[1]).toMatch(/if \(streamCompleted\) return;/);
    expect(fn[1]).toMatch(/streamCompleted = true;/);
    // Both remaining call sites (passthrough flush, translate flush) go through it,
    // and the raw onStreamComplete call must no longer appear in flush().
    expect((stream.match(/finishStream\(\);/g) || []).length).toBeGreaterThanOrEqual(4);
    const flushBody = stream.slice(stream.indexOf("flush(controller)"));
    expect(flushBody).not.toMatch(/onStreamComplete\(\{/);
  });

  it("A. finishStream reports success with the usage the stream actually received", () => {
    const fn = /const finishStream = \(\) => \{([\s\S]*?)\n  \};/.exec(stream);
    // Translate mode keeps usage on state (and the trailing usage chunk has
    // already merged into it); passthrough keeps it in the local variable.
    expect(fn[1]).toMatch(/mode === STREAM_MODE\.PASSTHROUGH \? usage : state\?\.usage/);
    expect(fn[1]).toMatch(/onStreamComplete\(\{/);
    // Upstream identity comes from the provider, never from state.provider
    // (that field can hold a translator's intermediate format name).
    expect(fn[1]).toMatch(/logUsage\(provider \|\| targetFormat/);
  });

  it("B. cancel() only treats a pre-[DONE] cancel as a disconnect", () => {
    // The [DONE] seen on the wire is what separates "client done reading" from
    // "upstream died mid-answer".
    expect(streamHandler).toMatch(/let sawUpstreamDone = false;/);
    expect(streamHandler).toMatch(/if \(value && \/\\\[DONE\\\]\/\.test\(/);
    const cancel = /cancel\(reason\) \{([\s\S]*?)\n    \}\n  \}\);/.exec(streamHandler);
    expect(cancel, "cancel() not found").toBeTruthy();
    expect(cancel[1]).toMatch(/if \(!sawUpstreamDone\) \{\s*\n\s*streamController\.handleDisconnect\(/);
    expect(cancel[1], "a post-[DONE] cancel must complete, not abort").toMatch(/else \{[\s\S]*streamController\.handleComplete\(\);/);
    // A real client cancel mid-flight still has to reach handleDisconnect, or the
    // "streaming" placeholder row would never be finalized.
    expect(cancel[1].indexOf("handleDisconnect(")).toBeLessThan(cancel[1].indexOf("handleComplete();"));
  });

  it("C. the detail row is latched: a later abort cannot overwrite a completed answer", () => {
    expect(streamingHandler).toMatch(/finalizedRef = \{ current: false \}/);
    // Abort paths bail out once the row is owned...
    const recordAbort = /const recordAbort = \(message\) => \{([\s\S]*?)\n  \};/.exec(streamingHandler);
    expect(recordAbort, "recordAbort not found").toBeTruthy();
    expect(recordAbort[1]).toMatch(/if \(finalizedRef\.current\) return message;/);
    // ...the success write claims it first and bails out if an abort already did...
    const complete = /const onStreamComplete = \(contentObj, usage, ttftAt\) => \{([\s\S]*?)\n    const latency/.exec(streamingHandler);
    expect(complete, "onStreamComplete not found").toBeTruthy();
    expect(complete[1]).toMatch(/if \(finalizedRef\.current\) return;/);
    expect(complete[1]).toMatch(/finalizedRef\.current = true;/);
    // ...and both terminal-frame builders mark it finalized before writing.
    expect(streamingHandler).toMatch(/finalizedRef\.current = true; return buildAbortedResponsesTerminalBytes/);
    expect(streamingHandler).toMatch(/finalizedRef\.current = true; return buildStreamErrorBytes/);
    // The wrapped disconnect hook must respect the latch.
    expect(streamingHandler).toMatch(/handleDisconnect: \(r\) => \{\s*\n\s*if \(!finalizedRef\.current\) recordAbort\(/);
  });
});
