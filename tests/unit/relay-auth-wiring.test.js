/**
 * Relay wiring inside getProviderCredentials — the integration seam where the
 * "配额包到期优先" toggle (now: 到期优先调度) selects a single-point carrier on
 * the earliest-expiry ring instead of re-picking the head every request.
 *
 * Acceptance:
 * 1. toggle ON + multi-account → the relay carrier wins even when an earlier
 *    account has refilled (no cut-back), and its `lastUsedAt` is persisted;
 * 2. the ring handed to the selector is ordered by earliest expiry (the
 *    existing sort stays as the ring order);
 * 3. toggle OFF → the old fill-first path is untouched (no relay call, no
 *    carrier stamp written);
 * 4. pinned connection still short-circuits the strategy.
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
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));
vi.mock("open-sse/services/usage.js", () => ({ getUsageForProvider: mocks.getUsageForProvider }));

import { getProviderCredentials } from "../../src/sse/services/auth.js";

const inDays = (d) => new Date(Date.now() + d * 86400000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveConnectionProxyConfig.mockResolvedValue({});
  mocks.getProxyPools.mockResolvedValue([]);
  mocks.updateProviderConnection.mockResolvedValue(undefined);
  mocks.getUsageForProvider.mockResolvedValue({ quotas: {} });
});

describe("getProviderCredentials — relay carrier under 到期优先调度", () => {
  it("keeps the healthy carrier instead of re-picking the earliest-expiry head", async () => {
    // Ring by expiry: a (2d) before b (30d). b is the current carrier (recent
    // lastUsedAt) and healthy at 60% — relay must NOT cut back to a.
    const conns = [
      { id: "a", provider: "antigravity", priority: 1, earliestPackageExpiry: inDays(2), shortWindowRemaining: 90 },
      { id: "b", provider: "antigravity", priority: 2, earliestPackageExpiry: inDays(30), shortWindowRemaining: 60, lastUsedAt: new Date().toISOString() },
    ];
    mocks.getProviderConnections.mockResolvedValue(conns);
    mocks.getSettings.mockResolvedValue({
      fallbackStrategy: "fill-first",
      providerStrategies: { antigravity: { earliestExpiryFirst: true } },
    });

    const res = await getProviderCredentials("antigravity");
    expect(res.connectionId).toBe("b");
    // carrier stamp persisted so the next request sees b as the carrier
    const stamp = mocks.updateProviderConnection.mock.calls.find(([id, patch]) => id === "b" && patch.lastUsedAt);
    expect(stamp).toBeTruthy();
  });

  it("steps FORWARD around the ring when the carrier crosses the red zone", async () => {
    // Ring: a (2d, healthy 80%) → b (30d, carrier at 3% = red). Forward from b
    // wraps to a. The old head-pick would also say a here, but only by luck —
    // the point is the step is derived from carrier state, not from re-sorting.
    const conns = [
      { id: "a", provider: "antigravity", priority: 1, earliestPackageExpiry: inDays(2), shortWindowRemaining: 80 },
      { id: "b", provider: "antigravity", priority: 2, earliestPackageExpiry: inDays(30), shortWindowRemaining: 3, lastUsedAt: new Date().toISOString() },
    ];
    mocks.getProviderConnections.mockResolvedValue(conns);
    mocks.getSettings.mockResolvedValue({
      fallbackStrategy: "fill-first",
      providerStrategies: { antigravity: { earliestExpiryFirst: true } },
    });

    const res = await getProviderCredentials("antigravity");
    expect(res.connectionId).toBe("a");
  });

  it("orders the ring by earliest expiry — a no-expiry account sorts last", async () => {
    // Fresh pool (no carrier): the head of the RING must be the soonest-expiring
    // account; the priority column alone would have picked a.
    const conns = [
      { id: "a", provider: "p", priority: 1, earliestPackageExpiry: null },
      { id: "b", provider: "p", priority: 2, earliestPackageExpiry: inDays(5) },
    ];
    mocks.getProviderConnections.mockResolvedValue(conns);
    mocks.getSettings.mockResolvedValue({
      fallbackStrategy: "fill-first",
      providerStrategies: { p: { earliestExpiryFirst: true } },
    });

    const res = await getProviderCredentials("p");
    expect(res.connectionId).toBe("b");
  });

  it("toggle OFF keeps the legacy fill-first path: no relay, no carrier stamp", async () => {
    const conns = [
      { id: "a", provider: "p", priority: 1 },
      { id: "b", provider: "p", priority: 2, earliestPackageExpiry: inDays(1) },
    ];
    mocks.getProviderConnections.mockResolvedValue(conns);
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "fill-first", providerStrategies: {} });

    const res = await getProviderCredentials("p");
    expect(res.connectionId).toBe("a");
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("a pinned connection short-circuits the relay", async () => {
    const conns = [
      { id: "a", provider: "p", priority: 1, earliestPackageExpiry: inDays(2) },
      { id: "b", provider: "p", priority: 2, earliestPackageExpiry: inDays(30), lastUsedAt: new Date().toISOString() },
    ];
    mocks.getProviderConnections.mockResolvedValue(conns);
    mocks.getSettings.mockResolvedValue({
      fallbackStrategy: "fill-first",
      providerStrategies: { p: { earliestExpiryFirst: true } },
    });

    const res = await getProviderCredentials("p", null, null, { preferredConnectionId: "a" });
    expect(res.connectionId).toBe("a");
    // No carrier stamp — the pin skips the strategy entirely. (The background
    // quota refresh may still write quota fields; only lastUsedAt is ours.)
    expect(
      mocks.updateProviderConnection.mock.calls.some(([, patch]) => "lastUsedAt" in patch),
    ).toBe(false);
  });
});
