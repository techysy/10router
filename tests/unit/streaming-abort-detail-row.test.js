// Issue #48 follow-up: a streaming request's placeholder detail row was written
// with status "success" BEFORE the stream produced anything. If the upstream
// then died mid-flight, the abort path went through streamController.handleError
// — which never touches the DB — so the row was never corrected and the Details
// tab kept a green, 0-in / 0-out "completed" request forever.
//
// UsageStats.js decides its dot with `!r.status || r.status === "ok" ||
// r.status === "success"`, so a stuck placeholder rendered GREEN: an aborted
// call looked like a free one. Marking the placeholder "streaming" makes the
// in-flight row honest, and wrapping the terminal-frame builder lets the abort
// path rewrite the same row (upsert is on `id`) as an error.
//
// These are source-text guards: streamingHandler.js is a plain .js module but
// the behavior under test is its wiring order and terminal-frame delegation,
// which is only observable at the call site (and the repo has no rendering
// test infra — see tests/unit/disabled-models-ux.test.js:9).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const rootDir = resolve(__dirname, "../..");
const src = readFileSync(resolve(rootDir, "open-sse/handlers/chatCore/streamingHandler.js"), "utf8");

describe("an in-flight streaming request is not recorded as a success (#48)", () => {
  it("marks the placeholder row 'streaming', not 'success'", () => {
    // The placeholder write is the one carrying the in-progress content marker.
    const placeholder = /response: \{ content: "\[Streaming in progress\.\.\.\]"[\s\S]*?status: "(\w+)"/.exec(src);
    expect(placeholder, "streaming placeholder row not found").toBeTruthy();
    expect(placeholder[1]).toBe("streaming");
  });

  it("still records a completed stream as success", () => {
    // The terminal write (onStreamComplete) is the one that may claim success —
    // this is the counterpart assertion, so the fix cannot be over-applied.
    // A stream whose terminator flush() had to MANUFACTURE (upstream cut the
    // connection mid-answer with a clean FIN) is booked `truncated` instead of
    // success, because it would otherwise land as success with estimated
    // usage. A stream the upstream terminated properly keeps `success`.
    const completed = /status:\s*contentObj\?\.incomplete\s*\?\s*"(\w+)"\s*:\s*"(\w+)"/.exec(src);
    expect(completed, "onStreamComplete status not found").toBeTruthy();
    expect(completed[1]).toBe("truncated");
    expect(completed[2]).toBe("success");
  });
});

describe("an aborted stream updates its row instead of leaving a stub (#48)", () => {
  it("records the abort against the same detail id as the placeholder", () => {
    // Upsert is ON CONFLICT(id) (requestDetailsRepo.js:122), so both writes
    // must carry the same id or the abort would append a second row.
    const ids = src.match(/\{ id: streamDetailId \}/g) || [];
    expect(ids.length).toBeGreaterThanOrEqual(2);
  });

  it("writes the aborted row as an error, with content saying so", () => {
    const abort = /providerResponse: "\[Streaming aborted before completion\]"[\s\S]*?status: "(\w+)"/.exec(src);
    expect(abort, "abort record not found").toBeTruthy();
    expect(abort[1]).toBe("error");
  });

  it("hooks the abort through the terminal-frame builder", () => {
    // pipeWithDisconnect is what invokes the terminal builder on disconnect /
    // stall, so wrapping it is what makes the row get updated. Both passthrough
    // shapes must be covered, or Responses-API clients keep the stale row.
    expect(src).toContain("buildAbortedResponsesTerminalBytes(recordAbort(message))");
    expect(src).toContain("buildStreamErrorBytes(HTTP_STATUS.GATEWAY_TIMEOUT, friendlyAbort(recordAbort(message)), sourceFormat)");
  });

  it("writes the placeholder BEFORE building the pipe", () => {
    // Ordering is load-bearing: the abort handler needs the row to exist.
    const placeholderAt = src.indexOf("[Streaming in progress...]");
    const pipeAt = src.indexOf("pipeWithDisconnect(providerResponse");
    expect(placeholderAt).toBeGreaterThan(-1);
    expect(pipeAt).toBeGreaterThan(-1);
    expect(placeholderAt, "placeholder must be written before the pipe is built")
      .toBeLessThan(pipeAt);
  });

  it("leaves the client-facing terminal bytes untouched", () => {
    // recordAbort returns the message unchanged, so the wire bytes are exactly
    // what they were before — this only adds a DB write.
    const fn = /const recordAbort = \(message\) => \{[\s\S]*?\n  \};/.exec(src);
    expect(fn, "recordAbort not found").toBeTruthy();
    expect(fn[0]).toMatch(/return message;/);
  });

  it("reaches the cancel path too, not just the terminal builder", () => {
    // Code-review finding on the first cut of this fix: the terminal builder
    // only fires from pull(), but a CLIENT cancel calls handleDisconnect and no
    // further pull() runs — so the row stayed "streaming" forever. Both
    // termination hooks of the controller must be wrapped.
    expect(src).toContain("handleError: (e) => {");
    expect(src).toMatch(/handleError: \(e\) => \{[\s\S]*?recordAbort\(e\?\.message/);
    expect(src).toMatch(/handleDisconnect: \(r\) => \{[\s\S]*?recordAbort\(/);
    expect(src).toContain("pipeWithDisconnect(providerResponse, transformStream, abortAwareController");
  });

  it("writes the abort row at most once per request", () => {
    // On an upstream error both the wrapped handleError hook AND the terminal
    // builder fire; the second write would race the first for the same row.
    const fn = /const recordAbort = \(message\) => \{[\s\S]*?\n  \};/.exec(src);
    expect(fn[0]).toMatch(/if \(abortRecorded\) return message;/);
    expect(fn[0]).toMatch(/abortRecorded = true;/);
  });
});
