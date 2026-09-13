/**
 * Night-free window boundary tests (codebuddy-cn hy4-preview, 23:00–08:00
 * local, wraps midnight). Pure-function pin — the badge logic itself is UI.
 */
import { describe, expect, it } from "vitest";
import { isNightFreeHour } from "../../src/shared/utils/nightFree.js";

describe("isNightFreeHour (23:00–08:00, wraps midnight)", () => {
  const W = { from: 23, to: 8 };

  it("night hours: 23,0–7 are free", () => {
    for (const h of [23, 0, 1, 7]) expect(isNightFreeHour(h, W)).toBe(true);
  });

  it("day hours: 8–22 are not free", () => {
    for (const h of [8, 9, 12, 17, 22]) expect(isNightFreeHour(h, W)).toBe(false);
  });

  it("boundary: from inclusive, to exclusive", () => {
    expect(isNightFreeHour(23, W)).toBe(true);
    expect(isNightFreeHour(22, W)).toBe(false);
    expect(isNightFreeHour(8, W)).toBe(false);
    expect(isNightFreeHour(7, W)).toBe(true);
  });

  it("same-day window (from<to) works too", () => {
    expect(isNightFreeHour(2, { from: 1, to: 5 })).toBe(true);
    expect(isNightFreeHour(5, { from: 1, to: 5 })).toBe(false);
  });

  it("no window / bad hour → false", () => {
    expect(isNightFreeHour(3, null)).toBe(false);
    expect(isNightFreeHour(NaN, W)).toBe(false);
  });
});
