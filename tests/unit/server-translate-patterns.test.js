import { describe, expect, it } from "vitest";
import { serverTranslate } from "../../src/i18n/serverTranslate.js";

// Live pipeline string from Oxion 2026-10-24: the model-ping wraps the unwrapped
// upstream sentence in `[provider/model] [503]: … (reset after 30s)` — an exact
// dictionary key can never match, so the pattern layer rewrites in place.
const OXION_PIPELINE =
  "[oxion/gemini-3.7-flash] [503]: Our service is being upgraded right now and will be back to normal within a few minutes. Please retry shortly — your plan and balance are not affected. (reset after 30s)";

describe("serverTranslate — upstream pattern layer", () => {
  it("rewrites the Oxion upgrade sentence inside the pipeline string (zh-CN)", () => {
    const out = serverTranslate("zh-CN", OXION_PIPELINE);
    expect(out).toBe(
      "[oxion/gemini-3.7-flash] [503]: 上游正在升级维护，通常几分钟内恢复，稍后自动重试即可；套餐与余额不受影响。 (reset after 30s)"
    );
  });

  it("rewrites for zh-TW too", () => {
    const out = serverTranslate("zh-TW", OXION_PIPELINE);
    expect(out).toContain("上游正在升級維護");
    expect(out).toContain("(reset after 30s)");
  });

  it("passes through untouched for en and unknown locales", () => {
    expect(serverTranslate("en", OXION_PIPELINE)).toBe(OXION_PIPELINE);
    expect(serverTranslate("ja", OXION_PIPELINE)).toBe(OXION_PIPELINE);
  });

  it("repeated calls are stateful-safe (global-flag patterns reset between calls)", () => {
    const first = serverTranslate("zh-CN", "Service temporarily unavailable");
    const second = serverTranslate("zh-CN", "Service temporarily unavailable");
    expect(first).toBe("服务暂时不可用（上游维护或过载，稍后重试）");
    expect(second).toBe(first);
  });

  it("exact dictionary keys still win over patterns", () => {
    // 429 soft warning added by fd56b056 — an exact key that must keep working.
    expect(serverTranslate("zh-CN", "Model rate-limited (quota exhausted)")).toBe(
      "凭据正常；该模型额度已用尽，等待配额窗口重置"
    );
  });

  it("unknown text passes through byte-for-byte", () => {
    const raw = "[x/y] [503]: something entirely novel (reset after 5s)";
    expect(serverTranslate("zh-CN", raw)).toBe(raw);
  });

  it("null/empty input is returned as-is", () => {
    expect(serverTranslate("zh-CN", null)).toBe(null);
    expect(serverTranslate("zh-CN", "")).toBe("");
  });
});
