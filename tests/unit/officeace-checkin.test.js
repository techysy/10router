/**
 * OfficeAce check-in = one-shot bonus claim, verified by the subscription delta.
 *
 * Pins the rule from the integration plan §13: a 2xx from
 * `POST /v1/subscription/bonus/claim` is NOT success. Only a > 0 increase of
 * `points - current_value` per activity counts. Already-claimed and
 * no-activity are reported as-is; an unclaimed activity that did not move is a
 * failure.
 */
import { describe, expect, it, vi } from "vitest";

import adapter, {
  claimOfficeaceBonus,
  officeaceClaimOutcome,
} from "../../src/sse/services/checkin/providers/officeace.js";

const conn = {
  id: "c-oa-1",
  provider: "officeace",
  apiKey: "app-key:app-secret",
  isActive: true,
  providerSpecificData: {
    baseUrl: "https://modelgw-0004.example.com",
    accessKeyId: "AK",
    secretAccessKey: "SK",
    securityToken: "ST",
    projectId: "pid",
  },
};

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

const subscription = (bonusSku) => ({
  skus: [
    { sku_name: "套餐", quotas: [{ sku_attr_code: "officeace_points", sku_value: "1000", current_value: "100" }] },
  ],
  bonus_skus: bonusSku,
});

const bonus = (points, current) => ({
  activity_id: "newcomer-2026",
  activity_name: "新人礼",
  points,
  current_value: current,
});

describe("officeaceClaimOutcome", () => {
  it("counts the remaining-points increase as the amount", () => {
    const out = officeaceClaimOutcome(subscription([bonus("100", "100")]), subscription([bonus("200", "100")]));
    expect(out.status).toBe("ok");
    expect(out.amount).toBe(100);
  });

  it("treats a new activity as fully gained", () => {
    const out = officeaceClaimOutcome(subscription([]), subscription([bonus("500", "0")]));
    expect(out).toMatchObject({ status: "ok", amount: 500 });
  });

  it("reports already when activities exist but are exhausted", () => {
    const out = officeaceClaimOutcome(subscription([bonus("100", "100")]), subscription([bonus("100", "100")]));
    expect(out.status).toBe("already");
  });

  it("reports no-activity when there are no reward activities", () => {
    expect(officeaceClaimOutcome(subscription([]), subscription([])).status).toBe("no-activity");
  });

  it("is a failure, not success, when an unclaimed activity did not move", () => {
    const out = officeaceClaimOutcome(subscription([bonus("100", "0")]), subscription([bonus("100", "0")]));
    expect(out.status).toBe("failed");
  });

  it("never calls a missing before-snapshot a zero gain", () => {
    expect(officeaceClaimOutcome(null, subscription([bonus("100", "0")])).status).toBe("failed");
    expect(officeaceClaimOutcome(null, subscription([bonus("100", "100")])).status).toBe("already");
  });
});

describe("claimOfficeaceBonus", () => {
  it("reads subscription, claims with {}, reads again, and reports the delta", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(subscription([bonus("100", "100")])))
      .mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(response(subscription([bonus("200", "100")])));

    const out = await claimOfficeaceBonus(conn, { fetch: fetchMock });

    expect(out).toMatchObject({ status: "ok", amount: 100, unit: "积分", before: 0, after: 100 });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const [beforeUrl, beforeInit] = fetchMock.mock.calls[0];
    expect(beforeUrl).toBe("https://modelgw-0004.example.com/v1/subscription");
    expect(beforeInit.method).toBe("GET");
    expect(beforeInit.headers["x-subscription-type"]).toBe("v2");
    expect(beforeInit.headers.Authorization).toMatch(/^V11-HMAC-SHA256 Credential=AK\//);

    const [claimUrl, claimInit] = fetchMock.mock.calls[1];
    expect(claimUrl).toBe("https://modelgw-0004.example.com/v1/subscription/bonus/claim");
    expect(claimInit.method).toBe("POST");
    expect(claimInit.body).toBe("{}");
    expect(claimInit.headers["content-type"]).toBe("application/json");
    expect(claimInit.headers["x-subscription-type"]).toBe("v2");
    // The signature authorises the exact body that is sent.
    expect(claimInit.headers.Authorization).toMatch(/^V11-HMAC-SHA256 /);
    expect(JSON.stringify(out)).not.toContain("SK");
  });

  it("reports already without inventing an amount", async () => {
    const exhausted = subscription([bonus("100", "100")]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(exhausted))
      .mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(response(exhausted));

    const out = await claimOfficeaceBonus(conn, { fetch: fetchMock });
    expect(out).toMatchObject({ status: "already", amount: 0 });
  });

  it("reports no-activity when the account has no reward activities", async () => {
    const empty = subscription([]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(empty))
      .mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(response(empty));

    const out = await claimOfficeaceBonus(conn, { fetch: fetchMock });
    expect(out.status).toBe("no-activity");
  });

  it("still verifies when the claim call errors (idempotent upstream)", async () => {
    const before = subscription([bonus("100", "100")]);
    const after = subscription([bonus("300", "100")]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(before))
      .mockResolvedValueOnce(response("upstream hiccup", 500))
      .mockResolvedValueOnce(response(after));

    const out = await claimOfficeaceBonus(conn, { fetch: fetchMock });
    expect(out.status).toBe("ok");
    expect(out.amount).toBe(200);
    expect(out.message).toContain("领取请求异常");
  });

  it("maps 401 to needs-reauth and 429 to limited", async () => {
    const auth = await claimOfficeaceBonus(conn, {
      fetch: vi.fn().mockResolvedValueOnce(response({}, 401)),
    });
    expect(auth.status).toBe("needs-reauth");

    const limited = await claimOfficeaceBonus(conn, {
      fetch: vi.fn().mockResolvedValueOnce(response({}, 429)),
    });
    expect(limited.status).toBe("limited");
  });

  it("refuses a Basic-only connection without touching the network", async () => {
    const fetchMock = vi.fn();
    const out = await claimOfficeaceBonus(
      { ...conn, providerSpecificData: { baseUrl: "https://h" } },
      { fetch: fetchMock }
    );
    expect(out.status).toBe("needs-reauth");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not claim in dry-run", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response(subscription([bonus("100", "0")])));
    const out = await claimOfficeaceBonus(conn, { fetch: fetchMock, dryRun: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.amount).toBe(0);
  });
});

describe("adapter shape", () => {
  it("is a claim-cadence adapter with its own settings key", () => {
    expect(adapter).toMatchObject({
      id: "officeace",
      providers: ["officeace"],
      settingsKey: "officeaceCheckin",
      cadence: "claim",
    });
    expect(typeof adapter.run).toBe("function");
  });

  it("is registered with the check-in scheduler", async () => {
    const { getCheckinAdapters, CHECKIN_SETTING_KEYS } = await import(
      "../../src/sse/services/checkin/registry.js"
    );
    expect(getCheckinAdapters().map((a) => a.id)).toContain("officeace");
    expect(CHECKIN_SETTING_KEYS).toContain("officeaceCheckin");
  });
});
