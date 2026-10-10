// P2-11 — dead refresh token (invalid_grant / refresh_token_reused) used to
// leave the account in rotation: every 2-minute 401 cooldown re-probed it,
// failed again, and the dashboard showed nothing actionable. The fix is a
// two-part state — the sticky `testStatus: "needs-reauth"` mark (cleared only
// by something that proves the credentials work) plus a timed
// `needsReauthUntil` stamp (selection skips only while the window is live, so
// a re-auth takes effect immediately and a still-dead account is probed once
// per window instead of forever).
//
// This file pins the semantics. The JSX label sites are source-guarded at the
// bottom because tests/vitest.config.js runs environment "node" with no JSX
// transform (repo convention — see tests/unit/connection-cooldown-ux.test.js).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
  validateApiKey: vi.fn(),
  getSettings: vi.fn(async () => ({})),
  getProxyPools: vi.fn(async () => []),
}));

const credMocks = vi.hoisted(() => ({
  refreshProviderCredentials: vi.fn(),
  shouldRefreshCredentials: vi.fn(() => true),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("open-sse/services/oauthCredentialManager.js", () => ({
  refreshProviderCredentials: credMocks.refreshProviderCredentials,
  shouldRefreshCredentials: credMocks.shouldRefreshCredentials,
}));
vi.mock("open-sse/services/projectId.js", () => ({
  getProjectIdForConnection: vi.fn(),
  invalidateProjectId: vi.fn(),
  removeConnection: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  pickProxyPoolId: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));

const {
  isNeedsReauthCooling,
  buildNeedsReauthUpdate,
  NEEDS_REAUTH_STATUS,
  NEEDS_REAUTH_COOLDOWN_MS,
} = await import("open-sse/services/accountFallback.js");
const {
  markConnectionNeedsReauth,
  checkAndRefreshToken,
  NEEDS_REAUTH_MESSAGE,
} = await import("../../src/sse/services/tokenRefresh.js");
const { getProviderCredentials } = await import("../../src/sse/services/auth.js");

const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const at = (ms) => new Date(NOW + ms).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.updateProviderConnection.mockResolvedValue(true);
  dbMocks.getProviderConnectionById.mockResolvedValue(null);
});

describe("needs-reauth is two fields, not one (accountFallback primitives)", () => {
  it("buildNeedsReauthUpdate writes the sticky mark and a ~24h cooldown stamp", () => {
    const out = buildNeedsReauthUpdate();
    expect(out.testStatus).toBe("needs-reauth");
    const until = Date.parse(out.needsReauthUntil);
    expect(Number.isFinite(until)).toBe(true);
    expect(NEEDS_REAUTH_COOLDOWN_MS).toBe(24 * 60 * 60 * 1000);
    // The stamp must be a real future window, not the mark's own timestamp.
    expect(until - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(until - Date.now()).toBeLessThanOrEqual(NEEDS_REAUTH_COOLDOWN_MS + 5_000);
  });

  it("isNeedsReauthCooling is true only while the window is live", () => {
    const cooling = { testStatus: NEEDS_REAUTH_STATUS, needsReauthUntil: at(60_000) };
    expect(isNeedsReauthCooling(cooling, NOW)).toBe(true);
    // Same mark, window lapsed → probed again. Timed, not permanent: this is
    // the "retried once per cooldown window" half of the design.
    expect(isNeedsReauthCooling(cooling, NOW + 120_000)).toBe(false);
  });

  it("needs the mark AND a live stamp — either one alone is not cooling", () => {
    // Mark without stamp: fail OPEN to probing (the next unrecoverable
    // refresh re-stamps the window). The mark alone is display-only.
    expect(isNeedsReauthCooling({ testStatus: NEEDS_REAUTH_STATUS }, NOW)).toBe(false);
    // Stamp without mark: a re-auth wrote testStatus "active" — must take
    // effect immediately, without waiting out the old window. This is exactly
    // why the cooldown is NOT a modelLock_* key.
    expect(isNeedsReauthCooling({ testStatus: "active", needsReauthUntil: at(60_000) }, NOW)).toBe(false);
    expect(isNeedsReauthCooling({ needsReauthUntil: at(60_000) }, NOW)).toBe(false);
  });

  it("ignores an unparseable stamp instead of throwing", () => {
    for (const bad of [null, "", "not-a-date", undefined]) {
      expect(isNeedsReauthCooling({ testStatus: NEEDS_REAUTH_STATUS, needsReauthUntil: bad }, NOW)).toBe(false);
    }
    expect(isNeedsReauthCooling(null, NOW)).toBe(false);
  });
});

describe("markConnectionNeedsReauth", () => {
  it("writes the mark, the cooldown stamp and the human-readable reason", async () => {
    await expect(
      markConnectionNeedsReauth("c1", { provider: "codex", reason: { error: "invalid_grant" } })
    ).resolves.toBe(true);

    const updates = dbMocks.updateProviderConnection.mock.calls[0][1];
    expect(updates.testStatus).toBe("needs-reauth");
    expect(Date.parse(updates.needsReauthUntil) - Date.now()).toBeGreaterThan(0);
    expect(updates.lastError).toBe(NEEDS_REAUTH_MESSAGE);
    expect(updates.errorCode).toBe(401);
    expect(updates.lastErrorAt).toBeTruthy();
    // Not a rate-limit ladder: a stale backoffLevel would mis-size the next
    // (unrelated) cooldown this account earns.
    expect(updates.backoffLevel).toBe(0);
  });

  it("keeps NEEDS_REAUTH_MESSAGE a fixed sentence (translateQuotaError resolves it by literal)", () => {
    // Rewording this drops the zh-CN/zh-TW translation — see the literals
    // guard at the bottom of this file.
    expect(NEEDS_REAUTH_MESSAGE).toBe(
      "Refresh token expired or revoked. Please re-authorize this connection."
    );
  });

  it("never marks the synthetic noauth row or an empty id", async () => {
    await expect(markConnectionNeedsReauth("noauth")).resolves.toBe(false);
    await expect(markConnectionNeedsReauth(null)).resolves.toBe(false);
    await expect(markConnectionNeedsReauth("")).resolves.toBe(false);
    expect(dbMocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("returns false when the write does not land (the request still falls back)", async () => {
    dbMocks.updateProviderConnection.mockResolvedValue(false);
    await expect(markConnectionNeedsReauth("c1")).resolves.toBe(false);
  });
});

describe("checkAndRefreshToken marks unrecoverable refresh failures", () => {
  // The detection funnel: refreshProviderCredentials passes the error object
  // through as the "new credentials", so without an explicit check the caller's
  // `if (newCreds?.accessToken)` silently dropped it and the dead account
  // stayed in rotation.
  const creds = {
    connectionId: "c1",
    accessToken: "at-old",
    refreshToken: "rt-dead",
    lastRefreshAt: at(-3_600_000),
    expiresAt: at(-60_000),
  };

  it("marks the account and falls through with the stale credentials on invalid_grant", async () => {
    credMocks.refreshProviderCredentials.mockResolvedValue({ error: "invalid_grant" });

    const out = await checkAndRefreshToken("codex", creds, { force: true });

    // Falls through with the CURRENT credentials so the caller's 401 →
    // fallback path still runs — but the account is now marked, so selection
    // skips it and the dashboard says why.
    expect(out.accessToken).toBe("at-old");
    const updates = dbMocks.updateProviderConnection.mock.calls.at(-1)?.[1];
    expect(updates).toMatchObject({ testStatus: "needs-reauth", errorCode: 401 });
    expect(updates.lastError).toBe(NEEDS_REAUTH_MESSAGE);
  });

  it("marks on every unrecoverable code, not just invalid_grant", async () => {
    for (const error of ["unrecoverable_refresh_error", "refresh_token_reused", "invalid_request"]) {
      vi.clearAllMocks();
      dbMocks.updateProviderConnection.mockResolvedValue(true);
      credMocks.refreshProviderCredentials.mockResolvedValue({ error });

      await checkAndRefreshToken("codex", creds, { force: true });

      expect(
        dbMocks.updateProviderConnection.mock.calls.at(-1)?.[1]?.testStatus,
        `code ${error} must mark the account`
      ).toBe("needs-reauth");
    }
  });

  it("does NOT mark on a transient refresh miss (network / null result)", async () => {
    for (const result of [null, undefined, { error: "network_timeout" }, { message: "boom" }]) {
      vi.clearAllMocks();
      credMocks.refreshProviderCredentials.mockResolvedValue(result);

      await checkAndRefreshToken("codex", creds, { force: true });

      for (const call of dbMocks.updateProviderConnection.mock.calls) {
        expect(call[1]).not.toHaveProperty("testStatus");
      }
    }
  });
});

describe("getProviderCredentials skips dead-refresh-token accounts", () => {
  // Selection reads the wall clock (isNeedsReauthCooling's default nowMs), so
  // these stamps must be relative to the real Date.now() — the fixed NOW above
  // is only for the primitives that take an injected clock.
  const inMs = (ms) => new Date(Date.now() + ms).toISOString();

  const coolingConn = {
    id: "dead",
    provider: "codex",
    authType: "oauth",
    testStatus: "needs-reauth",
    needsReauthUntil: inMs(3_600_000),
    lastError: NEEDS_REAUTH_MESSAGE,
    errorCode: 401,
    accessToken: "at-dead",
    refreshToken: "rt-dead",
  };
  const healthyConn = {
    id: "alive",
    provider: "codex",
    authType: "oauth",
    testStatus: "active",
    accessToken: "at-alive",
    refreshToken: "rt-alive",
    priority: 1,
  };

  it("a fully dead pool answers with the re-auth reason and a retry time, not a bare 404", async () => {
    // There ARE credentials; they need re-authorization. "No active
    // credentials" 404 lied about both the problem and the retry time.
    dbMocks.getProviderConnections.mockResolvedValue([coolingConn]);

    const out = await getProviderCredentials("codex", null, "gpt");

    expect(out.allRateLimited).toBe(true);
    expect(out.lastError).toBe(NEEDS_REAUTH_MESSAGE);
    expect(out.lastErrorCode).toBe(401);
    expect(out.retryAfter).toBe(coolingConn.needsReauthUntil);
    expect(out.retryAfterHuman).toBeTruthy();
  });

  it("rotates to the healthy sibling instead of dying with the dead one", async () => {
    dbMocks.getProviderConnections.mockResolvedValue([coolingConn, healthyConn]);

    const out = await getProviderCredentials("codex", null, "gpt");

    expect(out.connectionId).toBe("alive");
    expect(out.accessToken).toBe("at-alive");
  });

  it("probes the account again once the cooldown window lapses", async () => {
    dbMocks.getProviderConnections.mockResolvedValue([
      { ...coolingConn, needsReauthUntil: inMs(-1_000) },
    ]);

    const out = await getProviderCredentials("codex", null, "gpt");
    expect(out.connectionId).toBe("dead");
  });

  it("treats a re-authorized account as live immediately, without waiting out the window", async () => {
    // The re-auth writes testStatus "active" while the stale stamp is still in
    // the future. Selection must honour the mark, not the leftover stamp —
    // the whole reason this state is NOT a modelLock_*.
    dbMocks.getProviderConnections.mockResolvedValue([
      { ...coolingConn, testStatus: "active", accessToken: "at-new", refreshToken: "rt-new" },
    ]);

    const out = await getProviderCredentials("codex", null, "gpt");
    expect(out.connectionId).toBe("dead");
    expect(out.accessToken).toBe("at-new");
  });
});

// ─── Wiring guards (source-text: JSX and handler glue cannot be imported) ────

const rootDir = resolve(__dirname, "../..");
const read = (rel) => readFileSync(resolve(rootDir, rel), "utf8");

describe("the mark is wired end to end (P2-11)", () => {
  it("all four cores report unrecoverable refresh failures to the app side", () => {
    // Each core's 401→refresh else-branch used to only log — videoCore even
    // said "account needs re-auth" without telling anyone but the console.
    for (const rel of [
      "open-sse/handlers/chatCore.js",
      "open-sse/handlers/embeddingsCore.js",
      "open-sse/handlers/imageGenerationCore.js",
      "open-sse/handlers/videoCore.js",
    ]) {
      const src = read(rel);
      expect(src, rel).toContain("notifyRefreshFailure");
      expect(src, rel).toContain("onCredentialsRefreshFailed");
    }
  });

  it("all four app handlers turn the failure into the persisted mark", () => {
    for (const rel of [
      "src/sse/handlers/chat.js",
      "src/sse/handlers/embeddings.js",
      "src/sse/handlers/imageGeneration.js",
      "src/sse/handlers/videoGeneration.js",
    ]) {
      const src = read(rel);
      expect(src, rel).toContain("onCredentialsRefreshFailed");
      expect(src, rel).toContain("markConnectionNeedsReauth");
    }
  });

  it("notifyRefreshFailure only fires the callback on unrecoverable failures", async () => {
    const { notifyRefreshFailure } = await import("open-sse/services/tokenRefresh.js");
    const cb = vi.fn();

    await expect(notifyRefreshFailure({ error: "invalid_grant" }, cb)).resolves.toBe(true);
    expect(cb).toHaveBeenCalledTimes(1);

    await expect(notifyRefreshFailure({ error: "network_timeout" }, cb)).resolves.toBe(false);
    await expect(notifyRefreshFailure(null, cb)).resolves.toBe(false);
    // The callback is optional — the engine keeps working standalone.
    await expect(notifyRefreshFailure({ error: "invalid_grant" })).resolves.toBe(true);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("the usage route marks before surfacing the failure", () => {
    const src = read("src/app/api/usage/[connectionId]/route.js");
    expect(src).toContain("markConnectionNeedsReauth");
  });

  it("credential re-provision consumes the mark (create-merge + resetErrorState)", () => {
    // A fresh credential set IS the re-auth: the mark must not outlive it, and
    // the cooldown stamp must not keep a freshly authorized account benched.
    const src = read("src/lib/db/repos/connectionsRepo.js");
    expect(src).toMatch(/merged\.testStatus === "needs-reauth"[\s\S]{0,120}needsReauthUntil = null/);
    expect(src).toContain("needsReauthUntil: null");
  });

  it("background refreshers never re-probe a cooling corpse (window would re-extend forever)", () => {
    // Every probe that gets an unrecoverable answer rewrites needsReauthUntil
    // to a fresh 24h, so a 5-minute tick against a dead account would keep it
    // benched permanently — the bug inverted, not fixed.
    expect(read("src/sse/services/backgroundTokenRefresh.js")).toContain("isNeedsReauthCooling");
    expect(read("src/sse/services/codebuddyCheckin.js")).toContain("isNeedsReauthCooling");
  });

  it("the fixed English sentence is translated in both Chinese literal tables", () => {
    for (const rel of ["public/i18n/literals/zh-CN.json", "public/i18n/literals/zh-TW.json"]) {
      const table = JSON.parse(read(rel));
      expect(table["Needs re-auth"], rel).toBeTruthy();
      expect(table[NEEDS_REAUTH_MESSAGE], rel).toBeTruthy();
    }
  });
});
