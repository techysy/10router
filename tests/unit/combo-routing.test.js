import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

import { getRotatedModels, resetComboRotation, DEFAULT_COMBO_STICKY_WINDOW_MINUTES } from "../../open-sse/services/combo.js";

describe("combo round-robin routing", () => {
  beforeEach(() => {
    resetComboRotation();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sticks to one member by default (time-window sticky, no count cap)", () => {
    const models = ["provider/model-a", "provider/model-b"];

    const firstChoices = Array.from({ length: 4 }, () => (
      getRotatedModels(models, "code-xhigh", "round-robin")[0]
    ));

    // No count cap + window never expires (no idle gap within the same ms) —
    // every request pins to the first member.
    expect(firstChoices).toEqual([
      "provider/model-a",
      "provider/model-a",
      "provider/model-a",
      "provider/model-a",
    ]);
  });

  it("steps the ring after an idle gap beyond the window", () => {
    const models = ["provider/model-a", "provider/model-b", "provider/model-c"];

    expect(getRotatedModels(models, "grp", "round-robin")[0]).toBe("provider/model-a");

    // Idle past the default window (5 min) → exactly one step, however long the gap.
    vi.useFakeTimers();
    vi.advanceTimersByTime(DEFAULT_COMBO_STICKY_WINDOW_MINUTES * 60_000 + 1);
    expect(getRotatedModels(models, "grp", "round-robin")[0]).toBe("provider/model-b");

    // A long quiet stretch still steps only one member.
    vi.advanceTimersByTime(60 * 60_000);
    expect(getRotatedModels(models, "grp", "round-robin")[0]).toBe("provider/model-c");

    // Back to a within-window burst — stays.
    vi.advanceTimersByTime(30_000);
    expect(getRotatedModels(models, "grp", "round-robin")[0]).toBe("provider/model-c");
  });

  it("honors a per-combo window override", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "grp2", "round-robin", 0, 1)[0]).toBe("provider/model-a");

    vi.useFakeTimers();
    vi.advanceTimersByTime(90_000); // > 1 min override, < 5 min default
    expect(getRotatedModels(models, "grp2", "round-robin", 0, 1)[0]).toBe("provider/model-b");
  });

  it("still rotates per request when an explicit count cap is set", () => {
    const models = ["provider/model-a", "provider/model-b"];

    const firstChoices = Array.from({ length: 6 }, () => (
      getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]
    ));

    expect(firstChoices).toEqual([
      "provider/model-a",
      "provider/model-a",
      "provider/model-b",
      "provider/model-b",
      "provider/model-a",
      "provider/model-a",
    ]);
  });

  it("count cap switches members even inside the window", () => {
    const models = ["provider/model-a", "provider/model-b"];

    vi.useFakeTimers();
    getRotatedModels(models, "grp3", "round-robin", 2)[0];
    vi.advanceTimersByTime(1_000); // well inside any window
    expect(getRotatedModels(models, "grp3", "round-robin", 2)[0]).toBe("provider/model-a");
    vi.advanceTimersByTime(1_000);
    expect(getRotatedModels(models, "grp3", "round-robin", 2)[0]).toBe("provider/model-b");
  });

  it("tracks sticky rotation independently per combo", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-b");
    expect(getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]).toBe("provider/model-a");
  });

  it("does not rotate fallback combos", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "code-xhigh", "fallback", 2)).toEqual(models);
    expect(getRotatedModels(models, "code-xhigh", "fallback", 2)).toEqual(models);
  });
});
