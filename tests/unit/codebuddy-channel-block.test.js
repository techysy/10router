/**
 * Channel-scope failures: CodeBuddy 11128 "Illegal API invocation from an
 * unapproved channel".
 *
 * Measured on the production 4-account CodeBuddy pool: the upstream answers 11128
 * for ALL FOUR accounts with the same model inside one second (323–654ms), while a
 * direct single request carrying the identical shape returns 200. The block is
 * therefore a property of the CHANNEL (egress fingerprint / request burst), not of
 * any account — so the correct response is to pause the whole provider instead of
 * walking the account list (that walk is the burst the policy reacts to).
 *
 * Acceptance:
 * 1. the error text classifies as channelScope with a real (non-zero) cooldown;
 * 2. a channel block is NOT a per-account model lock — accounts stay untouched;
 * 3. repeat offences inside the escalation window go short → long;
 * 4. unrelated errors are unaffected (no accidental channelScope, no regression
 *    on the existing 401/402/403/404/429 rules).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { checkFallbackError, buildChannelBlock, channelBlockRemainingMs, isModelLockActive, buildModelLockUpdate, withChannelScopeHint, CHANNEL_SCOPE_HINT } from "../../open-sse/services/accountFallback.js";
import { ERROR_RULES, CHANNEL_BLOCK_MS, CHANNEL_BLOCK_ESCALATE_WINDOW_MS } from "../../open-sse/config/errorConfig.js";

// markAccountUnavailable touches the DB + proxy/registry lookups; stub them so the
// channel-scope branch can be exercised without a live store.
const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/lib/network/connectionProxy", () => ({
  pickProxyPoolId: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getProviderConnections.mockResolvedValue([
    { id: "cb-1", provider: "codebuddy-cn", name: "余师洋", backoffLevel: 0 },
  ]);
  dbMocks.updateProviderConnection.mockResolvedValue(undefined);
});


// The exact shape the upstream returns (and that markAccountUnavailable stores as lastError).
const REAL_11128 =
  '[400]: {"code":11128,"msg":"Illegal API invocation from an unapproved channel",' +
  '"requestId":"912c7db9-2126-46cd-bd4b-67b7edff184a","displayMsg":{"en":"The request was blocked ' +
  'by security policy. Please retry later or contact support.","zh":"请求被安全策略拦截，请稍后重试或联系支持。"}}';

describe("CodeBuddy 11128 unapproved channel — channel-scope classification", () => {
  it("classifies the real 11128 payload as channelScope with a non-zero cooldown", () => {
    const res = checkFallbackError(400, REAL_11128);
    expect(res.shouldFallback).toBe(true);
    expect(res.channelScope).toBe(true);
    expect(res.cooldownMs).toBe(CHANNEL_BLOCK_MS.short);
    expect(res.cooldownMs).toBeGreaterThan(0);
  });

  it("matches on the msg alone (no 11128 code present in the text)", () => {
    const res = checkFallbackError(400, "Illegal API invocation from an unapproved channel");
    expect(res.channelScope).toBe(true);
  });

  it("is case-insensitive, like the other text rules", () => {
    expect(checkFallbackError(400, "UNAPPROVED CHANNEL").channelScope).toBe(true);
  });

  it("does NOT flag unrelated CodeBuddy errors (11133 param rejection stays account-scoped)", () => {
    const res = checkFallbackError(
      400,
      '{"code":11133,"msg":"the request parameters were rejected by the model provider"}',
    );
    expect(res.channelScope).toBe(false);
  });

  it("does NOT flag the quota / rate-limit family", () => {
    for (const [status, text] of [
      [429, '{"code":6004,"msg":"您的使用量已超出频率限制"}'],
      [429, "rate limit exceeded"],
      [402, "insufficient balance"],
    ]) {
      expect(checkFallbackError(status, text).channelScope, `${status} ${text}`).toBe(false);
    }
  });

  it("keeps the pre-existing rules intact (no regression)", () => {
    expect(checkFallbackError(401, "unauthorized").cooldownMs).toBe(2 * 60 * 1000);
    expect(checkFallbackError(402, "payment required").cooldownMs).toBe(2 * 60 * 1000);
    expect(checkFallbackError(403, "forbidden").cooldownMs).toBe(2 * 60 * 1000);
    expect(checkFallbackError(404, "not found").cooldownMs).toBe(2 * 60 * 1000);
    expect(checkFallbackError(429, "slow down").backoff).toBeUndefined(); // backoff path, not fixed
    expect(checkFallbackError(502, "some other gateway error").channelScope).toBe(false);
    expect(checkFallbackError(502, "some other gateway error").cooldownMs).toBeGreaterThan(0);
  });

  it("only the 11128 rules carry the channelScope flag (config stays declarative)", () => {
    // The intl gate (2026-10-15: X-Conversation-* headers mandatory, 11128
    // "conversation id missing" / "request illegal") is the same channel-level
    // shape — every connection of the provider answers identically — so its
    // texts join the declarative list, scoped to codebuddy-intl via rule.provider.
    const scoped = ERROR_RULES.filter((r) => r.channelScope === true).map((r) => r.text);
    expect(scoped).toEqual(["unapproved channel", "illegal api invocation", "conversation id missing", "request illegal"]);
  });
});

describe("channel block bookkeeping", () => {
  const NOW = Date.UTC(2026, 8, 16, 12, 0, 0);

  it("first offence uses the short duration", () => {
    const block = buildChannelBlock(null, NOW);
    expect(block.durationMs).toBe(CHANNEL_BLOCK_MS.short);
    expect(block.escalated).toBe(false);
    expect(block.strikes).toBe(1);
    expect(channelBlockRemainingMs(block, NOW)).toBe(CHANNEL_BLOCK_MS.short);
  });

  it("repeat offence inside the window escalates to the long duration", () => {
    const first = buildChannelBlock(null, NOW);
    const second = buildChannelBlock(first, NOW + 1000);
    expect(second.escalated).toBe(true);
    expect(second.durationMs).toBe(CHANNEL_BLOCK_MS.long);
    expect(second.strikes).toBe(2);
  });

  it("an offence after the window falls back to the short duration", () => {
    const first = buildChannelBlock(null, NOW);
    const later = buildChannelBlock(first, NOW + CHANNEL_BLOCK_ESCALATE_WINDOW_MS + 1);
    expect(later.escalated).toBe(false);
    expect(later.durationMs).toBe(CHANNEL_BLOCK_MS.short);
    // strikes keep accumulating (observability), it's the duration that resets
    expect(later.strikes).toBe(2);
  });

  it("remaining time decays to 0 once expired", () => {
    const block = buildChannelBlock(null, NOW);
    expect(channelBlockRemainingMs(block, NOW + CHANNEL_BLOCK_MS.short + 1)).toBe(0);
    expect(channelBlockRemainingMs(null, NOW)).toBe(0);
    expect(channelBlockRemainingMs({}, NOW)).toBe(0);
    expect(channelBlockRemainingMs({ until: "not-a-date" }, NOW)).toBe(0);
  });

  it("a channel block does NOT create any per-account model lock", () => {
    // The whole point: markAccountUnavailable short-circuits before buildModelLockUpdate,
    // so accounts must remain lockable-free. Simulate both sides.
    const block = buildChannelBlock(null, NOW);
    expect(block.durationMs).toBeGreaterThan(0);
    // A connection untouched by a channel block still reports no active lock.
    const connection = { id: "conn-1", name: "余师洋" };
    expect(isModelLockActive(connection, "glm-5.3-flash")).toBe(false);
    // And for contrast, a real account-scoped lock WOULD show up:
    const locked = { id: "conn-2", ...buildModelLockUpdate("glm-5.3-flash", 30_000) };
    expect(isModelLockActive(locked, "glm-5.3-flash")).toBe(true);
  });
});

// ─── markAccountUnavailable branch (real call path, DB mocked) ────────────────
describe("markAccountUnavailable on 11128 — no account lock, channelScope reported", () => {
  it("leaves every sibling free to serve other models", async () => {
    const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");

    const res = await markAccountUnavailable("cb-1", 400, REAL_11128, "codebuddy-cn", "glm-5.3-flash");

    expect(res.shouldFallback).toBe(true);
    expect(res.channelScope).toBe(true);

    // The connection record keeps explaining WHY, but carries no modelLock_*:
    const writes = dbMocks.updateProviderConnection.mock.calls.at(-1);
    expect(writes[0]).toBe("cb-1");
    expect(writes[1]).toMatchObject({ errorCode: 400 });
    expect(writes[1].lastError).toContain("unapproved channel");
    expect(Object.keys(writes[1]).some((k) => k.startsWith("modelLock_"))).toBe(false);
    expect(writes[1]).not.toHaveProperty("testStatus", "unavailable");
  });

  it("still locks normally for account-scoped errors (guard against over-reach)", async () => {
    dbMocks.getProviderConnections.mockResolvedValue([
      { id: "cb-1", provider: "codebuddy-cn", name: "余师洋", backoffLevel: 0 },
    ]);
    const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");

    const res = await markAccountUnavailable(
      "cb-1",
      429,
      '{"code":6004,"msg":"您的使用量已超出频率限制"}',
      "codebuddy-cn",
      "glm-5.3-flash",
    );

    expect(res.channelScope).toBe(false);
    const writes = dbMocks.updateProviderConnection.mock.calls.at(-1);
    // Per-model lock (a model was passed) → the account-level flag is
    // deliberately NOT written, since siblings keep serving (#46). The lock
    // itself and the error detail still are.
    expect(Object.keys(writes[1]).some((k) => k.startsWith("modelLock_"))).toBe(true);
    expect(writes[1]).not.toHaveProperty("testStatus");
    expect(writes[1].lastError).toBeTruthy();
    expect(writes[1].errorCode).toBe(429);
  });
});

// ─── quota-refresh interaction ────────────────────────────────────────────────
describe("channel block vs. earliest-expiry quota refresh", () => {
  it("invalidateQuotaCache marks every connection of the provider stale", async () => {
    const { invalidateQuotaCache } = await import("../../src/sse/services/auth.js");
    dbMocks.getProviderConnections.mockResolvedValue([
      { id: "cb-1", provider: "codebuddy-cn" },
      { id: "cb-2", provider: "codebuddy-cn" },
      { id: "cb-3", provider: "codebuddy-cn" },
    ]);

    await invalidateQuotaCache("codebuddy-cn");

    // One write per connection, each clearing the freshness marker:
    const writes = dbMocks.updateProviderConnection.mock.calls;
    expect(writes.map((c) => c[0])).toEqual(["cb-1", "cb-2", "cb-3"]);
    for (const [, patch] of writes) expect(patch).toEqual({ quotaCheckedAt: null });
  });

  it("never throws when the store fails (a successful request must not break on cache invalidation)", async () => {
    const { invalidateQuotaCache } = await import("../../src/sse/services/auth.js");
    dbMocks.getProviderConnections.mockRejectedValue(new Error("db down"));

    await expect(invalidateQuotaCache("codebuddy-cn")).resolves.toBeUndefined();
  });

  it("a fresh block reports remaining time, so the refresh can be skipped", () => {
    // The refresh guard is `channelBlockRemainingMs(settings.channelBlocks[provider]) > 0`.
    const block = buildChannelBlock(null, Date.now());
    expect(channelBlockRemainingMs(block)).toBeGreaterThan(0);

    // ...and an expired one does not, so refresh resumes on its own.
    const stale = { until: new Date(Date.now() - 1000).toISOString(), lastAt: "", strikes: 1 };
    expect(channelBlockRemainingMs(stale)).toBe(0);
  });
});

// ─── friendly hint on channel-block responses ─────────────────────────────────
describe("withChannelScopeHint — clients must be told WHAT TO DO, not just 'Bad Request'", () => {
  it("appends the hint after the original message", () => {
    const msg = withChannelScopeHint("[codebuddy-cn/glm-5.3-flash] upstream text");
    expect(msg.startsWith("[codebuddy-cn/glm-5.3-flash] upstream text\n\n")).toBe(true);
    expect(msg).toContain(CHANNEL_SCOPE_HINT);
  });

  it("hint explains the cause, offers actionable remedies, and warns about cross-channel model mismatch", () => {
    // Cause — channel-level, explicitly not the account's fault:
    expect(CHANNEL_SCOPE_HINT).toContain("渠道级安全风控");
    expect(CHANNEL_SCOPE_HINT).toContain("非账号问题");
    // Remedies — at least the compact path and a new-session path:
    expect(CHANNEL_SCOPE_HINT).toContain("压缩会话");
    expect(CHANNEL_SCOPE_HINT).toContain("新对话");
    // Cross-channel advice must carry the 11102 caveat: cbcn-only models
    // (glm-5.3-flash, deepseek-v4-pro) do not exist on cbai, so a blind
    // "switch channel" suggestion would produce a model-not-found error.
    expect(CHANNEL_SCOPE_HINT).toContain("11102");
  });
});
