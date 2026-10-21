import { describe, it, expect, vi, beforeEach } from "vitest";

import loomyCheckin, {
  runLoomyCheckin,
  LOOMY_ONBOARDING_TASKS,
  __resetLoomyCheckinState,
} from "../../src/sse/services/checkin/providers/loomy.js";

const DAY = "2026-10-22";
const CONN = { id: "loomy-conn-1", provider: "loomy", apiKey: "session-1" };

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ALL_DONE = Object.fromEntries(LOOMY_ONBOARDING_TASKS.map((task) => [task.key, true]));

function fetchSequence(responses) {
  const calls = [];
  const mock = vi.fn(async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch call: ${url}`);
    return next;
  });
  return { mock, calls };
}

describe("loomy check-in adapter", () => {
  beforeEach(() => {
    __resetLoomyCheckinState();
  });

  it("refreshes the daily grant and reports +5000 when no amount is returned", async () => {
    const { mock, calls } = fetchSequence([
      jsonResponse({ code: "000000", desc: "ok", data: {} }),
      jsonResponse({ code: "000000", data: { tasks: ALL_DONE } }),
    ]);

    const out = await loomyCheckin.run(CONN, { today: DAY, fetch: mock });

    expect(out).toMatchObject({ status: "ok", amount: 5000, unit: "积分" });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("/api/v1/points/first-login");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers.token).toBe("session-1");
    expect(calls[0].init.headers.Authorization).toBe("Bearer session-1");
    expect(calls[1].url).toContain("/api/v1/onboarding/tasks");
  });

  it("claims only unfinished onboarding tasks and adds their points", async () => {
    const { mock, calls } = fetchSequence([
      jsonResponse({ code: "000000", data: { amount: 5000 } }),
      jsonResponse({ code: "000000", data: { tasks: { ...ALL_DONE, first_message: false } } }),
      jsonResponse({ code: "000000", data: { alreadyCompleted: false } }),
    ]);

    const out = await loomyCheckin.run(CONN, { today: DAY, fetch: mock });

    expect(out).toMatchObject({ status: "ok", amount: 5500, unit: "积分" });
    const claimCall = calls.find((call) => call.url.includes("/onboarding/tasks/complete"));
    expect(claimCall).toBeTruthy();
    expect(claimCall.init.method).toBe("POST");
    expect(JSON.parse(claimCall.init.body)).toEqual({ key: "first_message" });
    expect(calls).toHaveLength(3);
  });

  it("reports already on a second run the same day without touching upstream", async () => {
    const first = fetchSequence([
      jsonResponse({ code: "000000", data: {} }),
      jsonResponse({ code: "000000", data: { tasks: ALL_DONE } }),
    ]);
    await loomyCheckin.run(CONN, { today: DAY, fetch: first.mock });

    const secondMock = vi.fn(async () => {
      throw new Error("second run must not call upstream");
    });
    const out = await loomyCheckin.run(CONN, { today: DAY, fetch: secondMock });

    expect(out).toMatchObject({ status: "already", amount: 0 });
    expect(secondMock).not.toHaveBeenCalled();
  });

  it("maps a 401 to needs-reauth and stops immediately", async () => {
    const { mock, calls } = fetchSequence([jsonResponse({ code: "100002" }, 401)]);

    const out = await loomyCheckin.run(CONN, { today: DAY, fetch: mock });

    expect(out.status).toBe("needs-reauth");
    expect(calls).toHaveLength(1);
  });

  it("maps a business-code 100002 with HTTP 200 to needs-reauth", async () => {
    const { mock } = fetchSequence([
      jsonResponse({ code: "100002", desc: "登录态已失效" }),
    ]);

    const out = await runLoomyCheckin(CONN, { fetch: mock });
    expect(out.status).toBe("needs-reauth");
  });
});
