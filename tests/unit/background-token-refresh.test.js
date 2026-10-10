/**
 * Background OAuth token-refresh scheduler.
 *
 * Covers pure selection (selectConnectionsNeedingRefresh) and a fake tick that
 * exercises checkAndRefreshToken dispatch + fail-open per connection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const NOW = Date.parse("2026-08-01T12:00:00.000Z");

function conn(overrides = {}) {
  return {
    id: "c1",
    provider: "grok-cli",
    authType: "oauth",
    refreshToken: "rt-1",
    expiresAt: new Date(NOW + 10 * 60 * 1000).toISOString(),
    isActive: true,
    ...overrides,
  };
}

describe("selectConnectionsNeedingRefresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it("selects oauth grok-cli connection expiring in 10 minutes", async () => {
    const { selectConnectionsNeedingRefresh } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );
    const list = selectConnectionsNeedingRefresh(
      [conn({ expiresAt: new Date(NOW + 10 * 60 * 1000).toISOString() })],
      NOW
    );
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("c1");
  });

  it("skips connection expiring in 2 hours", async () => {
    const { selectConnectionsNeedingRefresh } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );
    const list = selectConnectionsNeedingRefresh(
      [conn({ expiresAt: new Date(NOW + 2 * 60 * 60 * 1000).toISOString() })],
      NOW
    );
    expect(list).toHaveLength(0);
  });

  it("never selects apikey connections", async () => {
    const { selectConnectionsNeedingRefresh } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );
    const list = selectConnectionsNeedingRefresh(
      [
        conn({ authType: "apikey", refreshToken: "rt" }),
        conn({ id: "c2", authType: "api_key", refreshToken: "rt" }),
      ],
      NOW
    );
    expect(list).toHaveLength(0);
  });

  it("skips oauth connection without refreshToken", async () => {
    const { selectConnectionsNeedingRefresh } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );
    const list = selectConnectionsNeedingRefresh(
      [conn({ refreshToken: null }), conn({ id: "c2", refreshToken: undefined })],
      NOW
    );
    expect(list).toHaveLength(0);
  });

  it("selects already-expired oauth connection", async () => {
    const { selectConnectionsNeedingRefresh } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );
    const list = selectConnectionsNeedingRefresh(
      [conn({ expiresAt: new Date(NOW - 60 * 1000).toISOString() })],
      NOW
    );
    expect(list).toHaveLength(1);
  });

  // P2-11: a dead refresh token gets marked needs-reauth with a 24h window.
  // The tick must NOT probe inside that window — every unrecoverable answer
  // rewrites the stamp to a fresh 24h, so a 5-minute tick against a corpse
  // would keep it benched forever instead of once per window.
  it("skips a needs-reauth account while its cooldown window is live", async () => {
    const { selectConnectionsNeedingRefresh } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );
    const list = selectConnectionsNeedingRefresh(
      [
        conn({
          testStatus: "needs-reauth",
          needsReauthUntil: new Date(NOW + 60 * 60 * 1000).toISOString(),
          // Expired access token: would otherwise be selected.
          expiresAt: new Date(NOW - 60 * 1000).toISOString(),
        }),
      ],
      NOW
    );
    expect(list).toHaveLength(0);
  });

  it("probes the account again once the window lapses (timed, not permanent)", async () => {
    const { selectConnectionsNeedingRefresh } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );
    const list = selectConnectionsNeedingRefresh(
      [
        conn({
          testStatus: "needs-reauth",
          needsReauthUntil: new Date(NOW - 1000).toISOString(),
          expiresAt: new Date(NOW - 60 * 1000).toISOString(),
        }),
      ],
      NOW
    );
    expect(list).toHaveLength(1);
  });

  it("does not skip a re-authorized account because of a stale stamp", async () => {
    const { selectConnectionsNeedingRefresh } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );
    const list = selectConnectionsNeedingRefresh(
      [
        conn({
          testStatus: "active",
          needsReauthUntil: new Date(NOW + 60 * 60 * 1000).toISOString(),
          expiresAt: new Date(NOW - 60 * 1000).toISOString(),
        }),
      ],
      NOW
    );
    expect(list).toHaveLength(1);
  });
});

describe("runBackgroundTokenRefreshTick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("calls refresh only for due connections and swallows per-connection errors", async () => {
    const due = conn({
      id: "due",
      expiresAt: new Date(NOW + 10 * 60 * 1000).toISOString(),
    });
    const notDue = conn({
      id: "not-due",
      expiresAt: new Date(NOW + 2 * 60 * 60 * 1000).toISOString(),
    });
    const apikey = conn({
      id: "key",
      authType: "apikey",
      expiresAt: new Date(NOW + 60 * 1000).toISOString(),
    });

    const refreshConnection = vi.fn(async (c) => {
      if (c.id === "due") throw new Error("boom");
      return c;
    });
    const loadConnections = vi.fn(async () => [due, notDue, apikey]);

    const { runBackgroundTokenRefreshTick } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );

    await expect(
      runBackgroundTokenRefreshTick({ loadConnections, refreshConnection })
    ).resolves.toBeUndefined();

    expect(loadConnections).toHaveBeenCalledTimes(1);
    expect(refreshConnection).toHaveBeenCalledTimes(1);
    expect(refreshConnection.mock.calls[0][0].id).toBe("due");
  });

  it("does not call refresh when nothing is due", async () => {
    const refreshConnection = vi.fn();
    const loadConnections = vi.fn(async () => [
      conn({
        expiresAt: new Date(NOW + 3 * 60 * 60 * 1000).toISOString(),
      }),
    ]);

    const { runBackgroundTokenRefreshTick } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );

    await runBackgroundTokenRefreshTick({ loadConnections, refreshConnection });

    expect(refreshConnection).not.toHaveBeenCalled();
  });

  it("refreshes connections sequentially with staggered delays between accounts", async () => {
    const agy = conn({
      id: "agy-1",
      provider: "antigravity",
      expiresAt: new Date(NOW + 10 * 60 * 1000).toISOString(),
    });
    const claude = conn({
      id: "claude-1",
      expiresAt: new Date(NOW + 10 * 60 * 1000).toISOString(),
    });

    const events = [];
    const refreshConnection = vi.fn(async (c) => {
      events.push(`start:${c.id}`);
      await Promise.resolve();
      events.push(`end:${c.id}`);
      return c;
    });
    const sleeps = [];
    const sleep = vi.fn(async (ms) => { sleeps.push(ms); });

    const loadConnections = vi.fn(async () => [agy, claude]);

    const { runBackgroundTokenRefreshTick } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );

    await runBackgroundTokenRefreshTick({ loadConnections, refreshConnection, sleep });

    // Strict start→end→start→end order proves no overlapping refreshes
    expect(events).toEqual(["start:agy-1", "end:agy-1", "start:claude-1", "end:claude-1"]);
    // One inter-account delay; Google-sensitive provider paces at ≥12s
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(12_000);
  });

  it("swallows top-level load errors", async () => {
    const refreshConnection = vi.fn();
    const loadConnections = vi.fn(async () => {
      throw new Error("db down");
    });

    const { runBackgroundTokenRefreshTick } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );

    await expect(
      runBackgroundTokenRefreshTick({ loadConnections, refreshConnection })
    ).resolves.toBeUndefined();
    expect(refreshConnection).not.toHaveBeenCalled();
  });
});

describe("start/stop guards", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    const mod = await import("../../src/sse/services/backgroundTokenRefresh.js");
    mod.stopBackgroundTokenRefresh();
    vi.resetModules();
  });

  it("honors DISABLE_BACKGROUND_TOKEN_REFRESH kill-switch", async () => {
    vi.stubEnv("DISABLE_BACKGROUND_TOKEN_REFRESH", "1");
    const { startBackgroundTokenRefresh, stopBackgroundTokenRefresh } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );
    expect(startBackgroundTokenRefresh()).toBe(false);
    stopBackgroundTokenRefresh();
  });

  it("is idempotent: second start is no-op", async () => {
    vi.stubEnv("DISABLE_BACKGROUND_TOKEN_REFRESH", "");
    const { startBackgroundTokenRefresh, stopBackgroundTokenRefresh } = await import(
      "../../src/sse/services/backgroundTokenRefresh.js"
    );
    const first = startBackgroundTokenRefresh({ intervalMs: 60_000 });
    const second = startBackgroundTokenRefresh({ intervalMs: 60_000 });
    expect(first).toBe(true);
    expect(second).toBe(false);
    stopBackgroundTokenRefresh();
  });
});
