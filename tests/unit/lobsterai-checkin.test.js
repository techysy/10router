import { describe, it, expect, vi, beforeEach } from "vitest";

import lobsteraiCheckin from "../../src/sse/services/checkin/providers/lobsterai.js";
import { resetClientVersionCache } from "../../open-sse/shared/lobsterai/client.js";

const VERSION_URL = "api-overmind.youdao.com";
const SLOT_URL = "/api/client-activities/slot";
const CONTEXT_URL = "/context?configRevision=";
const CHECKIN_URL = "/actions/check_in";
const PROFILE_URL = "/api/user/profile-summary";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const conn = { id: "lobster-1", provider: "lobsterai", accessToken: "at-1", isActive: true };

describe("lobsterai check-in adapter", () => {
  let balance;
  let calls;

  beforeEach(() => {
    vi.clearAllMocks();
    resetClientVersionCache();
    balance = 1000;
    calls = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init = {}) => {
        const target = String(url);
        calls.push({ url: target, method: init.method || "GET", body: init.body });

        if (target.includes(VERSION_URL)) {
          return jsonResponse({ data: { value: { version: "2026.10.1" } } });
        }
        if (target.includes(PROFILE_URL)) {
          return jsonResponse({ code: 0, data: { totalCreditsRemaining: balance } });
        }
        if (target.includes(SLOT_URL)) {
          return jsonResponse({
            code: 0,
            data: {
              slotState: "available",
              activity: { activityCode: "daily-checkin", configRevision: 12 },
            },
          });
        }
        if (target.includes(CONTEXT_URL)) {
          return jsonResponse({
            code: 0,
            data: { state: { claimedToday: false }, actions: ["view", "check_in"] },
          });
        }
        if (target.includes(CHECKIN_URL)) {
          balance += 100;
          return jsonResponse({ code: 0, data: { result: { creditsGranted: 100 } } });
        }
        return jsonResponse({ code: 0, data: {} });
      }),
    );
  });

  it("walks slot → context → actions/check_in and reports the balance delta", async () => {
    const outcome = await lobsteraiCheckin.run(conn, { dryRun: false, today: "2026-10-21" });

    expect(outcome.status).toBe("ok");
    expect(outcome.amount).toBe(100);
    expect(outcome.unit).toBe("积分");
    expect(outcome.before).toBe(1000);
    expect(outcome.after).toBe(1100);

    const checkinCall = calls.find((call) => call.url.includes(CHECKIN_URL));
    expect(checkinCall).toBeTruthy();
    expect(checkinCall.method).toBe("POST");
    const body = JSON.parse(checkinCall.body);
    expect(body.configRevision).toBe(12);
    expect(body.payload).toEqual({});
    expect(body.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("uses a fresh idempotency key on every run", async () => {
    await lobsteraiCheckin.run(conn, {});
    const firstKey = JSON.parse(calls.find((call) => call.url.includes(CHECKIN_URL)).body).idempotencyKey;

    calls = [];
    await lobsteraiCheckin.run(conn, {});
    const secondKey = JSON.parse(calls.find((call) => call.url.includes(CHECKIN_URL)).body).idempotencyKey;

    expect(firstKey).not.toBe(secondKey);
  });

  it("returns already when context says claimedToday, without calling check_in", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const target = String(url);
        calls.push({ url: target });
        if (target.includes(VERSION_URL)) {
          return jsonResponse({ data: { value: { version: "2026.10.1" } } });
        }
        if (target.includes(PROFILE_URL)) {
          return jsonResponse({ code: 0, data: { totalCreditsRemaining: balance } });
        }
        if (target.includes(SLOT_URL)) {
          return jsonResponse({
            code: 0,
            data: { slotState: "available", activity: { activityCode: "daily-checkin", configRevision: 12 } },
          });
        }
        if (target.includes(CONTEXT_URL)) {
          return jsonResponse({ code: 0, data: { state: { claimedToday: true }, actions: ["check_in"] } });
        }
        return jsonResponse({ code: 0, data: {} });
      }),
    );

    const outcome = await lobsteraiCheckin.run(conn, {});
    expect(outcome.status).toBe("already");
    expect(outcome.amount).toBe(0);
    expect(calls.some((call) => call.url.includes(CHECKIN_URL))).toBe(false);
  });

  it("returns no-activity when the slot has nothing to sign", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const target = String(url);
        if (target.includes(VERSION_URL)) {
          return jsonResponse({ data: { value: { version: "2026.10.1" } } });
        }
        if (target.includes(PROFILE_URL)) {
          return jsonResponse({ code: 0, data: { totalCreditsRemaining: balance } });
        }
        if (target.includes(SLOT_URL)) {
          return jsonResponse({ code: 0, data: { slotState: "empty", activity: null } });
        }
        return jsonResponse({ code: 0, data: {} });
      }),
    );

    const outcome = await lobsteraiCheckin.run(conn, {});
    expect(outcome.status).toBe("no-activity");
    expect(outcome.message).toContain("没有可签到的活动");
  });

  it("marks the connection needs-reauth on HTTP 401 instead of retrying as failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const target = String(url);
        if (target.includes(VERSION_URL)) {
          return jsonResponse({ data: { value: { version: "2026.10.1" } } });
        }
        if (target.includes(PROFILE_URL)) {
          return jsonResponse({ code: 0, data: { totalCreditsRemaining: balance } });
        }
        if (target.includes(SLOT_URL)) {
          return jsonResponse({ error: "unauthorized" }, 401);
        }
        return jsonResponse({ code: 0, data: {} });
      }),
    );

    const outcome = await lobsteraiCheckin.run(conn, {});
    expect(outcome.status).toBe("needs-reauth");
    expect(outcome.message).toContain("重新登录");
  });
});
