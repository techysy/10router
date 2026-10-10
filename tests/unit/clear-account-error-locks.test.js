// clearAccountError had NO direct coverage before this file: every reference in
// tests/ is a `vi.fn()` mock (embedding-usage-persistence, fetch-success-clears
// -account, gemini-native-endpoint, xai-video-handler), so the real function
// was never imported and the `remainingActiveLocks.length === 0` gate — the
// branch that decides whether an account-level error state gets reset — was
// never executed even once.
//
// That gate is exactly what issue #46's root fix has to change, so it gets
// tested for real first. The harness mirrors github-monthly-usage-lock.test.js,
// which already drives a real markAccountUnavailable with @/lib/localDb mocked.
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  validateApiKey: vi.fn(),
  getSettings: vi.fn(async () => ({})),
  getProxyPools: vi.fn(async () => []),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/lib/network/connectionProxy", () => ({
  pickProxyPoolId: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { clearAccountError } = await import("../../src/sse/services/auth.js");

const future = (ms = 60_000) => new Date(Date.now() + ms).toISOString();
const past = (ms = 60_000) => new Date(Date.now() - ms).toISOString();

// The single write clearAccountError performs.
const write = () => dbMocks.updateProviderConnection.mock.calls.at(-1)?.[1];

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.updateProviderConnection.mockResolvedValue(undefined);
});

describe("clearAccountError — early exits", () => {
  it("does nothing without a connection id", async () => {
    await clearAccountError(null, { testStatus: "unavailable", lastError: "boom" });
    await clearAccountError("", { testStatus: "unavailable" });
    expect(dbMocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("does nothing for the synthetic noauth connection", async () => {
    // noAuth lines carry no persisted row; writing one would create a ghost.
    await clearAccountError("noauth", { testStatus: "unavailable", lastError: "boom" });
    expect(dbMocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("does nothing when there is no error state and no lock at all", async () => {
    await clearAccountError("conn-1", { id: "conn-1", testStatus: "active" });
    expect(dbMocks.updateProviderConnection).not.toHaveBeenCalled();
  });
});

describe("clearAccountError — the last active lock resets the account", () => {
  it("clears the succeeded model's lock and the whole error state", async () => {
    await clearAccountError(
      "conn-1",
      { id: "conn-1", testStatus: "unavailable", lastError: "429", errorCode: 429, lastErrorAt: "x", backoffLevel: 2, modelLock_gpt: future() },
      "gpt",
    );
    expect(write()).toMatchObject({
      modelLock_gpt: null,
      testStatus: "active",
      lastError: null,
      errorCode: null,
      lastErrorAt: null,
      backoffLevel: 0,
    });
  });

  it("lazy-clears an unrelated expired lock in the same write", async () => {
    await clearAccountError(
      "conn-1",
      { id: "conn-1", testStatus: "unavailable", lastError: "429", modelLock_gpt: future(), modelLock_stale: past() },
      "gpt",
    );
    // Both keys go in one write so the row is never briefly inconsistent.
    expect(write()).toMatchObject({ modelLock_gpt: null, modelLock_stale: null });
  });

  it("clears an account-wide lock when any model succeeds", async () => {
    await clearAccountError(
      "conn-1",
      { id: "conn-1", testStatus: "unavailable", lastError: "429", modelLock___all: future() },
      "gpt",
    );
    expect(write()).toMatchObject({ modelLock___all: null, testStatus: "active" });
  });

  it("unwraps a credentials object nested under _connection", async () => {
    // Callers pass `credentials` from getProviderCredentials, not the raw row.
    await clearAccountError(
      "conn-1",
      { _connection: { id: "conn-1", testStatus: "unavailable", lastError: "429", modelLock_gpt: future() } },
      "gpt",
    );
    expect(write()).toMatchObject({ modelLock_gpt: null, testStatus: "active" });
  });
});

describe("clearAccountError — a surviving lock keeps the account marked (#46)", () => {
  // THE branch issue #46 turns on. A sibling model is still cooling down, so
  // this account is not healthy: resetting testStatus to "active" here would
  // claim the account recovered while a lock is live, and the row would go
  // green with a model still unavailable.
  it("does NOT reset the account state while another model's lock is live", async () => {
    await clearAccountError(
      "conn-1",
      { id: "conn-1", testStatus: "unavailable", lastError: "429", errorCode: 429, modelLock_gpt: future(), modelLock_claude: future() },
      "gpt",
    );
    const w = write();
    expect(w.modelLock_gpt).toBeNull();          // the succeeded model is freed
    expect(w.modelLock_claude).toBeUndefined();  // the sibling lock is untouched
    expect(w).not.toHaveProperty("testStatus");
    expect(w).not.toHaveProperty("lastError");
  });

  it("still clears the error state once the last lock is released", async () => {
    // Two-step recovery: gpt succeeds while claude is locked (no reset), then
    // claude succeeds (reset). Proves the gate is about LIVE locks, not about
    // having ever seen one.
    await clearAccountError(
      "conn-1",
      { id: "conn-1", testStatus: "unavailable", lastError: "429", modelLock_gpt: future(), modelLock_claude: future() },
      "gpt",
    );
    expect(write()).not.toHaveProperty("testStatus");

    dbMocks.updateProviderConnection.mockClear();
    await clearAccountError(
      "conn-1",
      { id: "conn-1", testStatus: "unavailable", lastError: "429", modelLock_claude: future() },
      "claude",
    );
    expect(write()).toMatchObject({ modelLock_claude: null, testStatus: "active" });
  });

  it("does not write at all when no lock matches the succeeded model", async () => {
    // Nothing to clear and the account is not marked — the early return.
    await clearAccountError(
      "conn-1",
      { id: "conn-1", testStatus: "active", modelLock_other: future() },
      "gpt",
    );
    expect(dbMocks.updateProviderConnection).not.toHaveBeenCalled();
  });
});

describe("clearAccountError — a success does not revive a dead refresh token (P2-11)", () => {
  // "needs-reauth" is not a request-scoped error: it says the refresh token is
  // dead, and one successful request on a still-valid access token proves only
  // that the ACCESS token works. Resetting the mark here would put a
  // dead-refresh-token account back in rotation until its access token expires
  // and the next refresh invalid_grant-cycles again.
  it("keeps the mark (and its reason) while clearing the succeeded model's lock", async () => {
    await clearAccountError(
      "conn-1",
      {
        id: "conn-1",
        testStatus: "needs-reauth",
        needsReauthUntil: future(24 * 60 * 60 * 1000),
        lastError: "Refresh token expired or revoked. Please re-authorize this connection.",
        errorCode: 401,
        modelLock_gpt: future(),
      },
      "gpt",
    );
    const w = write();
    expect(w.modelLock_gpt).toBeNull();
    expect(w).not.toHaveProperty("testStatus");
    expect(w).not.toHaveProperty("lastError");
    expect(w).not.toHaveProperty("errorCode");
    expect(w.backoffLevel).toBe(0);
  });

  it("keeps the mark even with no locks at all (access token just happens to work)", async () => {
    await clearAccountError(
      "conn-1",
      {
        id: "conn-1",
        testStatus: "needs-reauth",
        needsReauthUntil: future(24 * 60 * 60 * 1000),
        lastError: "Refresh token expired or revoked. Please re-authorize this connection.",
        errorCode: 401,
      },
      "gpt",
    );
    const w = write();
    expect(w).not.toHaveProperty("testStatus");
    expect(w).not.toHaveProperty("lastError");
  });
});
