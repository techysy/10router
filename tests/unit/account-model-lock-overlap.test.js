import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModelLockUntil, isModelLockActive } from "../../open-sse/services/accountFallback.js";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(), updateProviderConnection: vi.fn(), getSettings: vi.fn(),
  getProxyPools: vi.fn(), validateApiKey: vi.fn(),
}));
vi.mock("@/lib/localDb", () => mocks);
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})), pickProxyPoolId: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({ FREE_PROVIDERS: {}, resolveProviderId: p => p }));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));
import { getProviderCredentials, markAccountUnavailable } from "../../src/sse/services/auth.js";

const time = delta => new Date(Date.now() + delta).toISOString();

describe("overlapping model and account cooldowns", () => {
  it.each([undefined, null, "not-a-date", "2000-01-01T00:00:00.000Z"])(
    "keeps an account lock active with stale model field %s", stale => {
      const until = time(3600000);
      const connection = { modelLock_a: stale, modelLock___all: until };
      expect(isModelLockActive(connection, "a")).toBe(true);
      expect(getModelLockUntil(connection, "a")).toBe(until);
    });

  it("waits for the later of both applicable locks, ignoring sibling models", () => {
    const modelUntil = time(600000);
    const accountUntil = time(3600000);
    const connection = { modelLock_a: modelUntil, modelLock_b: time(1000), modelLock___all: accountUntil };
    expect(getModelLockUntil(connection, "a")).toBe(accountUntil);
    const laterModelUntil = time(7200000);
    expect(getModelLockUntil({ ...connection, modelLock_a: laterModelUntil }, "a")).toBe(laterModelUntil);
    expect(getModelLockUntil(connection, null)).toBe(accountUntil);
  });

  it("does not lock on expired, malformed or unrelated values", () => {
    expect(isModelLockActive({ modelLock_a: time(-1000), modelLock___all: "invalid", modelLock_b: time(3600000) }, "a")).toBe(false);
    expect(getModelLockUntil({}, "a")).toBeNull();
    expect(getModelLockUntil(null, null)).toBeNull();
  });
});

describe("account selection uses the combined cooldown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({});
  });

  it("honors a monthly lock after an earlier model lock has expired", async () => {
    const connection = { id: "github-a", provider: "github", isActive: true, modelLock_modelA: time(-60000) };
    mocks.getProviderConnections.mockResolvedValue([connection]);
    mocks.updateProviderConnection.mockImplementation(async (_id, patch) => Object.assign(connection, patch));
    await markAccountUnavailable(connection.id, 402,
      "You've reached your additional usage limit for your plan. Go to GitHub settings for details.", "github", "modelB");
    const result = await getProviderCredentials("github", null, "modelA");
    expect(result).toMatchObject({ allRateLimited: true, retryAfter: connection.modelLock___all });
  });

  it("reports the requested model's unlock time rather than an unrelated earlier lock", async () => {
    const until = time(3600000);
    mocks.getProviderConnections.mockResolvedValue([
      { id: "a", modelLock_modelA: time(600000), modelLock_modelB: time(1000), modelLock___all: until },
      { id: "b", modelLock_modelA: time(7200000) },
    ]);
    expect(await getProviderCredentials("github", null, "modelA")).toMatchObject({ allRateLimited: true, retryAfter: until });
  });
});
