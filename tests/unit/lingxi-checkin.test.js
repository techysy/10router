import { describe, expect, it } from "vitest";
import {
  DAILY_CHECK_IN_KEY,
  fetchLingxiTasks,
  lingxiDailyCheckin,
  localDayKey,
} from "../../open-sse/services/lingxiCheckin.js";

// 任务面板响应（CreditDaddy #53 实测口径）：daily_check_in 的 status /
// reward_amount / extra.check_in_days[] 逐日 claimed。
const tasksPayload = (daily) =>
  JSON.stringify({ result: "ok", data: { tasks: [daily, { task_key: "other_task", status: "available" }] } });

const dailyTask = (over = {}) => ({
  task_key: DAILY_CHECK_IN_KEY,
  status: "available",
  reward_amount: 100,
  extra: {
    check_in_days: [
      { claimed: true, reward: 100 },
      { claimed: true, reward: 100 },
      { claimed: false, reward: 100 },
    ],
  },
  ...over,
});

// Node 的 Response 带 ok/status；claim 分支读 res.ok —— mock 必须同形
const jsonResponse = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

describe("lingxi localDayKey", () => {
  it("formats the local calendar day (claim 的 date 参数口径)", () => {
    expect(localDayKey(new Date(2026, 10, 15, 23, 59))).toBe("2026-11-15");
  });
});

describe("lingxi fetchLingxiTasks", () => {
  it("parses daily task state, streak and day reward", async () => {
    const out = await fetchLingxiTasks("c", {
      fetchImpl: async () => jsonResponse(200, tasksPayload(dailyTask())),
    });
    expect(out.auth).toBe(true);
    expect(out.checkedIn).toBe(false);
    expect(out.reward).toBe(100);
    // 连签 2 天 → 当日奖励 = 本轮第 2 天（下标 2）的 reward
    expect(out.streakDays).toBe(2);
    expect(out.dayReward).toBe(100);
  });

  it("marks claimed when the daily task status is claimed", async () => {
    const out = await fetchLingxiTasks("c", {
      fetchImpl: async () => jsonResponse(200, tasksPayload(dailyTask({ status: "claimed" }))),
    });
    expect(out.checkedIn).toBe(true);
  });

  it("treats 401 / UserUnauthorized / missing tasks as auth failure", async () => {
    for (const responder of [
      async () => jsonResponse(401, {}),
      async () => jsonResponse(200, '{"result":"UserUnauthorized"}'),
      async () => jsonResponse(200, '{"result":"ok","data":{}}'),
      async () => jsonResponse(200, "not-json"),
    ]) {
      const out = await fetchLingxiTasks("c", { fetchImpl: responder });
      expect(out.auth).toBe(false);
    }
  });
});

describe("lingxi lingxiDailyCheckin", () => {
  it("fails fast without a cookie", async () => {
    const out = await lingxiDailyCheckin({ cookie: "  " });
    expect(out.status).toBe("failed");
  });

  it("returns already WITHOUT posting claim when the task is claimed", async () => {
    let posted = 0;
    const fetchImpl = async (url, opts = {}) => {
      if (String(url).includes("/claim")) posted += 1;
      return jsonResponse(200, tasksPayload(dailyTask({ status: "claimed" })));
    };
    const out = await lingxiDailyCheckin({ cookie: "c", fetchImpl });
    expect(out.status).toBe("already");
    expect(posted).toBe(0);
    expect(out.claimedAmount).toBe(0);
    expect(out.message).toContain("今日已签到");
  });

  it("claims when available and reports the day reward (never the cycle total)", async () => {
    const calls = [];
    const fetchImpl = async (url, opts = {}) => {
      calls.push({ url: String(url), method: opts.method || "GET" });
      if (String(url).includes("/claim")) {
        return jsonResponse(200, { result: "ok", data: { total_claimed_credits: 300 } });
      }
      return jsonResponse(200, tasksPayload(dailyTask()));
    };
    const out = await lingxiDailyCheckin({ cookie: "c", fetchImpl });
    expect(out.status).toBe("checked-in");
    // 连签第 3 天 claim 回 total_claimed_credits=300（周期累计），当日额是 100
    expect(out.claimedAmount).toBe(100);
    expect(out.message).toContain("+100");
    expect(calls.some((c) => c.method === "POST" && c.url.includes(`date=${localDayKey()}`))).toBe(true);
  });

  it("surfaces an explicit server rejection as failed", async () => {
    const fetchImpl = async (url) => {
      if (String(url).includes("/claim")) return jsonResponse(200, { result: "err", code: "RISK_CONTROL", message: "操作过于频繁" });
      return jsonResponse(200, tasksPayload(dailyTask()));
    };
    const out = await lingxiDailyCheckin({ cookie: "c", fetchImpl });
    expect(out.status).toBe("failed");
    expect(out.message).toContain("灵犀签到被拒");
  });

  it("maps a claim auth failure to the re-capture message", async () => {
    const fetchImpl = async (url) => {
      if (String(url).includes("/claim")) return jsonResponse(401, {});
      return jsonResponse(200, tasksPayload(dailyTask()));
    };
    const out = await lingxiDailyCheckin({ cookie: "c", fetchImpl });
    expect(out.status).toBe("failed");
    expect(out.message).toContain("重新捕获");
  });
});
