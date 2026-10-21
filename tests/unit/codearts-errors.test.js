/**
 * CodeArts error semantics:
 *   · HTTP 400 `00001041` = concurrency (short cooldown, never a 429)
 *   · HTTP 200 + `error_code` envelope must be classified before it becomes a
 *     "200 with empty content" success
 *   · `InferHub.4004.200` benefit-not-found is its own state
 *   · size walls: 6 MiB inference / 12 MiB gateway markers
 */
import { describe, expect, it, beforeEach } from "vitest";

import CodeArtsExecutor, { clampCodeArtsOutputTokens, firstCodeArtsFrame } from "../../open-sse/executors/codearts.js";
import {
  classifyCodeArtsEnvelope,
  codeArtsSizeRejection,
} from "../../open-sse/shared/codearts/client.js";
import {
  __resetSessionGate,
  acquireSessionSlot,
  CodeArtsConcurrencyError,
} from "../../open-sse/shared/codearts/gates.js";
import { CODEARTS_MAX_OUTPUT_TOKENS } from "../../open-sse/config/codearts.js";

describe("codearts 400 concurrency", () => {
  it("keeps TM.00001041 at HTTP 400 and labels it as concurrency", () => {
    const executor = new CodeArtsExecutor();
    const parsed = executor.parseError(
      { status: 400 },
      '{"error_code":"TM.00001041","error_msg":"concurrent session limit exceeded"}'
    );
    expect(parsed.status).toBe(400);
    expect(parsed.message).toContain("00001041");
    expect(parsed.message).not.toContain("429");
  });

  it("treats a 200-stream 00001041 envelope as 400 too", () => {
    const envelope = classifyCodeArtsEnvelope({
      error_code: "TM.00001041",
      error_msg: "session busy",
    });
    expect(envelope).toMatchObject({ status: 400 });
  });

  it("allows 3 local sessions per account and rejects the 4th", () => {
    __resetSessionGate();
    const permits = [0, 1, 2].map(() => acquireSessionSlot("account-a"));
    expect(() => acquireSessionSlot("account-a")).toThrow(CodeArtsConcurrencyError);
    try {
      acquireSessionSlot("account-a");
    } catch (error) {
      expect(error.statusCode).toBe(400);
      expect(error.code).toBe("00001041");
    }
    permits[0].release();
    permits[0].release(); // double release must not free a second slot
    const last = acquireSessionSlot("account-a");
    expect(last).toBeTruthy();
    permits[1].release();
    permits[2].release();
    last.release();
  });
});

describe("codearts 200 error envelope", () => {
  it("classifies insufficient quota as 403", () => {
    const envelope = classifyCodeArtsEnvelope({
      error_code: "InferHub.4291.200",
      error_msg: "insufficient quota",
    });
    expect(envelope.status).toBe(403);
  });

  it("classifies rate limiting as 429", () => {
    expect(
      classifyCodeArtsEnvelope({ error_code: "InferHub.4291.429", error_msg: "too many requests" }).status
    ).toBe(429);
  });

  it("classifies a missing maas_type as 404 model-not-registered", () => {
    const envelope = classifyCodeArtsEnvelope({
      error_code: "InferHub.002002009.404",
      error_msg: "The model is not registered, please request other model",
    });
    expect(envelope.status).toBe(404);
    expect(envelope.message).toContain("002002009");
  });

  it("keeps benefit-not-found (4004.200) on its own branch", () => {
    const envelope = classifyCodeArtsEnvelope({
      error_code: "InferHub.4004.200",
      error_msg: "benefit not found",
    });
    expect(envelope.status).toBe(502);
    expect(envelope.code).toBe("InferHub.4004.200");
  });

  it("does not classify a frame that already carries content (partial answer wins)", () => {
    expect(
      classifyCodeArtsEnvelope({
        error_code: "InferHub.4291.200",
        choices: [{ delta: { content: "partial" } }],
      })
    ).toBeNull();
  });

  it("parses the error frame out of an SSE head, ignoring [DONE]", () => {
    expect(
      firstCodeArtsFrame('data: [DONE]\n\n')
    ).toBeNull();
    expect(
      firstCodeArtsFrame('data: {"error_code":"InferHub.4291.200","error_msg":"insufficient quota"}\n\n')
    ).toEqual({ error_code: "InferHub.4291.200", error_msg: "insufficient quota" });
  });
});

describe("codearts size and output walls", () => {
  it("recognises the two measured size markers", () => {
    // Inference wall: same code as generic bad-params, only counts above 6 MiB.
    expect(
      codeArtsSizeRejection(502, '{"error_code":"InferHub.001001005.400","details":[{"error_code":"PARSE_REQUEST_DATA_EXCEPTION"}]}', 7 * 1024 * 1024)
    ).toBe(true);
    expect(
      codeArtsSizeRejection(400, '{"error_code":"InferHub.001001005.400"}', 1000)
    ).toBe(false);
    // Gateway wall: APIG.0201 is overloaded for many statuses, wording decides.
    expect(codeArtsSizeRejection(413, '{"error_code":"APIG.0201","error_msg":"Request entity too large"}', 0)).toBe(true);
    expect(codeArtsSizeRejection(413, '{"error_code":"APIG.0201","error_msg":"too many headers"}', 0)).toBe(false);
  });

  it("clamps only values above 65536 and only the key the client used", () => {
    const payload = { max_tokens: 100000, max_completion_tokens: 65536 };
    clampCodeArtsOutputTokens(payload);
    expect(payload.max_tokens).toBe(CODEARTS_MAX_OUTPUT_TOKENS);
    expect(payload.max_completion_tokens).toBe(65536);
    const untouched = { max_tokens: "128000" };
    clampCodeArtsOutputTokens(untouched);
    expect(untouched.max_tokens).toBe("128000");
  });
});

describe("codearts gate hygiene", () => {
  beforeEach(() => __resetSessionGate());

  it("scopes slots per account key", () => {
    const a = [0, 1, 2].map(() => acquireSessionSlot("a"));
    const b = acquireSessionSlot("b");
    a.forEach((permit) => permit.release());
    b.release();
  });
});
