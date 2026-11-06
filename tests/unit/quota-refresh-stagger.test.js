import { describe, it, expect, vi, afterEach } from "vitest";

// Background quota refresh (auth.js triggerBackgroundQuotaRefresh) staggers its
// upstream calls by queue position — same anti-burst policy as the background
// token refresh, which already tests its sequential pacing. The delay decision
// is extracted as a pure helper so it can be pinned without importing the DB.

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  validateApiKey: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  validateApiKey: mocks.validateApiKey,
  updateProviderConnection: mocks.updateProviderConnection,
  getSettings: mocks.getSettings,
  getProxyPools: mocks.getProxyPools,
}));

async function load() {
  vi.resetModules();
  return import("../../src/sse/services/auth.js");
}

describe("quotaRefreshDelayMs", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("fires the first scheduled connection immediately", async () => {
    const { quotaRefreshDelayMs } = await load();
    expect(quotaRefreshDelayMs("grok-cli", 0)).toBe(0);
    expect(quotaRefreshDelayMs("antigravity", 0)).toBe(0);
  });

  it("staggers normal providers at 1.5s per position (+200ms fixed jitter)", async () => {
    const { quotaRefreshDelayMs } = await load();
    expect(quotaRefreshDelayMs("grok-cli", 1)).toBe(1500 + 200);
    expect(quotaRefreshDelayMs("grok-cli", 3)).toBe(3 * 1500 + 200);
  });

  it("staggers the Google-sensitive set at 12s per position (0-4s jitter)", async () => {
    const { quotaRefreshDelayMs } = await load();
    for (const provider of ["antigravity", "gemini-cli"]) {
      const d = quotaRefreshDelayMs(provider, 1);
      expect(d).toBeGreaterThanOrEqual(12_000);
      expect(d).toBeLessThan(16_000);
    }
  });

  it("reads the same BG_REFRESH_* knobs as the token refresh", async () => {
    vi.stubEnv("BG_REFRESH_DELAY_MS", "500");
    vi.stubEnv("BG_REFRESH_GOOGLE_DELAY_MS", "3000");
    const { quotaRefreshDelayMs } = await load();
    expect(quotaRefreshDelayMs("grok-cli", 2)).toBe(2 * 500 + 200);
    const d = quotaRefreshDelayMs("gemini-cli", 2);
    expect(d).toBeGreaterThanOrEqual(2 * 3000);
    expect(d).toBeLessThan(2 * 3000 + 4000);
  });

  it("tolerates a missing/invalid index", async () => {
    const { quotaRefreshDelayMs } = await load();
    expect(quotaRefreshDelayMs("grok-cli")).toBe(0);
    expect(quotaRefreshDelayMs("grok-cli", -1)).toBe(0);
    expect(quotaRefreshDelayMs("grok-cli", Number.NaN)).toBe(0);
  });
});
