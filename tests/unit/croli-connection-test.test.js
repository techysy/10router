import { describe, expect, it, vi } from "vitest";
import { testCroliConnection } from "../../src/app/api/providers/[id]/test/croliConnection.js";

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("Croli connection test", () => {
  it.each([0, 1, 7800, "0", "7800"])("accepts a finite nonnegative balance (%s)", async (balance) => {
    const fetch = vi.fn(async () => response(200, { balance }));
    const result = await testCroliConnection({ accessToken: "fixture-token" }, null, fetch);
    expect(result).toMatchObject({ valid: true, error: null, refreshed: false });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toMatch(/\/credits\/v1\/account\/balance$/);
    expect(init).toMatchObject({ method: "GET", headers: { Authorization: "Bearer fixture-token" } });
    expect(init.body).toBeUndefined();
  });

  it.each([null, undefined, "", "abc", -1, true, {}, []])("rejects malformed balances (%s)", async (balance) => {
    const fetch = vi.fn(async () => response(200, { balance }));
    const result = await testCroliConnection({ accessToken: "fixture-token" }, null, fetch);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/invalid balance/i);
  });

  it("rejects a missing token without making a request", async () => {
    const fetch = vi.fn();
    const result = await testCroliConnection({ accessToken: " " }, null, fetch);
    expect(result).toMatchObject({ valid: false, error: "No access token" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([[401, "Token invalid or revoked"], [403, "Access denied"], [429, "Croli API returned 429"], [503, "Croli API returned 503"]])
    ("does not mark HTTP %i as connected", async (status, error) => {
      const result = await testCroliConnection({ accessToken: "fixture-token" }, null, async () => response(status, {}));
      expect(result).toMatchObject({ valid: false, error });
    });

  it("reports a bounded network failure", async () => {
    const result = await testCroliConnection({ accessToken: "fixture-token" }, null, async () => { throw Error("offline"); });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("offline");
    expect(result.error.length).toBeLessThan(220);
  });
});
