/**
 * Qoder token refresh.
 *
 * Device tokens refresh on the openapi host (unsigned):
 *   POST {openApiBaseUrl}/api/v1/deviceToken/refresh {"refresh_token": "..."}
 * PAT-derived job refresh tokens (`jrt-...`) use /api/v1/jobToken/refresh.
 * The old center `/algo/api/v3/user/refresh_token` endpoint is appcode-signed
 * and rejects unsigned device-token requests with 403 "Request discarded".
 *
 * Covers: success write-back, invalid_grant -> needs-reauth marker,
 * transient 5xx (no penalty), single-flight across concurrent callers,
 * PAT connections (nothing to refresh), needsRefresh lead, CN host, jrt- path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalFetch = global.fetch;

function silentLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function mockJson(payload, { ok = true, status = 200 } = {}) {
  const fn = vi.fn(async () => ({
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }));
  global.fetch = fn;
  return fn;
}

async function loadExecutor(providerId) {
  const { QoderExecutor } = await import("../../open-sse/executors/qoder.js");
  return providerId ? new QoderExecutor(providerId) : new QoderExecutor();
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

describe("Qoder refresh", () => {
  beforeEach(() => {
    vi.resetModules();
    global.fetch = originalFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("refreshes a device token on the openapi host and writes the rotated pair back", async () => {
    const expiresAt = new Date(Date.now() + THIRTY_DAYS_MS).toISOString();
    const fetchMock = mockJson({
      device_token: "dt-new",
      refresh_token: "drt-new",
      expires_at: expiresAt,
    });
    const log = silentLog();
    const executor = await loadExecutor();

    const result = await executor.refreshCredentials({
      refreshToken: "drt-old",
      providerSpecificData: { userId: "user-1" },
    }, log);

    expect(result.accessToken).toBe("dt-new");
    expect(result.refreshToken).toBe("drt-new");
    // Absolute expires_at -> expiresIn, which updateProviderCredentials turns
    // back into expiresAt.
    expect(result.expiresIn).toBeGreaterThan(29 * 24 * 60 * 60);
    expect(result.error).toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://openapi.qoder.sh/api/v1/deviceToken/refresh");
    expect(init.method).toBe("POST");
    // snake_case refresh_token, NOT the generic OAuth2 form/grant body.
    expect(JSON.parse(init.body)).toEqual({ refresh_token: "drt-old" });
    expect(init.headers["User-Agent"]).toBe("qoder-local-proxy");
  });

  it("never writes token material to the log", async () => {
    mockJson({
      device_token: "dt-secret-value",
      refresh_token: "drt-secret-value",
      expires_at: new Date(Date.now() + THIRTY_DAYS_MS).toISOString(),
    });
    const log = silentLog();
    const executor = await loadExecutor();

    await executor.refreshCredentials({ refreshToken: "drt-secret-value-old" }, log);

    const dumped = JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls]);
    expect(dumped).not.toContain("dt-secret-value");
    expect(dumped).not.toContain("drt-secret-value");
  });

  it("marks a 401 invalid_grant as unrecoverable (needs-reauth), not transient", async () => {
    mockJson({ error: "invalid_grant" }, { ok: false, status: 401 });
    const executor = await loadExecutor();
    const { isUnrecoverableRefreshError } = await import("../../open-sse/services/tokenRefresh.js");

    const result = await executor.refreshCredentials({ refreshToken: "drt-revoked" }, silentLog());

    expect(isUnrecoverableRefreshError(result)).toBe(true);
    expect(result.error).toBe("unrecoverable_refresh_error");
  });

  it("treats a 403 from the refresh endpoint as a dead refresh token", async () => {
    mockJson({ errorMessage: "Request discarded", errorCode: "Forbidden" }, { ok: false, status: 403 });
    const executor = await loadExecutor();
    const { isUnrecoverableRefreshError } = await import("../../open-sse/services/tokenRefresh.js");

    const result = await executor.refreshCredentials({ refreshToken: "drt-wrong-region" }, silentLog());

    expect(isUnrecoverableRefreshError(result)).toBe(true);
  });

  it("does not penalize the account on a transient 5xx", async () => {
    const fetchMock = mockJson({ message: "upstream unavailable" }, { ok: false, status: 503 });
    const log = silentLog();
    const executor = await loadExecutor();

    const result = await executor.refreshCredentials({ refreshToken: "drt-retry-me" }, log);

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalledWith(
      "TOKEN_REFRESH",
      expect.stringContaining("rejected"),
      expect.anything(),
    );
  });

  it("does not penalize the account on a 400 protocol drift either", async () => {
    mockJson({ message: "Bad request" }, { ok: false, status: 400 });
    const executor = await loadExecutor();
    const { isUnrecoverableRefreshError } = await import("../../open-sse/services/tokenRefresh.js");

    const result = await executor.refreshCredentials({ refreshToken: "drt-400" }, silentLog());

    expect(result).toBeNull();
    expect(isUnrecoverableRefreshError(result)).toBeFalsy();
  });

  it("single-flights concurrent refreshes for the same account", async () => {
    const fetchMock = mockJson({
      device_token: "dt-burst",
      refresh_token: "drt-burst-new",
      expires_at: new Date(Date.now() + THIRTY_DAYS_MS).toISOString(),
    });
    const executor = await loadExecutor();

    const credentials = { refreshToken: "drt-burst-old" };
    const [first, second] = await Promise.all([
      executor.refreshCredentials({ ...credentials }, silentLog()),
      executor.refreshCredentials({ ...credentials }, silentLog()),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.accessToken).toBe("dt-burst");
  });

  it("is wired into the shared provider dispatch (background proactive refresh)", async () => {
    const fetchMock = mockJson({
      device_token: "dt-bg",
      refresh_token: "drt-bg-new",
      expires_at: new Date(Date.now() + THIRTY_DAYS_MS).toISOString(),
    });
    const { refreshProviderCredentials } = await import("../../open-sse/services/oauthCredentialManager.js");

    const result = await refreshProviderCredentials("qoder", {
      connectionId: "qoder-bg",
      refreshToken: "drt-bg-old",
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      providerSpecificData: { userId: "user-bg" },
    }, silentLog());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.accessToken).toBe("dt-bg");
    expect(result.refreshToken).toBe("drt-bg-new");
    // mergeRefreshedCredentials turns expiresIn into an absolute expiresAt,
    // which is what selectConnectionsNeedingRefresh reads.
    expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000);
    expect(result.error).toBeUndefined();
  });

  it("treats PAT connections as not refreshable (job token is exchanged per request)", async () => {
    const fetchMock = mockJson({ device_token: "should-not-be-used" });
    const log = silentLog();
    const executor = await loadExecutor();

    const result = await executor.refreshCredentials({ apiKey: "pt-personal-token" }, log);

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    // No fabricated refresh, no re-auth mark: the PAT itself is still valid.
    expect(executor.needsRefresh({ apiKey: "pt-personal-token" })).toBe(false);
  });

  it("needsRefresh uses a 5-minute lead on expiresAt and skips tokens without a refresh_token", async () => {
    const executor = await loadExecutor();
    const soon = new Date(Date.now() + 2 * 60 * 1000).toISOString();
    const later = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    expect(executor.needsRefresh({
      accessToken: "dt-1",
      refreshToken: "drt-1",
      expiresAt: soon,
    })).toBe(true);

    expect(executor.needsRefresh({
      accessToken: "dt-1",
      refreshToken: "drt-1",
      expiresAt: later,
    })).toBe(false);

    // No refresh_token -> nothing to refresh, even when expiring.
    expect(executor.needsRefresh({ accessToken: "dt-1", expiresAt: soon })).toBe(false);
  });

  it("uses the CN openapi host for qoder-cn", async () => {
    const fetchMock = mockJson({
      device_token: "dt-cn",
      refresh_token: "drt-cn-new",
      expires_at: new Date(Date.now() + THIRTY_DAYS_MS).toISOString(),
    });
    const executor = await loadExecutor("qoder-cn");

    const result = await executor.refreshCredentials({ refreshToken: "drt-cn-old" }, silentLog());

    expect(result.accessToken).toBe("dt-cn");
    expect(fetchMock.mock.calls[0][0]).toBe("https://openapi.qoder.com.cn/api/v1/deviceToken/refresh");
  });

  it("routes jrt- job refresh tokens to the jobToken endpoint", async () => {
    const fetchMock = mockJson({
      token: "jt-new",
      refresh_token: "jrt-new",
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
    const executor = await loadExecutor();

    const result = await executor.refreshCredentials({ refreshToken: "jrt-old" }, silentLog());

    expect(result.accessToken).toBe("jt-new");
    expect(result.refreshToken).toBe("jrt-new");
    expect(fetchMock.mock.calls[0][0]).toBe("https://openapi.qoder.sh/api/v1/jobToken/refresh");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ refresh_token: "jrt-old" });
  });

  it("keeps the old refresh token when the response omits a new one", async () => {
    mockJson({
      device_token: "dt-kept",
      expires_at: new Date(Date.now() + THIRTY_DAYS_MS).toISOString(),
    });
    const executor = await loadExecutor();

    const result = await executor.refreshCredentials({ refreshToken: "drt-kept-old" }, silentLog());

    expect(result.accessToken).toBe("dt-kept");
    expect(result.refreshToken).toBe("drt-kept-old");
  });

  it("falls back to a 30-day lifetime when the response has no absolute expiry", async () => {
    // expires_in is deliberately ignored: it is milliseconds on the device
    // endpoint but seconds in other references — guessing writes a
    // multi-decade expiry and turns proactive refresh off forever.
    mockJson({ device_token: "dt-no-expiry", refresh_token: "drt-no-expiry", expires_in: 2591999994 });
    const executor = await loadExecutor();

    const result = await executor.refreshCredentials({ refreshToken: "drt-unknown" }, silentLog());

    expect(result.expiresIn).toBeGreaterThanOrEqual(29 * 24 * 60 * 60);
    expect(result.expiresIn).toBeLessThanOrEqual(31 * 24 * 60 * 60);
  });

  it("refuses to write a token pair that belongs to a different account", async () => {
    mockJson({
      device_token: "dt-other-account",
      refresh_token: "drt-other-account",
      user_id: "user-B",
      expires_at: new Date(Date.now() + THIRTY_DAYS_MS).toISOString(),
    });
    const log = silentLog();
    const executor = await loadExecutor();

    const result = await executor.refreshCredentials({
      refreshToken: "drt-user-a",
      providerSpecificData: { userId: "user-A" },
    }, log);

    expect(result).toBeNull();
    expect(log.error).toHaveBeenCalled();
  });
});
