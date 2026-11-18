// #147 — Google 真/伪 429 判别与渠道暂停分级。
// 真配额 429 带归因信号（Retry-After 头 / RetryInfo / QuotaFailure / 配额类
// ErrorInfo reason / 重置时钟文本）→ 正常轮换；裸 429 = WAF 身份识别类 →
// 禁止轮换 + 渠道级暂停（google429 档：首犯 5min、升级窗内再犯 30min）。
import { describe, it, expect } from "vitest";

import { isUnattributedGoogle429 } from "../../open-sse/services/googleQuotaSignal.js";
import { buildChannelBlock, channelBlockRemainingMs } from "../../open-sse/services/accountFallback.js";
import { CHANNEL_BLOCK_MS } from "../../open-sse/config/errorConfig.js";

// 生产实锤的真配额 429 载荷（antigravity-quota-error-i18n 同源样本）。
const REAL_QUOTA_429 = JSON.stringify({
  error: {
    code: 429,
    message: "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h27m36s.",
    status: "RESOURCE_EXHAUSTED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "QUOTA_EXHAUSTED",
        domain: "cloudcode-pa.googleapis.com",
        metadata: { quotaResetDelay: "1h27m36.139434956s", quotaResetTimeStamp: "2026-09-15T12:52:06Z" },
      },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "5256.139434956s" },
    ],
  },
});

describe("isUnattributedGoogle429 (#147)", () => {
  it("real quota 429 (ErrorInfo+RetryInfo+reset clock) is attributed", () => {
    expect(isUnattributedGoogle429(429, null, REAL_QUOTA_429)).toBe(false);
  });

  it("Retry-After header alone attributes the 429", () => {
    expect(isUnattributedGoogle429(429, "120", '{"error":{"message":"Too Many Requests"}}')).toBe(false);
  });

  it("bare 429 with a generic body is unattributed (WAF fingerprint class)", () => {
    expect(isUnattributedGoogle429(429, null, '{"error":{"code":429,"message":"Too Many Requests","status":"RATE_LIMITED"}}')).toBe(true);
  });

  it("empty body 429 is unattributed", () => {
    expect(isUnattributedGoogle429(429, null, "")).toBe(true);
    expect(isUnattributedGoogle429(429, null, undefined)).toBe(true);
  });

  it("RetryInfo / QuotaFailure details attribute even without a clock", () => {
    expect(
      isUnattributedGoogle429(429, null, JSON.stringify({ error: { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo" }] } })),
    ).toBe(false);
    expect(
      isUnattributedGoogle429(429, null, JSON.stringify({ error: { details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [] }] } })),
    ).toBe(false);
  });

  it("quota-class ErrorInfo.reason attributes; a bare ErrorInfo does not", () => {
    expect(
      isUnattributedGoogle429(429, null, JSON.stringify({ error: { details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "RATE_LIMIT_EXCEEDED" }] } })),
    ).toBe(false);
    // 身份/风控类 reason 不是配额信号 → 仍判伪
    expect(
      isUnattributedGoogle429(429, null, JSON.stringify({ error: { details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "PERMISSION_DENIED" }] } })),
    ).toBe(true);
  });

  it("non-429 statuses are never unattributed-429", () => {
    expect(isUnattributedGoogle429(403, null, "")).toBe(false);
    expect(isUnattributedGoogle429(500, null, "")).toBe(false);
  });

  it("non-JSON text bodies fall back to the signal regex", () => {
    expect(isUnattributedGoogle429(429, null, "upstream quota will reset at midnight")).toBe(false);
    expect(isUnattributedGoogle429(429, null, "Too Many Requests")).toBe(true);
  });
});

describe("google429 channel-block tiers (#147)", () => {
  const NOW = Date.parse("2026-11-18T12:00:00Z");

  it("first offence pauses 5min, repeat inside the escalate window pauses 30min", () => {
    const durations = { short: CHANNEL_BLOCK_MS.google429, long: CHANNEL_BLOCK_MS.google429Long };
    const first = buildChannelBlock(null, NOW, durations);
    expect(first.durationMs).toBe(5 * 60 * 1000);
    expect(first.escalated).toBe(false);

    const second = buildChannelBlock(first, NOW + 60 * 1000, durations);
    expect(second.durationMs).toBe(30 * 60 * 1000);
    expect(second.escalated).toBe(true);
  });

  it("legacy two-arg call keeps the CodeBuddy default tiers", () => {
    const first = buildChannelBlock(null, NOW);
    expect(first.durationMs).toBe(CHANNEL_BLOCK_MS.short);
    expect(first.escalated).toBe(false);
  });

  it("tier values are ordered and configured", () => {
    expect(CHANNEL_BLOCK_MS.google429).toBe(5 * 60 * 1000);
    expect(CHANNEL_BLOCK_MS.google429Long).toBe(30 * 60 * 1000);
    expect(CHANNEL_BLOCK_MS.google429).toBeGreaterThan(CHANNEL_BLOCK_MS.short);
  });

  it("remaining window honors the longer google429 block", () => {
    const block = buildChannelBlock(null, NOW, { short: CHANNEL_BLOCK_MS.google429, long: CHANNEL_BLOCK_MS.google429Long });
    expect(channelBlockRemainingMs(block, NOW + 60 * 1000)).toBe(4 * 60 * 1000);
  });
});

describe("executor parseError threading (#147)", () => {
  const fakeResponse = (status, body, headers = {}) => ({
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    clone: () => ({ text: async () => body }),
    text: async () => body,
  });

  it("AntigravityExecutor.parseError flags a bare 429 and keeps real quota payloads unflagged", async () => {
    const { AntigravityExecutor } = await import("../../open-sse/executors/antigravity.js");
    const { PROVIDERS } = await import("../../open-sse/config/providers.js");
    const exec = new AntigravityExecutor();
    void PROVIDERS;

    const flagged = exec.parseError(fakeResponse(429, '{"error":{"message":"Too Many Requests"}}'), '{"error":{"message":"Too Many Requests"}}');
    expect(flagged.unattributed429).toBe(true);

    const real = exec.parseError(fakeResponse(429, REAL_QUOTA_429), REAL_QUOTA_429);
    expect(real.unattributed429).toBeUndefined();
    expect(real.resetsAtMs).toBeTruthy();
  });

  it("GeminiCLIExecutor.parseError flags a bare 429, keeps RetryInfo hint unflagged", async () => {
    const { GeminiCLIExecutor } = await import("../../open-sse/executors/gemini-cli.js");
    const exec = new GeminiCLIExecutor();

    const flagged = exec.parseError(fakeResponse(429, '{"error":{"message":"rate limited"}}'), '{"error":{"message":"rate limited"}}');
    expect(flagged.unattributed429).toBe(true);

    const real = exec.parseError(fakeResponse(429, REAL_QUOTA_429), REAL_QUOTA_429);
    expect(real.unattributed429).toBeUndefined();
    expect(real.retryAfter).toBe("5256.139434956s");
  });

  it("parseUpstreamError threads the flag through to the chat layer", async () => {
    const { parseUpstreamError } = await import("../../open-sse/utils/error.js");
    const exec = { parseError: () => ({ status: 429, message: "Too Many Requests", unattributed429: true }) };
    const parsed = await parseUpstreamError(fakeResponse(429, "Too Many Requests"), exec, "https://example.invalid/v1internal:generateContent");
    expect(parsed.unattributed429).toBe(true);
  });
});
