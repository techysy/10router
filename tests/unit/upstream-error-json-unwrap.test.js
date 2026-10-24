import { describe, expect, it } from "vitest";
import { parseUpstreamError, unwrapJsonErrorMessage } from "../../open-sse/utils/error.js";

function errorResponse(body, status = 503) {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

// Live shape from Oxion 2026-10-24: the whole service 503s during an upgrade
// and every probe surfaces the raw JSON wall in the dashboard.
const OXION_UPGRADE_BODY = JSON.stringify({
  error: {
    code: "service_upgrading",
    message: "Our service is being upgraded right now and will be back to normal within a few minutes. Please retry shortly — your plan and balance are not affected.",
    param: null,
    type: "server_error",
  },
});

// CodeBuddy-style business code: ERROR_RULES matches text rules ("11133",
// "unapproved channel") against the message substring, so the numeric code
// must survive the unwrap.
const CODEBUDDY_11133_BODY = JSON.stringify({
  code: 11133,
  msg: "模型无法处理此请求",
  displayTips: { zh: "请更换模型后重试" },
});

// base parseError (the executor every plain OpenAI-compatible provider uses)
const BASE_EXECUTOR = {
  parseError(response, bodyText) {
    return { status: response.status, message: bodyText || `HTTP ${response.status}` };
  },
};

describe("unwrapJsonErrorMessage", () => {
  it("unwraps error.message from a JSON wall (Oxion service_upgrading)", () => {
    expect(unwrapJsonErrorMessage(OXION_UPGRADE_BODY)).toBe(
      "Our service is being upgraded right now and will be back to normal within a few minutes. Please retry shortly — your plan and balance are not affected."
    );
  });

  it("keeps numeric business codes as a prefix when the message lacks them", () => {
    expect(unwrapJsonErrorMessage(CODEBUDDY_11133_BODY)).toBe("[11133] 模型无法处理此请求");
  });

  it("does not duplicate the code when the message already carries it", () => {
    expect(unwrapJsonErrorMessage(JSON.stringify({ code: 6004, msg: "frequency limit 6004 reached" }))).toBe(
      "frequency limit 6004 reached"
    );
  });

  it("does not prefix non-numeric string codes (service_upgrading)", () => {
    const body = JSON.stringify({ error: { code: "service_upgrading", message: "back soon" } });
    expect(unwrapJsonErrorMessage(body)).toBe("back soon");
  });

  it("falls back to top-level message / msg / string error shapes", () => {
    expect(unwrapJsonErrorMessage(JSON.stringify({ message: "plain" }))).toBe("plain");
    expect(unwrapJsonErrorMessage(JSON.stringify({ msg: "tencent" }))).toBe("tencent");
    expect(unwrapJsonErrorMessage(JSON.stringify({ error: "string error" }))).toBe("string error");
  });

  it("returns null for non-JSON, JSON without a message, and empty input", () => {
    expect(unwrapJsonErrorMessage("upstream exploded")).toBe(null);
    expect(unwrapJsonErrorMessage('{"error":{"code":"opaque"}}')).toBe(null);
    expect(unwrapJsonErrorMessage('{"error":{"message":{"nested":"object"}}}')).toBe(null);
    expect(unwrapJsonErrorMessage("")).toBe(null);
    expect(unwrapJsonErrorMessage(null)).toBe(null);
    expect(unwrapJsonErrorMessage("{not json}")).toBe(null);
  });
});

describe("parseUpstreamError — executor JSON wall unwrap", () => {
  it("surfaces the human message instead of the raw body (base parseError)", async () => {
    const { statusCode, message } = await parseUpstreamError(errorResponse(OXION_UPGRADE_BODY), BASE_EXECUTOR);
    expect(statusCode).toBe(503);
    expect(message).toBe(
      "Our service is being upgraded right now and will be back to normal within a few minutes. Please retry shortly — your plan and balance are not affected."
    );
    expect(message.trim().startsWith("{")).toBe(false);
  });

  it("keeps the numeric code visible for rule matching", async () => {
    const { message } = await parseUpstreamError(errorResponse(CODEBUDDY_11133_BODY, 400), BASE_EXECUTOR);
    expect(message).toBe("[11133] 模型无法处理此请求");
  });

  it("keeps the raw body when it is not unwrappable JSON", async () => {
    const raw = "upstream exploded (html page)";
    const { message } = await parseUpstreamError(errorResponse(raw), BASE_EXECUTOR);
    expect(message).toBe(raw);
  });

  it("still prefers VALIDATION_REQUIRED handling over the executor message", async () => {
    const { statusCode, message } = await parseUpstreamError(errorResponse(VALIDATION_SHAPE(), 403), BASE_EXECUTOR);
    expect(statusCode).toBe(403);
    expect(message).toContain("VALIDATION_REQUIRED");
    expect(message).toContain("https://accounts.google.com/signin/continue");
  });

  it("no-executor path is unchanged: error.message extracted as before", async () => {
    const { message } = await parseUpstreamError(errorResponse(OXION_UPGRADE_BODY));
    expect(message).toBe(
      "Our service is being upgraded right now and will be back to normal within a few minutes. Please retry shortly — your plan and balance are not affected."
    );
  });
});

function VALIDATION_SHAPE() {
  return JSON.stringify({
    error: {
      code: 403,
      message: "Verify your account to continue.",
      status: "PERMISSION_DENIED",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: "VALIDATION_REQUIRED",
          metadata: { validation_url: "https://accounts.google.com/signin/continue?example=1" },
        },
      ],
    },
  });
}
