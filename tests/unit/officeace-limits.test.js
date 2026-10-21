/**
 * OfficeAce limits:
 *   • 81113 arrives WITH HTTP 429 and must become 413 request-too-large
 *     (never retried, never cooled down);
 *   • the `messages` count wall is exactly 5000 and is rejected locally;
 *   • per-family output ceilings.
 * No network: the local wall returns before BaseExecutor.execute() is reached.
 */
import { describe, expect, it } from "vitest";

import { OfficeAceExecutor, officeaceMessageLimitViolation } from "../../open-sse/executors/officeace.js";
import { officeaceOutputLimitFor } from "../../open-sse/config/officeace.js";

const TOO_LARGE_BODY = JSON.stringify({
  error_code: "ModelArts.81113",
  error_msg: "Invalid request body, exceeds the maximum size , messages max size is: 5000.",
});

const executor = new OfficeAceExecutor();

const messages = (n) =>
  Array.from({ length: n }, (_, i) => ({ role: "user", content: `m${i}` }));

describe("81113 with HTTP 429", () => {
  it("is reclassified as 413, not left as a rate limit", () => {
    const parsed = executor.parseError({ status: 429 }, TOO_LARGE_BODY);
    expect(parsed.status).toBe(413);
    expect(parsed.message).toContain("5000");
    expect(parsed.message).not.toMatch(/rate limit|too many requests/i);
  });

  it("covers the APIG/MaaS wording variants", () => {
    expect(executor.parseError({ status: 429 }, '{"error":"request body is too large"}').status).toBe(413);
    expect(executor.parseError({ status: 400 }, '{"msg":"RequestEntityTooLarge"}').status).toBe(413);
  });

  it("leaves a plain 429 (81111 rate limit) alone", () => {
    const plain = JSON.stringify({ error_code: "ModelArts.81111", error_msg: "rate limit exceeded" });
    expect(executor.parseError({ status: 429 }, plain).status).toBe(429);
  });

  it("never retries a 413", () => {
    expect(executor.shouldRetry(413, 0)).toBe(false);
  });
});

describe("messages hard wall", () => {
  it("flags exactly 5000 and anything above", () => {
    expect(officeaceMessageLimitViolation({ messages: messages(4999) })).toBe("");
    expect(officeaceMessageLimitViolation({ messages: messages(5000) })).toContain("5000");
    expect(officeaceMessageLimitViolation({ messages: messages(5001) })).toContain("5001");
    // No messages array at all is not a violation.
    expect(officeaceMessageLimitViolation({})).toBe("");
  });

  it("is rejected locally with 413 before any upstream call", async () => {
    const result = await executor.execute({
      model: "glm-5.3",
      body: { model: "glm-5.3", messages: messages(5000), stream: true },
      stream: true,
      credentials: { apiKey: "app-key:app-secret" },
      log: null,
    });
    expect(result.response.status).toBe(413);
    const text = await result.response.text();
    expect(text).toContain("5000");
  });
});

describe("output ceilings per family", () => {
  it("maps the three measured families and leaves others unclamped", () => {
    expect(officeaceOutputLimitFor("glm-5.3")).toEqual({ maxOutputTokens: 131072, combined: false });
    expect(officeaceOutputLimitFor("glm-5.1")).toEqual({ maxOutputTokens: 131072, combined: false });
    expect(officeaceOutputLimitFor("deepseek-v4.1-flash")).toEqual({ maxOutputTokens: 393216, combined: false });
    expect(officeaceOutputLimitFor("qwen3-max")).toEqual({ maxOutputTokens: 65536, combined: true });
    // A different model of the same vendor must not borrow the ceiling.
    expect(officeaceOutputLimitFor("deepseek-v4-flash-0731")).toBeNull();
    expect(officeaceOutputLimitFor("kimi-k2.6")).toBeNull();
    expect(officeaceOutputLimitFor("")).toBeNull();
  });

  it("clamps max_tokens after the reasoning allowance, and keeps tiny asks", () => {
    const glm = executor.transformRequest("glm-5.3", { max_tokens: 200000, messages: [] }, true);
    expect(glm.max_tokens).toBe(131072);
    // 64 + 1024 allowance (append, not max)
    expect(executor.transformRequest("glm-5.3", { max_tokens: 64 }, true).max_tokens).toBe(1088);
    // < 16 is an intentional minimal ask — untouched
    expect(executor.transformRequest("glm-5.3", { max_tokens: 1 }, true).max_tokens).toBe(1);
    // qwen3 combines input+output, so the ceiling is still the conservative cap
    expect(executor.transformRequest("qwen3-max", { max_tokens: 70000 }, true).max_tokens).toBe(65536);
    // unknown family: only the allowance applies
    expect(executor.transformRequest("kimi-k2.6", { max_tokens: 64 }, true).max_tokens).toBe(1088);
  });

  it("forces streaming and the usage frame", () => {
    const body = executor.transformRequest("glm-5.3", { stream: false }, false);
    expect(body.stream).toBe(true);
    expect(body.stream_options.include_usage).toBe(true);
    // An explicit false is not overridden.
    const explicit = executor.transformRequest("glm-5.3", { stream_options: { include_usage: false } }, true);
    expect(explicit.stream_options.include_usage).toBe(false);
  });
});

describe("gateway URL and auth", () => {
  it("is reachable through the executor map", async () => {
    const { getExecutor, hasSpecializedExecutor } = await import("../../open-sse/executors/index.js");
    expect(hasSpecializedExecutor("officeace")).toBe(true);
    expect(getExecutor("officeace").constructor.name).toBe("OfficeAceExecutor");
  });

  it("normalises the per-account gateway base to /v2/chat/completions", () => {
    const credentials = { providerSpecificData: { baseUrl: "https://modelgw-0007.example.com/" } };
    expect(executor.buildUrl("glm-5.3", true, 0, credentials)).toBe(
      "https://modelgw-0007.example.com/v2/chat/completions"
    );
    const alreadyV2 = { providerSpecificData: { baseUrl: "https://h/v2" } };
    expect(executor.buildUrl("glm-5.3", true, 0, alreadyV2)).toBe("https://h/v2/chat/completions");
  });

  it("builds Basic from key:secret and adds the correlation headers", () => {
    const headers = executor.buildHeaders({ apiKey: "app-key:app-secret" }, true);
    expect(headers.Authorization).toBe("Basic YXBwLWtleTphcHAtc2VjcmV0");
    expect(headers.lang).toBe("en");
    expect(headers["Chat-Id"]).toMatch(/^[0-9a-f]{32}$/);
    expect(headers["Session-Id"]).toMatch(/^[0-9a-f]{32}$/);
    // Secrets are never echoed into header values.
    expect(JSON.stringify(headers)).not.toContain("app-secret");
  });
});
