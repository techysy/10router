import { describe, expect, it } from "vitest";
import { KiroExecutor } from "../../open-sse/executors/kiro.js";

const RUNTIME = "https://runtime.us-east-1.kiro.dev/generateAssistantResponse";
const CODEWHISPERER = "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse";
const Q = "https://q.us-east-1.amazonaws.com/generateAssistantResponse";

function credentials(authMethod, region = "us-east-1") {
  return { providerSpecificData: { authMethod, region } };
}

describe("Kiro auth-aware endpoint routing", () => {
  const executor = new KiroExecutor();

  it("routes API-key inference through Amazon Q before other surfaces", () => {
    expect(executor.getOrderedBaseUrls(credentials("api_key"))).toEqual([
      Q,
      CODEWHISPERER,
      RUNTIME,
    ]);
  });

  // Kiro retired the path-style GenerateAssistantResponse on runtime.*.kiro.dev: it
  // answers a valid modern payload with 400 REQUEST_BODY_INVALID, and a 400 is terminal
  // here, so kiro.dev must never be tried first for any auth method. Foreign tokens are
  // rejected by the Amazon surfaces with 401/403, which do fall through.
  it("routes Builder ID OAuth through Amazon Q first (kiro.dev path deprecated)", () => {
    expect(executor.getOrderedBaseUrls(credentials("builder-id"))).toEqual([
      Q,
      CODEWHISPERER,
      RUNTIME,
    ]);
  });

  it("routes external IdP through Amazon Q first", () => {
    expect(executor.getOrderedBaseUrls(credentials("external_idp"))).toEqual([
      Q,
      CODEWHISPERER,
      RUNTIME,
    ]);
  });

  it("regionalizes the Amazon endpoints for IDC while keeping Q first", () => {
    expect(executor.getOrderedBaseUrls(credentials("idc", "eu-west-1"))).toEqual([
      "https://q.eu-west-1.amazonaws.com/generateAssistantResponse",
      "https://codewhisperer.eu-west-1.amazonaws.com/generateAssistantResponse",
      RUNTIME,
    ]);
  });

  it("retries only endpoint/auth-surface failures, not payload-invalid 400s", () => {
    expect(executor.shouldRetry(400, 0)).toBe(false);
    expect(executor.shouldRetry(401, 1)).toBe(true);
    expect(executor.shouldRetry(403, 2)).toBe(false);
    expect(executor.shouldRetry(422, 0)).toBe(false);
  });

  it("builds endpoint-specific headers", () => {
    const auth = { accessToken: "test-key", providerSpecificData: { authMethod: "api_key" } };
    const qHeaders = executor.buildHeaders(auth, true, Q);
    const codeWhispererHeaders = executor.buildHeaders(auth, true, CODEWHISPERER);
    const runtimeHeaders = executor.buildHeaders(auth, true, RUNTIME);

    expect(qHeaders.TokenType).toBe("API_KEY");
    expect(qHeaders["X-Amz-Target"]).toBeUndefined();
    expect(codeWhispererHeaders["X-Amz-Target"]).toBe(
      "AmazonCodeWhispererStreamingService.GenerateAssistantResponse"
    );
    expect(runtimeHeaders["X-Amz-Target"]).toBeUndefined();
  });

  // Current-runtime markers the Amazon surfaces require: without them the deprecated
  // path gateway answers a modern payload with REQUEST_BODY_INVALID.
  it("sends the current-runtime headers on every surface", () => {
    const auth = {
      accessToken: "sso-token",
      providerSpecificData: {
        authMethod: "idc",
        profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/ABC",
      },
    };

    const headers = executor.buildHeaders(auth, true, Q);

    expect(headers["x-amz-sso-bearer"]).toBe("sso-token");
    expect(headers["x-amzn-kiro-agent-mode"]).toBe("spec");
    expect(headers["x-amzn-codewhisperer-machine-id"]).toBe("kiro-desktop");
    expect(headers["x-amzn-codewhisperer-profile-arn"]).toBe(
      "arn:aws:codewhisperer:us-east-1:1:profile/ABC"
    );
  });

  it("omits the profile-arn header when the connection has no profile", () => {
    const auth = { accessToken: "sso-token", providerSpecificData: { authMethod: "api_key" } };

    const headers = executor.buildHeaders(auth, true, Q);

    expect(headers).not.toHaveProperty("x-amzn-codewhisperer-profile-arn");
    expect(headers["x-amz-sso-bearer"]).toBe("sso-token");
    expect(headers["x-amzn-kiro-agent-mode"]).toBe("spec");
  });
});
