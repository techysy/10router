/**
 * CodeBuddy CN auto daily check-in.
 *
 * Covers the pure response→status mapping, connection eligibility, the random
 * daily-slot delay, and a dep-injected tick that never touches the network or
 * DB (proxyAwareFetch / connections repo are stubbed out).
 */

import { describe, it, expect, vi } from "vitest";

import {
  isEligibleCbcnConnection,
  mapDailyCheckinStatus,
  msUntilNextSlot,
  runCodebuddyCheckinTick,
} from "../../src/sse/services/codebuddyCheckin.js";

// Build a fake unverified JWT whose payload carries the given claims.
function makeToken(claims) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.sig`;
}

// A connection whose access token is a CodeBuddy CN realm (Keycloak) token.
function cnConn(overrides = {}) {
  const token = makeToken({ iss: "https://www.codebuddy.cn/realms/codebuddy", sub: "uid-1" });
  return {
    id: "cb-1",
    provider: "codebuddy-cn",
    authType: "oauth",
    isActive: true,
    accessToken: token,
    refreshToken: "rt-1",
    name: "<account>", // placeholder — never a real name in committed fixtures
    ...overrides,
  };
}

describe("mapDailyCheckinStatus", () => {
  it("maps HTTP 2xx to checked-in", () => {
    expect(mapDailyCheckinStatus({ httpStatus: 200, code: 0, msg: "" })).toBe("checked-in");
    expect(mapDailyCheckinStatus({ httpStatus: 201, code: 0 })).toBe("checked-in");
  });

  it("maps HTTP 400 with code 10001 to already", () => {
    expect(mapDailyCheckinStatus({ httpStatus: 400, code: 10001 })).toBe("already");
    expect(mapDailyCheckinStatus({ httpStatus: 400, code: "10001" })).toBe("already");
  });

  it("maps HTTP 400 with an idempotent '已签到' message to already", () => {
    expect(mapDailyCheckinStatus({ httpStatus: 400, msg: "今天已签到，请明天再来" })).toBe("already");
    expect(mapDailyCheckinStatus({ httpStatus: 400, msg: "already checked in today" })).toBe("already");
  });

  it("maps HTTP 400 with any other code/message to failed", () => {
    expect(mapDailyCheckinStatus({ httpStatus: 400, code: 1234, msg: "bad request" })).toBe("failed");
    expect(mapDailyCheckinStatus({ httpStatus: 400, msg: "some other error" })).toBe("failed");
  });

  it("maps 401 and 5xx and unknown to failed", () => {
    expect(mapDailyCheckinStatus({ httpStatus: 401, msg: "unauthorized" })).toBe("failed");
    expect(mapDailyCheckinStatus({ httpStatus: 500 })).toBe("failed");
    expect(mapDailyCheckinStatus({})).toBe("failed");
  });
});

describe("isEligibleCbcnConnection", () => {
  it("is true for an active codebuddy-cn connection with a cn-issuer token", () => {
    expect(isEligibleCbcnConnection(cnConn())).toBe(true);
  });

  it("accepts the copilot.tencent.com realm", () => {
    const conn = cnConn({
      accessToken: makeToken({ iss: "https://copilot.tencent.com/realms/xyz", sub: "uid-2" }),
    });
    expect(isEligibleCbcnConnection(conn)).toBe(true);
  });

  it("rejects non-codebuddy-cn providers", () => {
    expect(isEligibleCbcnConnection(cnConn({ provider: "codebuddy-intl" }))).toBe(false);
  });

  it("rejects inactive connections", () => {
    expect(isEligibleCbcnConnection(cnConn({ isActive: false }))).toBe(false);
  });

  it("rejects a missing access token", () => {
    expect(isEligibleCbcnConnection(cnConn({ accessToken: null }))).toBe(false);
  });

  it("rejects a non-CodeBuddy issuer (workbuddy.cn realm)", () => {
    const conn = cnConn({
      accessToken: makeToken({ iss: "https://www.workbuddy.cn/realms/wb", sub: "uid-3" }),
    });
    expect(isEligibleCbcnConnection(conn)).toBe(false);
  });

  it("rejects a token without an issuer", () => {
    expect(isEligibleCbcnConnection(cnConn({ accessToken: "not-a-jwt" }))).toBe(false);
  });
});

describe("msUntilNextSlot", () => {
  it("returns a positive delay bounded within a 00-06 slot day (0, ~30h]", () => {
    const now = Date.parse("2026-09-04T10:00:00.000Z");
    const delay = msUntilNextSlot(now, () => 0);
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  it("is injectable and deterministic via rand=0.5", () => {
    const now = Date.parse("2026-09-04T00:10:00.000Z");
    const delay = msUntilNextSlot(now, () => 0.5);
    expect(delay).toBeGreaterThan(0);
  });
});

describe("runCodebuddyCheckinTick", () => {
  it("checks in only eligible connections and returns per-account statuses", async () => {
    const eligible = cnConn({ id: "cb-ok" });
    const otherProvider = cnConn({ id: "cb-intl", provider: "codebuddy-intl" });
    const inactive = cnConn({ id: "cb-off", isActive: false });

    const checkinConnection = vi.fn(async (conn) => {
      if (conn.id === "cb-ok") return { status: "checked-in" };
      return { status: "failed" };
    });
    const loadConnections = vi.fn(async () => [eligible, otherProvider, inactive]);

    const results = await runCodebuddyCheckinTick({ loadConnections, checkinConnection });

    expect(loadConnections).toHaveBeenCalledTimes(1);
    // Only the single eligible connection is checked in.
    expect(checkinConnection).toHaveBeenCalledTimes(1);
    expect(checkinConnection.mock.calls[0][0].id).toBe("cb-ok");
    expect(results).toEqual([
      { id: "cb-ok", name: "<account>", status: "checked-in" },
    ]);
  });

  it("fail-open: a throwing connection is reported as failed, not propagated", async () => {
    const loadConnections = vi.fn(async () => [cnConn({ id: "cb-1" }), cnConn({ id: "cb-2" })]);
    const checkinConnection = vi.fn(async (conn) => {
      if (conn.id === "cb-1") throw new Error("network boom");
      return { status: "already" };
    });

    const results = await runCodebuddyCheckinTick({ loadConnections, checkinConnection });

    expect(results).toHaveLength(2);
    const byId = Object.fromEntries(results.map((r) => [r.id, r.status]));
    expect(byId["cb-1"]).toBe("failed");
    expect(byId["cb-2"]).toBe("already");
  });

  it("fail-open: a load error yields an empty result array, never a throw", async () => {
    const loadConnections = vi.fn(async () => {
      throw new Error("db down");
    });
    const results = await runCodebuddyCheckinTick({ loadConnections });
    expect(results).toEqual([]);
  });

  it("returns [] when there are no eligible connections", async () => {
    const loadConnections = vi.fn(async () => [cnConn({ provider: "codebuddy-intl" })]);
    const results = await runCodebuddyCheckinTick({ loadConnections });
    expect(results).toEqual([]);
  });
});
