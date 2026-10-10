// StepFun CN Step Plan 免费套餐的实名（real-name）闸门此前被当成「额度用完 / 故障」
// 处理，两头都错：
//   (a) 冷却——403 落到通用 `{ status: 403, cooldownMs: COOLDOWN.long }`，把模型锁 2
//       分钟并给客户端回一个 "(reset after 2m)"。实名是**配置状态**，等多久都不会自己
//       好，这个等待时间纯属误导（而 combo 也因此白等一轮才穿透）。
//   (b) 文案——上游原文是英文 JSON，只说 "please complete face verification at …"，
//       10Router 原样透传，用户看不出该做什么，且 403 的 OpenAI 兼容 type 叫
//       `insufficient_quota`，actively 把人往「去充值」的方向带。
// 本测试同时钉住这两件事，以及「不误伤」：普通 403 与普通消息必须原样不动。
import { describe, it, expect } from "vitest";
import { checkFallbackError, isRealnameGateText, withRealnameHint } from "../../open-sse/services/accountFallback.js";
import { formatProviderError } from "../../open-sse/utils/error.js";
import { extractAccountsVerificationUrl, extractRealnameVerificationUrl } from "../../src/shared/utils/validationUrl.js";

// Verbatim shape from the upstream 403 (2026-10-10, stepfun-plan-cn / step-5-preview).
const REALNAME_403 =
  '[stepfun-plan-cn/step-5-preview] [403]: {"error":{"message":"real-name verification is required for your free step plan before calling this API. please complete face verification at https://account.stepfun.com/security?action=realname","type":"invalid_request_error"}}';
const REALNAME_URL = "https://account.stepfun.com/security?action=realname";

describe("isRealnameGateText", () => {
  it("recognizes the upstream real-name gate shapes", () => {
    expect(isRealnameGateText(REALNAME_403)).toBe(true);
    expect(isRealnameGateText("real-name verification is required")).toBe(true);
    expect(isRealnameGateText("please complete face verification at <url>")).toBe(true);
    expect(isRealnameGateText("请先完成实名认证")).toBe(true);
    // The bare URL must be enough on its own — the message around it has varied.
    expect(isRealnameGateText(REALNAME_URL)).toBe(true);
  });

  it("does not match ordinary 403s or unrelated text", () => {
    expect(isRealnameGateText("You exceeded your current quota")).toBe(false);
    expect(isRealnameGateText("subscription_quota_exhausted")).toBe(false);
    expect(isRealnameGateText("")).toBe(false);
    expect(isRealnameGateText(null)).toBe(false);
  });
});

describe("checkFallbackError treats the real-name gate as a configuration state", () => {
  it("uses zero cooldown, so the account is never locked and combo falls through at once", () => {
    const res = checkFallbackError(403, REALNAME_403, 0, "stepfun-plan-cn");
    expect(res.shouldFallback).toBe(true);
    // Without the rule this was COOLDOWN.long = 120000ms and the client got told
    // to wait — for something no amount of waiting resolves.
    expect(res.cooldownMs).toBe(0);
    expect(res.channelScope).toBe(false);
  });

  it("leaves an ordinary 403 on the long cooldown", () => {
    const res = checkFallbackError(403, "[403]: something else entirely", 0, "stepfun-plan-cn");
    expect(res.shouldFallback).toBe(true);
    expect(res.cooldownMs).toBe(120000);
  });

  it("does not report the gate as channel-scoped (sibling accounts are equally blocked, but the block is per-account state)", () => {
    expect(checkFallbackError(403, REALNAME_403, 0, "stepfun-plan-cn").channelScope).toBe(false);
  });
});

describe("withRealnameHint", () => {
  it("appends an actionable Chinese hint naming both exits", () => {
    const out = withRealnameHint(REALNAME_403, "stepfun-plan-cn");
    expect(out.startsWith(REALNAME_403)).toBe(true);
    expect(out).toContain("\n\n提示：");
    // Exit 1: go complete verification.
    expect(out).toContain(REALNAME_URL);
    // Exit 2: use the pay-as-you-go sibling channel instead.
    expect(out).toContain("stepfun-cn");
    // The point users get wrong: this is NOT a quota problem.
    expect(out).toContain("本机额度");
  });

  it("falls back to a provider-agnostic hint for an unmapped provider", () => {
    const out = withRealnameHint(REALNAME_403, "some-other-provider");
    expect(out).toContain("\n\n提示：");
    expect(out).toContain("实名认证");
    // Must not claim StepFun-specific exits for someone else's gate.
    expect(out).not.toContain("stepfun-cn");
  });

  it("passes non-real-name messages through byte-for-byte", () => {
    expect(withRealnameHint("[403]: quota", "stepfun-plan-cn")).toBe("[403]: quota");
    expect(withRealnameHint(undefined)).toBe(undefined);
    expect(withRealnameHint("")).toBe("");
  });
});

describe("formatProviderError wires the hint into every core's client-facing string", () => {
  it("appends the hint for the real-name gate", () => {
    const out = formatProviderError(
      new Error('{"error":{"message":"real-name verification is required for your free step plan before calling this API. please complete face verification at ' + REALNAME_URL + '"}}'),
      "stepfun-plan-cn",
      "step-5-preview",
      403,
    );
    expect(out).toContain("[403]: ");
    expect(out).toContain("提示：");
    expect(out).toContain(REALNAME_URL);
  });

  it("leaves ordinary errors untouched (no trailing hint)", () => {
    expect(formatProviderError(new Error("plain failure"), "openai", "gpt-6", 500))
      .toBe("[500]: plain failure");
  });

  it("keeps the low-level cause suffix intact", () => {
    const err = new Error("fetch failed");
    err.cause = { code: "UND_ERR_SOCKET" };
    expect(formatProviderError(err, "openai", "gpt-6", 502))
      .toBe("[502]: fetch failed (cause: UND_ERR_SOCKET)");
  });
});

describe("extractRealnameVerificationUrl", () => {
  it("pulls the face-verification URL out of the gate message", () => {
    expect(extractRealnameVerificationUrl(REALNAME_403)).toBe(REALNAME_URL);
  });

  it("stops at the closing quote in a JSON body", () => {
    expect(extractRealnameVerificationUrl('{"verification_url":"' + REALNAME_URL + '"}')).toBe(REALNAME_URL);
  });

  it("does not hand back a Google age-gate URL, and vice versa", () => {
    const google = "https://accounts.google.com/signin/continue?sarp=1&plt=T";
    expect(extractRealnameVerificationUrl(google)).toBeNull();
    expect(extractAccountsVerificationUrl(REALNAME_URL)).toBeNull();
  });

  it("ignores non-strings", () => {
    expect(extractRealnameVerificationUrl(null)).toBeNull();
    expect(extractRealnameVerificationUrl(123)).toBeNull();
  });
});
