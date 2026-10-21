import { describe, it, expect, vi } from "vitest";

import {
  beijingDayKey,
  claimRaccoonDaily,
  sumTodayGrantPoints,
} from "../../src/sse/services/checkin/providers/raccoon.js";

// 2026-10-20 12:00 Beijing (04:00 UTC) — fixed so the day key is deterministic.
const NOW = Date.UTC(2026, 9, 20, 4, 0, 0);
const DAY = "2026-10-20";
const CONN = { id: "conn-1", provider: "raccoon", apiKey: "fake-jwt" };

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

function balancePayload(available) {
  return {
    code: 0,
    data: {
      available_points: available,
      daily_points: available,
      monthly_points: 0,
      reward_points: 0,
      topup_points: 0,
      topup_frozen: 0,
    },
  };
}

function billsPayload(items) {
  return { code: 0, data: { items } };
}

const grantRow = (points) => ({
  points,
  created_at: `${DAY}T09:00:00+08:00`,
  event_name: "每日积分",
});

function fetchSequence(responses) {
  const calls = [];
  const mock = vi.fn(async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch call: ${url}`);
    return next;
  });
  return { mock, calls };
}

describe("raccoon check-in adapter", () => {
  it("reports ok with the real wallet delta when today's grant landed", async () => {
    const { mock, calls } = fetchSequence([
      jsonResponse(balancePayload(100)),
      jsonResponse({ code: 0, data: { point_grant_popups: [{ amount: 50 }] } }),
      jsonResponse(billsPayload([grantRow(50)])),
      jsonResponse(balancePayload(150)),
    ]);

    const out = await claimRaccoonDaily(CONN, { now: NOW, fetch: mock });

    expect(out).toMatchObject({
      status: "ok",
      amount: 50,
      unit: "积分",
      before: 100,
      after: 150,
    });
    expect(calls).toHaveLength(4);
    // claim order: balance snapshot -> grant trigger -> bills verification -> balance
    expect(calls[0].url).toContain("/api/web/points/v1/balance");
    expect(calls[1].url).toContain("/api/web/office/v3/setting_info");
    expect(calls[2].url).toContain("/api/web/points/v1/bills");
    expect(calls[3].url).toContain("/api/web/points/v1/balance");
    for (const call of calls) {
      expect(call.init.headers.Authorization).toMatch(/^Bearer /);
    }
    // Desktop identity headers are what make setting_info grant the points.
    expect(calls[1].init.headers["X-Client-Platform"]).toBe("desktop-windows");
    expect(calls[1].init.headers["X-Client-Version"]).toBe("v1.0.0");
  });

  it("reports already (not ok) when the wallet did not move but bills already have today's grant", async () => {
    const { mock } = fetchSequence([
      jsonResponse(balancePayload(150)),
      jsonResponse({ code: 0, data: {} }),
      jsonResponse(billsPayload([grantRow(50)])),
      jsonResponse(balancePayload(150)),
    ]);

    const out = await claimRaccoonDaily(CONN, { now: NOW, fetch: mock });

    expect(out.status).toBe("already");
    expect(out.amount).toBe(0);
    expect(out.before).toBe(150);
    expect(out.after).toBe(150);
  });

  it("reports no-activity when neither the wallet nor today's bills changed", async () => {
    const { mock } = fetchSequence([
      jsonResponse(balancePayload(150)),
      jsonResponse({ code: 0, data: {} }),
      jsonResponse(billsPayload([])),
      jsonResponse(balancePayload(150)),
    ]);

    const out = await claimRaccoonDaily(CONN, { now: NOW, fetch: mock });

    expect(out.status).toBe("no-activity");
    expect(out.amount).toBe(0);
    expect(out.unit).toBe("积分");
  });

  it("maps 401 to needs-reauth and stops before touching the grant trigger", async () => {
    const { mock, calls } = fetchSequence([jsonResponse({ message: "expired" }, 401)]);

    const out = await claimRaccoonDaily(CONN, { now: NOW, fetch: mock });

    expect(out.status).toBe("needs-reauth");
    expect(out.amount).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("maps 429 to limited and keeps the pre-claim wallet snapshot", async () => {
    const { mock, calls } = fetchSequence([
      jsonResponse(balancePayload(100)),
      jsonResponse({ message: "slow down" }, 429),
    ]);

    const out = await claimRaccoonDaily(CONN, { now: NOW, fetch: mock });

    expect(out.status).toBe("limited");
    expect(out.before).toBe(100);
    expect(out.amount).toBe(0);
    expect(calls).toHaveLength(2);
  });

  it("fails instead of claiming ok when the bills verification read fails", async () => {
    const { mock } = fetchSequence([
      jsonResponse(balancePayload(100)),
      jsonResponse({ code: 0, data: {} }),
      jsonResponse({ message: "boom" }, 500),
    ]);

    const out = await claimRaccoonDaily(CONN, { now: NOW, fetch: mock });

    expect(out.status).toBe("failed");
    expect(out.amount).toBe(0);
    expect(out.message).toMatch(/未能核对今日入账/);
  });

  it("falls back to today's bills when the wallet snapshot is unavailable", async () => {
    const { mock } = fetchSequence([
      jsonResponse({ message: "gateway down" }, 502),
      jsonResponse({ code: 0, data: {} }),
      jsonResponse(billsPayload([grantRow(30)])),
      jsonResponse({ message: "gateway down" }, 502),
    ]);

    const out = await claimRaccoonDaily(CONN, { now: NOW, fetch: mock });

    expect(out.status).toBe("ok");
    expect(out.amount).toBe(30);
    expect(out.before).toBeNull();
    expect(out.after).toBeNull();
  });

  it("dry-run never calls the grant trigger", async () => {
    const { mock, calls } = fetchSequence([
      jsonResponse(balancePayload(42)),
      jsonResponse(billsPayload([grantRow(20)])),
    ]);

    const out = await claimRaccoonDaily(CONN, { now: NOW, fetch: mock, dryRun: true });

    expect(out.status).toBe("already");
    expect(calls).toHaveLength(2);
    expect(calls.some((call) => call.url.includes("setting_info"))).toBe(false);
  });
});

describe("raccoon check-in helpers", () => {
  it("derives the natural day in Beijing time, not the machine timezone", () => {
    // 2026-10-20 23:30 UTC is already 2026-10-21 in Beijing.
    expect(beijingDayKey(Date.UTC(2026, 9, 20, 23, 30))).toBe("2026-10-21");
    expect(beijingDayKey(NOW)).toBe(DAY);
  });

  it("sums only positive rows created today", () => {
    const total = sumTodayGrantPoints(
      billsPayload([
        grantRow(20),
        grantRow(5),
        { points: -10, created_at: `${DAY}T10:00:00+08:00` },
        { points: 20, created_at: "2026-10-19T23:59:59+08:00" },
        { points: "15", created_at: `${DAY}T11:00:00+08:00` },
      ]),
      DAY
    );
    expect(total).toBe(40);
  });
});
