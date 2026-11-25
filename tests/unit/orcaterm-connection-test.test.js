import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }));
const auth = vi.hoisted(() => ({ billing: vi.fn(), refresh: vi.fn() }));

vi.mock("@/lib/localDb", () => ({
  getProviderConnectionById: db.get,
  updateProviderConnection: db.update,
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({
    connectionProxyEnabled: false,
    connectionProxyUrl: null,
    vercelRelayUrl: null,
  })),
}));
vi.mock("@/lib/network/proxyTest", () => ({ testProxyUrl: vi.fn() }));
vi.mock("open-sse/services/usage.js", () => ({ getUsageForProvider: vi.fn(async () => ({})) }));
vi.mock("open-sse/shared/orcaterm/auth.js", () => ({
  fetchOrcaTermBilling: auth.billing,
  refreshOrcaTermToken: auth.refresh,
}));

const { testSingleConnection } = await import("../../src/app/api/providers/[id]/test/testUtils.js");

function connection(overrides = {}) {
  return {
    id: "orca-connection",
    provider: "orcaterm",
    authType: "oauth",
    accessToken: "valid-orca-token",
    refreshToken: "valid-orca-token",
    expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    providerSpecificData: { userId: "orca-user" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.get.mockImplementation(async () => connection());
  db.update.mockResolvedValue({});
  auth.billing.mockResolvedValue({ balance: 1 });
  auth.refresh.mockResolvedValue(null);
});

describe("OrcaTerm connection test", () => {
  it("keeps a still-valid account active when early renewal is refused", async () => {
    db.get.mockImplementation(async () => connection({
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));

    const result = await testSingleConnection("orca-connection");

    expect(auth.refresh).toHaveBeenCalledWith("valid-orca-token", null, expect.anything());
    expect(auth.billing).toHaveBeenCalledWith("valid-orca-token", expect.anything());
    expect(result.valid).toBe(true);
    expect(result.refreshed).toBe(false);
    expect(result.error).toBeNull();
    expect(db.update).toHaveBeenCalledWith("orca-connection", expect.objectContaining({
      testStatus: "active",
      lastError: null,
    }));
  });

  it("surfaces that a selected model is not tested by the billing probe", async () => {
    const result = await testSingleConnection("orca-connection", { model: "TokenHub/kimi-k3" });

    expect(result.valid).toBe(true);
    expect(result.warning).toMatch(/model access is checked when sending a request/i);
    expect(result.error).toBe(result.warning);
    expect(db.update).toHaveBeenCalledWith("orca-connection", expect.objectContaining({
      testStatus: "active",
      lastError: result.warning,
    }));
  });
});
