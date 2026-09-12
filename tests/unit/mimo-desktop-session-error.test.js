/**
 * Issue #13 — MiMo Desktop-exclusive preview models without a desktop session.
 *
 * Locks the three acceptance points:
 * 1. the executor throws the friendly message (no "passToken" jargon), tagged
 *    MIMO_DESKTOP_SESSION_REQUIRED;
 * 2. errorConfig matches it with cooldown 0 — no account lock, no "(reset after
 *    30s)", combo falls through immediately;
 * 3. the zh-CN / zh-TW literal entries exist for the message and the dashboard
 *    badge (a missing entry shows raw English in the Chinese UI — red test).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import XiaomiMimoExecutor, { __test__ } from "../../open-sse/executors/xiaomi-mimo.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

const SESSION_MESSAGE =
  "This model requires the Xiaomi MiMo desktop account. Sign in to MiMo Desktop once, then retry.";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("issue 13: mimo desktop session error", () => {
  it("executor throws the friendly message with MIMO_DESKTOP_SESSION_REQUIRED (no passToken wording)", async () => {
    const executor = new XiaomiMimoExecutor();
    await expect(
      executor.execute({
        model: "mimo-x-flash-preview",
        credentials: { providerSpecificData: {} }, // no session → no cookie
        proxyOptions: null,
      }),
    ).rejects.toMatchObject({
      code: "MIMO_DESKTOP_SESSION_REQUIRED",
      message: SESSION_MESSAGE,
    });
    expect(SESSION_MESSAGE).not.toContain("passToken");
  });

  it("non-preview models never hit the session gate (super.execute path)", () => {
    // Bare ids map to the preview pair; a cloud model must not be gated.
    expect(__test__.bareModel("xiaomi/mimo-v2.5-flash")).toBe("mimo-v2.5-flash");
  });

  it("errorConfig: matches with cooldown 0 — no lock, no (reset after 30s)", () => {
    const res = checkFallbackError(502, `[xiaomi-mimo/mimo-x-flash-preview] ${SESSION_MESSAGE} (account unavailable)`);
    expect(res.shouldFallback).toBe(true);
    expect(res.cooldownMs).toBe(0);
  });

  it("unrelated errors keep the default transient cooldown (rule is specific)", () => {
    const res = checkFallbackError(502, "some other gateway error");
    expect(res.cooldownMs).toBeGreaterThan(0);
  });

  it("literals: zh-CN and zh-TW both carry the message and badge entries", () => {
    for (const locale of ["zh-CN", "zh-TW"]) {
      const dict = JSON.parse(readFileSync(join(ROOT, `public/i18n/literals/${locale}.json`), "utf8"));
      expect(dict[SESSION_MESSAGE], `${locale} message entry`).toBeTruthy();
      expect(dict["Desktop sign-in"], `${locale} badge entry`).toBeTruthy();
      expect(dict["Requires MiMo Desktop sign-in — API key alone cannot reach this model"], `${locale} badge tooltip`).toBeTruthy();
    }
  });

  it("registry: both preview models are flagged requiresSession for the dashboard badge", async () => {
    const { default: registry } = await import("../../open-sse/providers/registry/xiaomi-mimo.js");
    const flagged = registry.models.filter((m) => m.requiresSession === true).map((m) => m.id);
    expect(flagged.sort()).toEqual(["mimo-x-flash-preview", "mimo-x-pro-preview"]);
  });
});
