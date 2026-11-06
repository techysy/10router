// #97 定时自动更新「每周 + 周几」档的调度判定测试。
// 铁律：weekly 配了非法 weekday → 永不触发（显式坏掉，不静默回落 daily）。
import { describe, it, expect } from "vitest";
import lib from "../../fnos-packaging/cmd/dashboard-lib.js";

// 固定参照：2026-11-06 是周五（getDay()=5）
const at = (dayOffset, h, m) => {
  const d = new Date(2026, 10, 6 + dayOffset, h, m, 0, 0); // 月份 10 = 11 月
  return d.getTime();
};

describe("weekly schedule（定时更新每周档）", () => {
  it("周五配 weekday=5：周五槽点后触发", () => {
    const sched = { freq: "weekly", time: "10:00", weekday: 5 };
    expect(lib.shouldRunSchedule(sched, at(0, 10, 1), 0)).toBe(true);
    expect(lib.shouldRunSchedule(sched, at(0, 9, 59), 0)).toBe(false);
  });

  it("周五配 weekday=1（周一）：周五永不触发；周一槽点后触发", () => {
    const sched = { freq: "weekly", time: "10:00", weekday: 1 };
    expect(lib.shouldRunSchedule(sched, at(0, 11, 0), 0)).toBe(false);
    expect(lib.shouldRunSchedule(sched, at(3, 11, 0), 0)).toBe(true); // 下周一 = 11-09
  });

  it("本周已跑过不再触发（日期键去重）", () => {
    const sched = { freq: "weekly", time: "10:00", weekday: 5 };
    expect(lib.shouldRunSchedule(sched, at(0, 11, 0), at(0, 10, 1))).toBe(false);
    // 上周五跑过，本周五仍要跑
    expect(lib.shouldRunSchedule(sched, at(0, 11, 0), at(-7, 10, 1))).toBe(true);
  });

  it("非法 weekday（9 / undefined）永不触发，不回落 daily", () => {
    expect(lib.shouldRunSchedule({ freq: "weekly", time: "10:00", weekday: 9 }, at(0, 23, 0), 0)).toBe(false);
    expect(lib.shouldRunSchedule({ freq: "weekly", time: "10:00" }, at(0, 23, 0), 0)).toBe(false);
  });

  it("freq 非法回落 daily；normalizeSchedule 规范化", () => {
    expect(lib.normalizeSchedule({ freq: "monthly" })).toMatchObject({ freq: "daily" });
    expect(lib.normalizeSchedule({ freq: "weekly", time: "ab", weekday: 3 })).toMatchObject({ time: "04:30", weekday: 3 });
  });

  it("nextScheduleRunMs：今天已过槽点 → 下周同天；未到 → 今天", () => {
    const sched = { freq: "weekly", time: "10:00", weekday: 5 }; // 周五
    // 周五 11:00（已过）→ 下周五 10:00
    expect(lib.nextScheduleRunMs(sched, at(0, 11, 0))).toBe(at(7, 10, 0));
    // 周五 09:00（未到）→ 今天 10:00
    expect(lib.nextScheduleRunMs(sched, at(0, 9, 0))).toBe(at(0, 10, 0));
    // 非法 weekday → null
    expect(lib.nextScheduleRunMs({ freq: "weekly", time: "10:00" }, at(0, 9, 0))).toBeNull();
  });

  it("daily 档走 shouldRunSchedule 与旧 shouldRunDailySchedule 等价", () => {
    const sched = { freq: "daily", time: "10:00" };
    expect(lib.shouldRunSchedule(sched, at(0, 10, 1), 0)).toBe(lib.shouldRunDailySchedule("10:00", at(0, 10, 1), 0));
    expect(lib.shouldRunSchedule(sched, at(0, 9, 59), 0)).toBe(false);
  });
});
