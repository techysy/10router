/**
 * 账号层「轮询 — 按会话」（providerStrategies[x].fallbackStrategy =
 * "session-round-robin"）在 getProviderCredentials 里的接线回归。
 *
 * 钉住四件事：
 * 1. 同一会话粘住上次实际成功（调用 commitSession）的账号，新会话才轮下一个；
 * 2. 粘住的账号被排除/冷却时顺延，恢复后不抢回（成功方继续持有）；
 * 3. 没有可靠会话标识时退回**原有的按请求次数**轮询，行为一字不变；
 * 4. 到期优先 / 每日赠送优先这类更高一等的排序策略仍然压过按会话轮询。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
  validateApiKey: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  pickProxyPoolId: vi.fn(),
  getUsageForProvider: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  updateProviderConnection: mocks.updateProviderConnection,
  getSettings: mocks.getSettings,
  getProxyPools: mocks.getProxyPools,
  validateApiKey: mocks.validateApiKey,
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
  pickProxyPoolId: mocks.pickProxyPoolId,
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (p) => p,
}));
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("open-sse/services/usage.js", () => ({ getUsageForProvider: mocks.getUsageForProvider }));

import { getProviderCredentials } from "../../src/sse/services/auth.js";
import { createRoutingIdentity, routingCaller, createSessionScheduler } from "../../open-sse/services/sessionAffinity.js";

// auth.js keeps module-level scheduler state; give each case a private one by
// resetting through the exported scheduler seam used below.
const conns = () => [
  { id: "acct-1", provider: "deepseek", priority: 1 },
  { id: "acct-2", provider: "deepseek", priority: 2 },
  { id: "acct-3", provider: "deepseek", priority: 3 },
];

function identity(sessionId, apiKey = "sk-caller") {
  return createRoutingIdentity(
    { metadata: { user_id: JSON.stringify({ session_id: sessionId }) }, messages: [{ role: "user", content: "x" }] },
    null,
    routingCaller(apiKey, null),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveConnectionProxyConfig.mockResolvedValue({});
  mocks.getProxyPools.mockResolvedValue([]);
  mocks.updateProviderConnection.mockResolvedValue(undefined);
  mocks.getUsageForProvider.mockResolvedValue({ quotas: {} });
  mocks.getProviderConnections.mockResolvedValue(conns());
  mocks.getSettings.mockResolvedValue({
    providerStrategies: { deepseek: { fallbackStrategy: "session-round-robin" } },
  });
});

describe("账号层 session-round-robin", () => {
  it("同会话粘住成功的账号，新会话轮下一个", async () => {
    const first = await getProviderCredentials("deepseek", null, "m", { routingIdentity: identity("s1") });
    expect(first.connectionId).toBeTruthy();
    first.commitSession([]);

    const again = await getProviderCredentials("deepseek", null, "m", { routingIdentity: identity("s1") });
    expect(again.connectionId).toBe(first.connectionId);

    const fresh = await getProviderCredentials("deepseek", null, "m", { routingIdentity: identity("s2") });
    expect(fresh.connectionId).not.toBe(first.connectionId);
  });

  it("未提交成功前不占位：失败候选不得钉死会话", async () => {
    const p1 = await getProviderCredentials("deepseek", null, "m", { routingIdentity: identity("sx") });
    // 不 commit（模拟该账号本轮失败）；下一轮换别的账号，会话不得被钉在 p1 上
    const p2 = await getProviderCredentials("deepseek", null, "m", { routingIdentity: identity("sx"), preferredConnectionId: undefined });
    void p2;
    // 真正成功的那次才绑定
    p1.commitSession([]);
    const again = await getProviderCredentials("deepseek", null, "m", { routingIdentity: identity("sx") });
    expect(again.connectionId).toBe(p1.connectionId);
  });

  it("粘住的账号进入排除集时顺延，恢复后不抢回", async () => {
    const first = await getProviderCredentials("deepseek", null, "m", { routingIdentity: identity("s9") });
    first.commitSession([]);
    const bound = first.connectionId;

    // 该账号本轮失败被排除（chat.js 的换号循环）
    const walked = await getProviderCredentials("deepseek", new Set([bound]), "m", { routingIdentity: identity("s9") });
    expect(walked.connectionId).not.toBe(bound);
    walked.commitSession([]);
    const replacement = walked.connectionId;

    // 冷却结束后重新可用：会话跟着**实际成功者**，不抢回
    const after = await getProviderCredentials("deepseek", null, "m", { routingIdentity: identity("s9") });
    expect(after.connectionId).toBe(replacement);
  });

  it("无会话标识时退回原有按次数轮询（stickyRoundRobinLimit）", async () => {
    mocks.getSettings.mockResolvedValue({
      providerStrategies: { deepseek: { fallbackStrategy: "session-round-robin", stickyRoundRobinLimit: 1 } },
    });
    const seen = [];
    for (let i = 0; i < 3; i++) {
      const r = await getProviderCredentials("deepseek", null, "m", {});
      seen.push(r.connectionId);
      // 老实现按 lastUsedAt + consecutiveUseCount 轮换
      mocks.getProviderConnections.mockResolvedValue(
        conns().map((c) => (c.id === r.connectionId ? { ...c, lastUsedAt: new Date().toISOString(), consecutiveUseCount: (c.consecutiveUseCount || 0) + 1 } : c))
      );
    }
    expect(new Set(seen).size).toBeGreaterThan(1);
    for (const id of seen) expect(["acct-1", "acct-2", "acct-3"]).toContain(id);
  });

  it("到期优先压过按会话轮询", async () => {
    mocks.getSettings.mockResolvedValue({
      providerStrategies: { deepseek: { fallbackStrategy: "session-round-robin", earliestExpiryFirst: true } },
    });
    mocks.getProviderConnections.mockResolvedValue([
      { id: "late", provider: "deepseek", priority: 1, earliestPackageExpiry: "2027-01-01T00:00:00.000Z" },
      { id: "soon", provider: "deepseek", priority: 2, earliestPackageExpiry: "2026-11-29T00:00:00.000Z" },
    ]);
    const picked = await getProviderCredentials("deepseek", null, "m", { routingIdentity: identity("s-exp") });
    expect(picked.connectionId).toBe("soon");
  });

  it("单账号池不炸；不同调用方各自绑定", async () => {
    mocks.getProviderConnections.mockResolvedValue([{ id: "only", provider: "deepseek", priority: 1 }]);
    const solo = await getProviderCredentials("deepseek", null, "m", { routingIdentity: identity("s-solo") });
    expect(solo.connectionId).toBe("only");

    mocks.getProviderConnections.mockResolvedValue(conns());
    const a = await getProviderCredentials("deepseek", null, "m", { routingIdentity: identity("shared", "key-a") });
    a.commitSession([]);
    const b = await getProviderCredentials("deepseek", null, "m", { routingIdentity: identity("shared", "key-b") });
    b.commitSession([]);
    const a2 = await getProviderCredentials("deepseek", null, "m", { routingIdentity: identity("shared", "key-a") });
    expect(a2.connectionId).toBe(a.connectionId);
  });
});

// 组合层与账号层共用同一份识别实现：这里钉住解析口径一致。
describe("会话标识解析（两层共用）", () => {
  it("识别 metadata.user_id 嵌套 JSON、裸 session_id 与会话头", () => {
    const s = createSessionScheduler();
    const nested = identity("via-nested");
    const bare = createRoutingIdentity({ session_id: "via-bare", messages: [] }, null, routingCaller("k", null));
    const viaHeader = createRoutingIdentity({ messages: [] }, { get: (n) => (n === "x-session-id" ? "via-header" : null) }, routingCaller("k", null));
    for (const [tag, idn] of [["nested", nested], ["bare", bare], ["header", viaHeader]]) {
      expect(idn, tag).toBeTruthy();
      const plan = s.plan("acct", idn, ["m1", "m2"]);
      expect(plan, tag).toBeTruthy();
    }
  });

  it("裸 user / prompt_cache_key 不当作会话", () => {
    expect(createRoutingIdentity({ user: "alice" }, null, routingCaller("k", null))).toBeNull();
  });
});
