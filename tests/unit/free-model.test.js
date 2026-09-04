/**
 * Free-tier model detection + friendly rate-limit copy (open-sse/utils/freeModel.js).
 *
 * `isFreeModel` must be conservative: match clearly-free tokens in a model slug
 * (`contributor-free`, `-free`, `free/`) but never a paid model or a bare
 * "free" glued inside a normal word. `formatFreeRateLimitMessage` turns a 429
 * into a friendly, actionable Chinese message with an estimated wait when the
 * upstream supplied a reset time.
 */

import { describe, it, expect } from "vitest";

import {
  isFreeModel,
  formatFreeRateLimitMessage,
} from "../../open-sse/utils/freeModel.js";

describe("isFreeModel", () => {
  it("returns true for clearly-free model slugs", () => {
    expect(isFreeModel("oc/muse-spark-1.3-contributor-free")).toBe(true);
    expect(isFreeModel("oc/gemini-3-flash-free")).toBe(true);
    expect(isFreeModel("tokenrouter/z-ai/vision-free")).toBe(true);
    expect(isFreeModel("apinex/free/flash-lite")).toBe(true);
    expect(isFreeModel("apinex/free/chat")).toBe(true);
    expect(isFreeModel("some/freemium-model")).toBe(true);
  });

  it("returns false for paid / non-free models", () => {
    expect(isFreeModel("gemini-3.7-flash-high")).toBe(false);
    expect(isFreeModel("openai/gpt-5")).toBe(false);
    expect(isFreeModel("anthropic/claude-sonnet-4")).toBe(false);
    expect(isFreeModel("deepseek/deepseek-v4")).toBe(false);
    // bare "free" inside a normal word is not a tier marker
    expect(isFreeModel("myfreemodel")).toBe(false);
    expect(isFreeModel("freeform-chat")).toBe(false);
  });

  it("handles empty / non-string input defensively", () => {
    expect(isFreeModel(undefined)).toBe(false);
    expect(isFreeModel(null)).toBe(false);
    expect(isFreeModel("")).toBe(false);
    expect(isFreeModel(42)).toBe(false);
  });
});

describe("formatFreeRateLimitMessage", () => {
  it("suggests a general retry when no reset time is known", () => {
    const msg = formatFreeRateLimitMessage("oc", "muse-spark-1.3-contributor-free", null);
    expect(msg).toContain("限流");
    expect(msg).toContain("建议稍后再试");
    expect(msg).toContain("oc/muse-spark-1.3-contributor-free");
  });

  it("renders seconds when the wait is under a minute", () => {
    const msg = formatFreeRateLimitMessage("oc", "gemini-3-flash-free", 15000);
    expect(msg).toContain("约 15 秒后");
  });

  it("renders minutes for sub-hour waits", () => {
    const msg = formatFreeRateLimitMessage("oc", "gemini-3-flash-free", 90 * 1000);
    expect(msg).toContain("约 2 分钟后");
  });

  it("renders hours for long waits", () => {
    const msg = formatFreeRateLimitMessage("oc", "gemini-3-flash-free", 2 * 3600 * 1000);
    expect(msg).toContain("小时");
    expect(msg).toContain("2.0");
  });

  it("falls back to the general hint when a reset time is not positive", () => {
    expect(formatFreeRateLimitMessage("oc", "m", 0)).toContain("建议稍后再试");
    expect(formatFreeRateLimitMessage("oc", "m", -5000)).toContain("建议稍后再试");
    expect(formatFreeRateLimitMessage("oc", "m", NaN)).toContain("建议稍后再试");
  });
});
