import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(), updateProviderConnection: vi.fn(), getSettings: vi.fn(),
  getProxyPools: vi.fn(), validateApiKey: vi.fn(), getUsageForProvider: vi.fn(),
}));
vi.mock("@/lib/localDb", () => mocks);
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})), pickProxyPoolId: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({ FREE_PROVIDERS: {}, resolveProviderId: p => p }));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));
vi.mock("open-sse/services/usage.js", () => ({ getUsageForProvider: mocks.getUsageForProvider }));
import { getProviderCredentials, nextMidnightMs } from "../../src/sse/services/auth.js";
import { runDailyGrantResetTick } from "../../src/sse/services/dailyGrantReset.js";

let connections;
const account = (id, dailyGrantRemaining, extra = {}) => ({
  id, provider: "loomy", isActive: true, apiKey: "offline-fixture", dailyGrantRemaining,
  dailyGrantTotal: 5000, permanentBalance: 16000, quotaCheckedAt: new Date().toISOString(), ...extra,
});
beforeEach(() => {
  vi.clearAllMocks();
  connections = [];
  mocks.getProviderConnections.mockImplementation(async ({ provider, isActive } = {}) =>
    connections.filter(c => (!provider || c.provider === provider) && (isActive === undefined || c.isActive === isActive)));
  mocks.updateProviderConnection.mockImplementation(async (id, patch) => Object.assign(connections.find(c => c.id === id), patch));
  mocks.getSettings.mockResolvedValue({ providerStrategies: { loomy: { dailyGrantFirst: true } } });
  mocks.getProxyPools.mockResolvedValue([]);
  mocks.getUsageForProvider.mockResolvedValue({ quotas: {} });
});

describe("daily grant exhaustion is independent of account count", () => {
  it("stops a single exhausted account and keeps reporting retry time", async () => {
    connections = [account("last", 0)];
    const result = await getProviderCredentials("loomy");
    expect(result).toMatchObject({ allRateLimited: true, lastErrorCode: 429 });
    expect(Date.parse(result.retryAfter)).toBe(nextMidnightMs());
    expect(connections[0]).toMatchObject({ isActive: false, dailyGrantAutoDisabled: true });
    expect(await getProviderCredentials("loomy")).toMatchObject({ allRateLimited: true, retryAfter: result.retryAfter });
  });

  it("protects the last account after a two-account pool shrinks to one", async () => {
    connections = [account("first", 0, { lastUsedAt: new Date().toISOString() }), account("last", 100)];
    expect((await getProviderCredentials("loomy")).connectionId).toBe("last");
    expect(connections[0].isActive).toBe(false);
    connections[1].dailyGrantRemaining = 0;
    expect((await getProviderCredentials("loomy")).allRateLimited).toBe(true);
    expect(connections.every(c => !c.isActive && c.dailyGrantAutoDisabled)).toBe(true);
  });

  it.each([1, undefined, null, NaN])("allows a single account with positive or unknown daily balance %s", async remaining => {
    connections = [account("only", remaining)];
    expect((await getProviderCredentials("loomy")).connectionId).toBe("only");
    expect(connections[0].isActive).toBe(true);
  });

  it("does not let an exhausted pin or a second strategy bypass protection", async () => {
    connections = [account("empty", 0), account("funded", 10)];
    mocks.getSettings.mockResolvedValue({ providerStrategies: { loomy: { dailyGrantFirst: true, earliestExpiryFirst: true } } });
    const result = await getProviderCredentials("loomy", null, null, { preferredConnectionId: "empty" });
    expect(result.connectionId).toBe("funded");
    expect(connections[0].isActive).toBe(false);
  });

  it("waits for a funded sibling's short model cooldown before midnight", async () => {
    connections = [account("empty", 0), account("cooling", 4000, { modelLock_model: new Date(Date.now() + 60000).toISOString() })];
    const result = await getProviderCredentials("loomy", null, "model");
    expect(result.allRateLimited).toBe(true);
    expect(Date.parse(result.retryAfter)).toBeLessThan(nextMidnightMs());
    expect(Date.parse(result.retryAfter)).toBeGreaterThan(Date.now());
  });

  it("preserves forward-only relay handoff after removing spent candidates", async () => {
    connections = [
      account("head", 1000, { priority: 1 }),
      account("carrier", 0, { priority: 2, lastUsedAt: new Date().toISOString() }),
      account("next", 0, { priority: 3 }),
    ];
    expect((await getProviderCredentials("loomy")).connectionId).toBe("head");
    expect(connections.slice(1).every(c => c.isActive === false)).toBe(true);
  });

  it("refreshes stale daily data even with a single account", async () => {
    connections = [account("only", undefined, { quotaCheckedAt: null })];
    mocks.getUsageForProvider.mockResolvedValue({ quotas: {
      "永久积分": { isCreditBalance: true, used: 0, total: 16000 },
      "每日赠送积分": { recurring: true, used: 2500, total: 5000 },
    } });
    expect((await getProviderCredentials("loomy")).connectionId).toBe("only");
    await vi.waitFor(() => expect(connections[0].dailyGrantRemaining).toBe(2500));
  });

  it("reopens the stamped account through the midnight reset while leaving a manual disable alone", async () => {
    connections = [account("spent", 0), account("manual", 0, { isActive: false })];
    await getProviderCredentials("loomy");
    await runDailyGrantResetTick();
    expect(connections[0]).toMatchObject({ isActive: true, dailyGrantRemaining: 5000, dailyGrantAutoDisabled: false });
    expect(connections[1].isActive).toBe(false);
    expect((await getProviderCredentials("loomy")).connectionId).toBe("spent");
  });

  it("leaves selection unchanged when daily-grant policy is disabled", async () => {
    connections = [account("only", 0)];
    mocks.getSettings.mockResolvedValue({ providerStrategies: {} });
    expect((await getProviderCredentials("loomy")).connectionId).toBe("only");
    expect(connections[0].isActive).toBe(true);
  });

  it("does not call a manually disabled pool temporarily exhausted", async () => {
    connections = [account("manual", 0, { isActive: false })];
    expect(await getProviderCredentials("loomy")).toBeNull();
  });
});
