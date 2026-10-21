// CodeBuddy international repeatedly missed CN-side registrations (the model
// catalog, the credit multipliers, and now the connection-test config). The
// visible symptom of the last one: the dashboard's Test button answered
// "Provider test not supported" for an otherwise healthy intl account.
//
// Routing was never affected. testSingleConnection() sends any non-apikey
// connection to testOAuthConnection(), which does
//
//   const config = OAUTH_TEST_CONFIG[connection.provider];
//   if (!config) return { valid: false, error: "Provider test not supported" };
//
// BEFORE any network call — so a missing key reads as a broken account while
// the account is fine.
//
// testUtils.js pulls the DB layer in at import time, so the route side is
// guarded with source-text assertions (this repo's convention for behaviour
// with no cheap import seam); the ProviderLimits side has a real seam —
// parseQuotaData — and is asserted behaviourally.
import { describe, expect, it } from "vitest";
import { parseQuotaData } from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

async function readSource(relPath) {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, relPath), "utf8");
}

const TEST_UTILS = "../../src/app/api/providers/[id]/test/testUtils.js";

describe("CodeBuddy intl is reachable from the dashboard's connection test", () => {
  it("registers both CodeBuddy variants in the WorkBuddy validator", async () => {
    const src = await readSource(TEST_UTILS);

    // Both variants of the same product must be registered together: adding one
    // without the other is precisely the regression this guards.
    expect(src).toMatch(
      /const WORKBUDDY_PROVIDERS = new Set\(\["codebuddy-cn", "codebuddy-intl"\]\)/
    );
    expect(src).toContain("testWorkbuddyConnection");
    const oauth = src.slice(
      src.indexOf("async function testOAuthConnection"),
      src.indexOf("async function testApiKeyConnection")
    );
    expect(oauth).toContain("WORKBUDDY_PROVIDERS.has(connection.provider)");
  });

  it("probes the .ai origin for intl and the Tencent origin for CN", async () => {
    const src = await readSource(TEST_UTILS);
    const start = src.indexOf("function workbuddyOrigin");
    const block = src.slice(start, src.indexOf("\n}", start));
    expect(block).toContain('provider === "codebuddy-intl"');
    expect(block).toContain("https://www.codebuddy.ai");
    expect(block).toContain("https://copilot.tencent.com");
  });

  it("keeps the verdict auth-only, so a streaming-only / catalogue miss is not a failure", async () => {
    const src = await readSource(TEST_UTILS);
    const start = src.indexOf("async function testWorkbuddyConnection");
    const block = src.slice(start, src.indexOf("// ─── Trae", start));
    // The intl gateway has no /v3/config and is stream-only; the billing probe
    // is the fallback. Only 401/403 may mark the credential broken.
    expect(block).toContain("/v3/config");
    expect(block).toContain("/v2/billing/meter/get-user-resource");
    expect(block).toContain("res.status === 401 || res.status === 403");
  });
});

describe("CodeBuddy intl usage limits keep the recurring flag", () => {
  it("forwards recurring for intl refill packs and bonus packs", () => {
    const data = {
      plan: "CodeBuddy",
      quotas: {
        Monthly: { used: 6.54, total: 500, resetAt: "2026-07-31T00:00:00Z", recurring: true },
        "Bonus Pack 1": { used: 12, total: 100, resetAt: "2026-07-15T00:00:00Z", recurring: false },
      },
    };

    const byName = Object.fromEntries(
      parseQuotaData("codebuddy-intl", data).map((q) => [q.name, q])
    );

    expect(byName["Monthly"].recurring).toBe(true);
    expect(byName["Bonus Pack 1"].recurring).toBe(false);
  });

  it("still defaults recurring to true when the flag is absent (back-compat)", () => {
    const data = { quotas: { Monthly: { used: 0, total: 100, resetAt: null } } };
    expect(parseQuotaData("codebuddy-intl", data)[0].recurring).toBe(true);
  });
});
