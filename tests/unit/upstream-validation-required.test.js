import { describe, expect, it } from "vitest";
import { parseUpstreamError, buildAccountValidationMessage } from "../../open-sse/utils/error.js";

function errorResponse(body, status = 403) {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

// Shaped after the real Antigravity/Gemini Code Assist VALIDATION_REQUIRED body
// (cloudcode-pa.googleapis.com), with the validation_url Google expects the user
// to open in a browser.
const VALIDATION_BODY = JSON.stringify({
  error: {
    code: 403,
    message: "Verify your account to continue.",
    status: "PERMISSION_DENIED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "VALIDATION_REQUIRED",
        domain: "cloudcode-pa.googleapis.com",
        metadata: {
          validation_error_message: "Verify your account to continue.",
          validation_url: "https://accounts.google.com/signin/continue?sarp=1&scc=1&continue=https://developers.google.com/gemini-code-assist/auth/auth_success_gemini&plt=AKgnsb&flowName=GlifWebSignIn",
        },
      },
    ],
  },
});

describe("parseUpstreamError — Google VALIDATION_REQUIRED", () => {
  it("surfaces the validation URL instead of the raw JSON wall", async () => {
    const { statusCode, message } = await parseUpstreamError(errorResponse(VALIDATION_BODY));

    expect(statusCode).toBe(403);
    expect(message).toContain("VALIDATION_REQUIRED");
    expect(message).toContain("Verify your account");
    expect(message).toContain("https://accounts.google.com/signin/continue?sarp=1&scc=1&continue=https://developers.google.com/gemini-code-assist/auth/auth_success_gemini&plt=AKgnsb&flowName=GlifWebSignIn");
    // the actionable URL must not stay buried in the raw body dump
    expect(message).not.toContain('"validation_url"');
    expect(message).not.toContain('"@type"');
  });

  it("decodes JSON-escaped characters in the URL", async () => {
    // Raw JSON text with an escaped solidus — what a strict JSON encoder emits.
    const body = '{"error":{"details":[{"reason":"VALIDATION_REQUIRED","metadata":'
      + '{"validation_url":"https://accounts.google.com/a?x=1\\/y=2"}}]}}';
    const { message } = await parseUpstreamError(errorResponse(body));
    expect(message).toContain("https://accounts.google.com/a?x=1/y=2");
  });

  it("also overrides a custom executor parser that would pass the raw body through", async () => {
    const executor = { parseError: (response, bodyText) => ({ status: response.status, message: bodyText }) };
    const { message } = await parseUpstreamError(errorResponse(VALIDATION_BODY), executor);

    expect(message).toContain("https://accounts.google.com/signin/continue");
    expect(message).not.toContain('"@type"');
  });

  it("keeps the executor's own message when the body carries no validation challenge", async () => {
    const executor = { parseError: () => ({ status: 429, message: "quota exhausted", resetsAtMs: 123 }) };
    const result = await parseUpstreamError(errorResponse('{"error":{"message":"x"}}', 429), executor);

    expect(result.message).toBe("quota exhausted");
    expect(result.resetsAtMs).toBe(123);
  });

  it("falls back to normal parsing when the reason appears without a validation URL", async () => {
    const body = JSON.stringify({ error: { message: "Verify your account to continue.", details: [{ reason: "VALIDATION_REQUIRED" }] } });
    const { message } = await parseUpstreamError(errorResponse(body));

    expect(message).toBe("Verify your account to continue.");
  });

  it("is a no-op for unrelated error bodies", async () => {
    const body = JSON.stringify({ error: { message: "boom" } });
    const { message } = await parseUpstreamError(errorResponse(body));

    expect(message).toBe("boom");
  });
});

describe("buildAccountValidationMessage", () => {
  it("returns null for empty or marker-free input", () => {
    expect(buildAccountValidationMessage("")).toBeNull();
    expect(buildAccountValidationMessage(null)).toBeNull();
    expect(buildAccountValidationMessage('{"error":{"message":"denied"}}')).toBeNull();
  });

  it("tolerates a URL the JSON encoder mangled", () => {
    expect(buildAccountValidationMessage('{"details":[{"reason":"VALIDATION_REQUIRED"}],"validation_url":"not\\\\"valid"}'))
      .toContain("not");
  });
});
