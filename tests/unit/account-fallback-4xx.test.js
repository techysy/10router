// Regression: an unmatched 4xx is a REQUEST-scoped failure (context overflow,
// malformed body, unsupported parameter) — it says nothing about the credential.
// Cooling the account down for it removes a healthy connection from rotation, and
// with a single connection every later request in the window is answered with a
// copy of that first error ("all 1 accounts locked for <model> | lastError=[400]"),
// which hides the real cause and makes unrelated sessions look like they hit the
// same limit.
//
// Account-scoped statuses keep their rules (401/402/403/404/429), and the text
// rules still win when the body carries rate-limit / quota / capacity wording.
import { describe, expect, it } from "vitest";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

describe("checkFallbackError — request-scoped vs account-scoped failures", () => {
  it("does not cool the account down for a 400 caused by the request", () => {
    const result = checkFallbackError(400, JSON.stringify({
      error: {
        message: "This model's maximum context length is 1048576 tokens. However, you requested 1186139 tokens",
        type: "invalid_request_error",
      },
    }));

    expect(result.shouldFallback).toBe(false);
    expect(result.cooldownMs).toBe(0);
  });

  it("does not cool down for other request-scoped 4xx either", () => {
    for (const status of [400, 405, 406, 409, 413, 415, 422]) {
      expect(checkFallbackError(status, "invalid request body").shouldFallback).toBe(false);
    }
  });

  it("still falls back for account-scoped statuses", () => {
    for (const status of [401, 402, 403, 429]) {
      expect(checkFallbackError(status, "nope").shouldFallback).toBe(true);
    }
  });

  it("still honours rate-limit / quota wording on any 4xx", () => {
    // Text rules must win over the request-scoped short-circuit.
    expect(checkFallbackError(400, "rate limit reached").shouldFallback).toBe(true);
    expect(checkFallbackError(422, "quota exceeded").shouldFallback).toBe(true);
  });

  it("keeps the transient cooldown for unmatched server errors", () => {
    const result = checkFallbackError(503, "upstream exploded");

    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBeGreaterThan(0);
  });

  it("always returns the channelScope field callers rely on", () => {
    expect(checkFallbackError(400, "invalid request")).toHaveProperty("channelScope", false);
  });
});
