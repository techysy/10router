/**
 * CodeArts welfare state machine: delivery -> claim -> confirm.
 *
 * The three behaviours pinned here are the ones that silently lose a day:
 *   · `CLAIMED` is non-terminal — confirm only, never re-claim;
 *   · `code:40001 未到权益刷新时间` arrives as HTTP 200 and is "not yet";
 *   · success requires re-reading delivery (claim/confirm `code:0` is only
 *     "accepted").
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/shared/codearts/client.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, codeArtsFetch: vi.fn() };
});

import { codeArtsFetch } from "../../open-sse/shared/codearts/client.js";
import { claimCodeArtsWelfare } from "../../src/sse/services/checkin/providers/codearts.js";

const NOW = Date.UTC(2026, 9, 20, 4, 0, 0);
const CONN = {
  id: "codearts-conn-1",
  provider: "codearts",
  providerSpecificData: {
    accessKeyId: "AK",
    secretAccessKey: "SK",
    securityToken: "STS",
    domainId: "dom",
  },
};

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function campaign(overrides = {}) {
  return {
    campaignId: "campaign-1",
    type: "USER_LOGIN",
    benefitUnit: "CREDIT",
    benefitAmount: 1000,
    claimable: true,
    status: "ENTRY",
    ...overrides,
  };
}

function queueFetch(responses) {
  const calls = [];
  codeArtsFetch.mockImplementation(async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET", body: options.body });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch: ${options.method || "GET"} ${url}`);
    return next;
  });
  return calls;
}

describe("codearts welfare", () => {
  beforeEach(() => {
    codeArtsFetch.mockReset();
  });

  it("runs delivery -> claim -> confirm -> delivery and only reports ok after re-read", async () => {
    const calls = queueFetch([
      json({ code: 0, data: { items: [campaign()] } }),
      json({ code: 0, data: { campaignId: "campaign-1" } }),
      json({ code: 0, data: { campaignId: "campaign-1" } }),
      json({ code: 0, data: { items: [campaign({ claimable: false, status: "CONFIRMED" })] } }),
    ]);

    const out = await claimCodeArtsWelfare({ ...CONN, id: "success-1" }, { now: NOW });

    expect(out.status).toBe("ok");
    expect(out.amount).toBe(1000);
    expect(calls.map((call) => call.method)).toEqual(["GET", "POST", "POST", "GET"]);
    expect(calls[0].url).toContain("/v1/ops/delivery");
    expect(calls[1].url).toContain("/v1/ops/claim");
    expect(calls[2].url).toContain("/v1/ops/confirm");
    expect(calls[3].url).toContain("/v1/ops/delivery");
    // Idempotency key travels with the claim and is not regenerated per attempt.
    expect(JSON.parse(calls[1].body)).toMatchObject({ campaignId: "campaign-1", channel: "IDE" });
    expect(JSON.parse(calls[1].body).idempotentKey).toMatch(/^claim_campaign-1_/);
  });

  it("skips claim when the campaign is already CLAIMED and only sends confirm", async () => {
    const calls = queueFetch([
      json({ code: 0, data: { items: [campaign({ claimable: false, status: "CLAIMED" })] } }),
      json({ code: 0, data: { campaignId: "campaign-1" } }),
      json({ code: 0, data: { items: [campaign({ claimable: false, status: "CONFIRMED" })] } }),
    ]);

    const out = await claimCodeArtsWelfare({ ...CONN, id: "claimed-1" }, { now: NOW });

    expect(out.status).toBe("ok");
    expect(calls).toHaveLength(3);
    expect(calls.some((call) => call.url.includes("/v1/ops/claim"))).toBe(false);
    expect(calls.filter((call) => call.url.includes("/v1/ops/confirm"))).toHaveLength(1);
  });

  it("treats HTTP 200 + code 40001 as no-activity and sends no write", async () => {
    const calls = queueFetch([
      json({ code: 40001, message: "未到权益刷新时间" }),
    ]);

    const out = await claimCodeArtsWelfare({ ...CONN, id: "not-yet-1" }, { now: NOW });

    expect(out.status).toBe("no-activity");
    expect(out.message).toContain("未到权益刷新时间");
    expect(calls).toHaveLength(1);
  });

  it("reports already when upstream says CONFIRMED and never writes", async () => {
    const calls = queueFetch([
      json({ code: 0, data: { items: [campaign({ claimable: false, status: "CONFIRMED" })] } }),
    ]);

    const out = await claimCodeArtsWelfare({ ...CONN, id: "already-1" }, { now: NOW });

    expect(out.status).toBe("already");
    expect(calls).toHaveLength(1);
  });

  it("reports needs-reauth on 401 and stops before the write", async () => {
    const calls = queueFetch([json({ code: 401 }, 401)]);

    const out = await claimCodeArtsWelfare({ ...CONN, id: "reauth-1" }, { now: NOW });

    expect(out.status).toBe("needs-reauth");
    expect(calls).toHaveLength(1);
  });

  it("does not report ok when the re-read still lacks CONFIRMED", async () => {
    queueFetch([
      json({ code: 0, data: { items: [campaign()] } }),
      json({ code: 0, data: { campaignId: "campaign-1" } }),
      json({ code: 0, data: { campaignId: "campaign-1" } }),
      json({ code: 0, data: { items: [campaign({ claimable: false, status: "CLAIMED" })] } }),
    ]);

    const out = await claimCodeArtsWelfare({ ...CONN, id: "unverified-1" }, { now: NOW });

    expect(out.status).toBe("failed");
    expect(out.message).toContain("尚未确认到账");
  });
});
