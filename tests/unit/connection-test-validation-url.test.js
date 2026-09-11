import { describe, it, expect } from "vitest";
import { buildCloudCodeProbeError } from "../../src/app/api/providers/[id]/test/testUtils.js";
import { extractAccountsVerificationUrl } from "../../src/shared/utils/validationUrl.js";

// Shaped after the real cloudcode-pa.googleapis.com VALIDATION_REQUIRED body.
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

describe("buildCloudCodeProbeError (connection test path)", () => {
  it("surfaces the validation URL for a VALIDATION_REQUIRED body", () => {
    const msg = buildCloudCodeProbeError(VALIDATION_BODY, 403);
    expect(msg).toContain("VALIDATION_REQUIRED");
    expect(msg).toContain("https://accounts.google.com/signin/continue?sarp=1&scc=1");
    expect(msg).not.toContain('"@type"');
  });

  it("falls back to the parsed provider message for ordinary errors", () => {
    const body = JSON.stringify({ error: { message: "API key not valid" } });
    expect(buildCloudCodeProbeError(body, 400)).toBe("API key not valid");
  });

  it("falls back to the status line when the body is unreadable", () => {
    expect(buildCloudCodeProbeError("", 503)).toBe("API returned 503");
  });
});

describe("extractAccountsVerificationUrl", () => {
  it("extracts the URL from the friendly chat error message", () => {
    const msg = "Google requires account verification (VALIDATION_REQUIRED). "
      + 'Open this URL in a browser signed in to the affected account, complete "Verify your account", then retry: '
      + "https://accounts.google.com/signin/continue?sarp=1&scc=1&continue=https://developers.google.com/x&plt=T";
    expect(extractAccountsVerificationUrl(msg))
      .toBe("https://accounts.google.com/signin/continue?sarp=1&scc=1&continue=https://developers.google.com/x&plt=T");
  });

  it("extracts from a quoted JSON context and stops at the quote", () => {
    expect(extractAccountsVerificationUrl('{"validation_url":"https://accounts.google.com/signin/continue?plt=A"}'))
      .toBe("https://accounts.google.com/signin/continue?plt=A");
  });

  it("ignores non-verification Google URLs and non-strings", () => {
    expect(extractAccountsVerificationUrl("see https://myaccount.google.com/security")).toBeNull();
    expect(extractAccountsVerificationUrl(null)).toBeNull();
    expect(extractAccountsVerificationUrl(123)).toBeNull();
  });
});
