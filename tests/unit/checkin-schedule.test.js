import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHECKIN_TIME,
  checkinTimeReached,
  nextCheckinDelay,
  normalizeCheckinTime,
} from "../../src/sse/services/checkin/schedule.js";

const at = (hour, minute = 0) => new Date(2026, 8, 12, hour, minute, 0, 0).getTime();

describe("check-in daily clock", () => {
  it("normalizes HH:mm and falls back instead of scheduling at an invalid time", () => {
    expect(normalizeCheckinTime("9:05")).toBe("09:05");
    expect(normalizeCheckinTime(" 23:59 ")).toBe("23:59");
    expect(normalizeCheckinTime("24:00")).toBe(DEFAULT_CHECKIN_TIME);
    expect(normalizeCheckinTime("nonsense")).toBe(DEFAULT_CHECKIN_TIME);
    expect(normalizeCheckinTime(undefined, "07:30")).toBe("07:30");
  });

  it("only opens the day at the configured minute", () => {
    expect(checkinTimeReached("09:00", at(8, 59))).toBe(false);
    expect(checkinTimeReached("09:00", at(9, 0))).toBe(true);
    expect(checkinTimeReached("09:00", at(9, 1))).toBe(true);
  });

  it("waits for today's time when it is still ahead", () => {
    const delay = nextCheckinDelay(at(8, 0), "09:00", {
      rand: () => 0,
      dailyJitterMs: 0,
    });
    expect(delay).toBe(60 * 60 * 1000);
  });

  it("falls into the ~2h retry cadence after the time has passed", () => {
    const delay = nextCheckinDelay(at(10, 0), "09:00", {
      rand: () => 0,
      retryMs: 2 * 60 * 60 * 1000,
      retryJitterMs: 0,
      dailyJitterMs: 0,
    });
    expect(delay).toBe(2 * 60 * 60 * 1000);
  });

  it("does not schedule a retry before tomorrow's configured time", () => {
    const delay = nextCheckinDelay(at(23, 30), "09:00", {
      rand: () => 0,
      retryJitterMs: 0,
      dailyJitterMs: 0,
    });
    expect(delay).toBe(9.5 * 60 * 60 * 1000);
  });

  it("adds the injectable jitter but never returns a non-positive delay", () => {
    const delay = nextCheckinDelay(at(8, 59), "09:00", {
      rand: () => 0.5,
      dailyJitterMs: 30_000,
    });
    expect(delay).toBe(60_000 + 15_000);
    expect(nextCheckinDelay(at(9, 0), "09:00", { rand: () => 0, dailyJitterMs: 0 })).toBeGreaterThan(0);
  });
});
