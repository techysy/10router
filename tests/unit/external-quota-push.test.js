// Generic external quota PUSH interface (CreditDaddy & successors):
//  - normalizeExternalQuotaPayload: whitelist/scalar-only display data
//  - POST/DELETE /api/external-quota/<source>: self-verifying route
//  - guard: virtual key / CLI token exception for the push prefix
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  nextResponse: Symbol("next"),
  jsonResponse: vi.fn((body, init) => ({ status: init?.status || 200, body })),
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
  getConsistentMachineId: vi.fn(),
  verifyDashboardAuthToken: vi.fn(),
  isDashboardAuthConfigured: vi.fn(() => true),
  save: vi.fn(),
  del: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    next: vi.fn(() => mocks.nextResponse),
    json: mocks.jsonResponse,
    redirect: vi.fn((url) => ({ status: 307, url })),
  },
}));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings, validateApiKey: mocks.validateApiKey }));
vi.mock("@/shared/utils/machineId", () => ({ getConsistentMachineId: mocks.getConsistentMachineId }));
vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardAuthToken: mocks.verifyDashboardAuthToken,
  isDashboardAuthConfigured: mocks.isDashboardAuthConfigured,
}));
vi.mock("@/lib/externalQuota", async (importOriginal) => ({
  ...(await importOriginal()),
  saveExternalQuotaSnapshot: mocks.save,
  deleteExternalQuotaSnapshot: mocks.del,
}));

// ─── 1) payload normalization (pure, from the real module) ──────────────────

const {
  normalizeExternalQuotaPayload,
  isValidExternalQuotaSource,
  externalQuotaSourceFromId,
} = await import("../../src/lib/externalQuota.js");

describe("external quota payload normalization", () => {
  it("accepts a clean quotas map", () => {
    const r = normalizeExternalQuotaPayload("tokenharbor", {
      provider: "tokenharbor",
      label: "TH free",
      plan: "free",
      pushedAt: "2026-10-12T00:00:00.000Z",
      quotas: {
        daily: { used: 1200, total: 5000, resetAt: "2026-10-13T00:00:00Z", remainingPercentage: 76 },
        weekly: { used: 0, total: 0, unlimited: true },
      },
    });
    expect(r.ok).toBe(true);
    expect(r.snapshot.source).toBe("tokenharbor");
    expect(r.snapshot.entries).toHaveLength(2);
    expect(r.snapshot.entries[0]).toMatchObject({ key: "daily", name: "daily", used: 1200, total: 5000, remainingPercentage: 76 });
    expect(r.snapshot.entries[1]).toMatchObject({ key: "weekly", unlimited: true });
    expect(r.snapshot.pushedAt).toBe("2026-10-12T00:00:00.000Z");
  });

  it("defaults provider to the source", () => {
    const r = normalizeExternalQuotaPayload("foo-bar1", { quotas: { a: { used: 1, total: 2 } } });
    expect(r.ok).toBe(true);
    expect(r.snapshot.provider).toBe("foo-bar1");
  });

  it("rejects bad source ids", () => {
    expect(isValidExternalQuotaSource("TokenHarbor")).toBe(false);
    expect(isValidExternalQuotaSource("-lead")).toBe(false);
    expect(isValidExternalQuotaSource("a".repeat(33))).toBe(false);
    expect(normalizeExternalQuotaPayload("a_b", { message: "x" }).ok).toBe(false);
  });

  it("refuses non-scalar values outright — this endpoint stores no structured data", () => {
    // The load-bearing security property: cookie/token material can never ride
    // in on a quota field, not even as a nested object someone "forgot".
    const r = normalizeExternalQuotaPayload("cd", {
      quotas: { daily: { used: 1, total: 2, cookie: { session: "secret" } } },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/scalar/);
  });

  it("drops unknown scalar fields instead of persisting them", () => {
    const r = normalizeExternalQuotaPayload("cd", {
      quotas: { daily: { used: 1, total: 2, authorization: "Bearer sk-sneaky", weirdo: "x" } },
    });
    expect(r.ok).toBe(true);
    const json = JSON.stringify(r.snapshot);
    expect(json).not.toMatch(/sneaky|weirdo|authorization/);
  });

  it("needs quotas or a message", () => {
    expect(normalizeExternalQuotaPayload("cd", { quotas: {} }).ok).toBe(false);
    expect(normalizeExternalQuotaPayload("cd", { message: "quota page down" }).ok).toBe(true);
    expect(normalizeExternalQuotaPayload("cd", {}).ok).toBe(false);
  });

  it("enforces entry and size caps", () => {
    const many = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${i}`, { used: 1, total: 2 }]));
    expect(normalizeExternalQuotaPayload("cd", { quotas: many }).ok).toBe(false);
    const big = { quotas: { daily: { used: 1, total: 2, name: "x".repeat(90) } } };
    // name over 80 chars is DROPPED (falls back to the key), not rejected —
    // but an oversized body is refused outright.
    expect(normalizeExternalQuotaPayload("cd", big).snapshot.entries[0].name).toBe("daily");
    const huge = { quotas: { daily: { used: 1, total: 2 } }, message: "y".repeat(70_000) };
    expect(normalizeExternalQuotaPayload("cd", huge).ok).toBe(false);
  });

  it("clamps a future pushedAt (clock skew must not extend the TTL)", () => {
    const far = Date.now() + 365 * 24 * 3600 * 1000;
    const r = normalizeExternalQuotaPayload("cd", { pushedAt: far, quotas: { a: { used: 1 } } });
    expect(Date.parse(r.snapshot.pushedAt)).toBeLessThan(Date.now() + 2 * 3600 * 1000);
  });

  it("maps source ids both ways", () => {
    expect(externalQuotaSourceFromId("ext:tokenharbor")).toBe("tokenharbor");
    expect(externalQuotaSourceFromId("ext:BAD_ID")).toBe(null);
    expect(externalQuotaSourceFromId("c1")).toBe(null);
  });
});

// ─── 2) route: auth-then-normalize-then-store, fail-soft ────────────────────

const { POST, DELETE } = await import("../../src/app/api/external-quota/[source]/route.js");

function routeReq(method, pathname, { headers = {}, cookie, body } = {}) {
  return {
    method,
    headers: new Headers(headers),
    cookies: { get: (n) => (n === "auth_token" && cookie ? { value: cookie } : undefined) },
    nextUrl: { pathname, searchParams: new URL(`http://x${pathname}`).searchParams },
    json: async () => body,
  };
}
const paramsFor = (source) => ({ params: Promise.resolve({ source }) });

describe("POST/DELETE /api/external-quota/[source]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateApiKey.mockImplementation(async (k) => k === "sk-good");
    mocks.getConsistentMachineId.mockResolvedValue("cli-token-value");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.save.mockResolvedValue(undefined);
    mocks.del.mockResolvedValue(true);
  });

  const payload = { quotas: { daily: { used: 1, total: 5 } } };

  it("stores a valid push authenticated by a virtual key", async () => {
    const res = await POST(
      routeReq("POST", "/api/external-quota/tokenharbor", { headers: { authorization: "Bearer sk-good" }, body: payload }),
      paramsFor("tokenharbor"),
    );
    expect(res.status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
      source: "tokenharbor",
      entries: [{ key: "daily", name: "daily", used: 1, total: 5 }],
    }));
  });

  it("accepts the CLI token header and a dashboard JWT", async () => {
    const cli = await POST(
      routeReq("POST", "/api/external-quota/cd", { headers: { "x-10r-cli-token": "cli-token-value" }, body: payload }),
      paramsFor("cd"),
    );
    expect(cli.status).toBe(200);
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);
    const jwt = await POST(
      routeReq("POST", "/api/external-quota/cd", { cookie: "jwt", body: payload }),
      paramsFor("cd"),
    );
    expect(jwt.status).toBe(200);
  });

  it("401s anonymous and unknown-key writers when login is required", async () => {
    const anon = await POST(routeReq("POST", "/api/external-quota/cd", { body: payload }), paramsFor("cd"));
    expect(anon.status).toBe(401);
    const bad = await POST(
      routeReq("POST", "/api/external-quota/cd", { headers: { authorization: "Bearer sk-wrong" }, body: payload }),
      paramsFor("cd"),
    );
    expect(bad.status).toBe(401);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("follows the dashboard LAN posture: requireLogin=false writes pass unauthenticated", async () => {
    // Exactly what every other dashboard write route does in LAN mode — the
    // quota page's own delete button runs without a cookie there.
    mocks.getSettings.mockResolvedValue({ requireLogin: false });
    const res = await POST(routeReq("POST", "/api/external-quota/cd", { body: payload }), paramsFor("cd"));
    expect(res.status).toBe(200);
  });

  it("400s an invalid source before doing anything else", async () => {
    const res = await POST(routeReq("POST", "/api/external-quota/BadSrc", { body: payload }), paramsFor("Bad Src"));
    expect(res.status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("400s an invalid payload with the normalization message", async () => {
    const res = await POST(
      routeReq("POST", "/api/external-quota/cd", { headers: { "x-api-key": "sk-good" }, body: { quotas: { a: { cookie: { c: 1 } } } } }),
      paramsFor("cd"),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/scalar/);
  });

  it("400s a non-JSON body without throwing", async () => {
    const bad = routeReq("POST", "/api/external-quota/cd", { headers: { authorization: "Bearer sk-good" } });
    bad.json = async () => { throw new SyntaxError("nope"); };
    const res = await POST(bad, paramsFor("cd"));
    expect(res.status).toBe(400);
  });

  it("DELETE clears by source and needs auth too", async () => {
    const anon = await DELETE(routeReq("DELETE", "/api/external-quota/cd"), paramsFor("cd"));
    expect(anon.status).toBe(401);
    const res = await DELETE(
      routeReq("DELETE", "/api/external-quota/cd", { headers: { authorization: "Bearer sk-good" } }),
      paramsFor("cd"),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, removed: true });
    expect(mocks.del).toHaveBeenCalledWith("cd");
  });
});

// ─── 3) guard: the push-prefix exception ────────────────────────────────────

const { proxy } = await import("../../src/dashboardGuard.js");

function guardReq(method, pathname, headers = {}) {
  return {
    method,
    nextUrl: { pathname, searchParams: new URL(`http://router.example.com${pathname}`).searchParams },
    headers: new Headers({ host: "router.example.com", ...headers }),
    cookies: { get: vi.fn(() => undefined) },
    url: `http://router.example.com${pathname}`,
  };
}
const withKey = (key = "sk-good") => ({ authorization: `Bearer ${key}` });

describe("dashboard guard: external-quota push exception", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TENROUTER_PEER_TOKEN = "peer-token-fixture";
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.validateApiKey.mockImplementation(async (k) => k === "sk-good");
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
  });

  it("passes remote POST with a virtual key (CD's route)", async () => {
    expect(await proxy(guardReq("POST", "/api/external-quota/tokenharbor", withKey()))).toBe(mocks.nextResponse);
  });

  it("passes POST with the CLI token", async () => {
    expect(await proxy(guardReq("POST", "/api/external-quota/cd", { "x-10r-cli-token": "cli-token" }))).toBe(mocks.nextResponse);
  });

  it("passes DELETE with a virtual key", async () => {
    expect(await proxy(guardReq("DELETE", "/api/external-quota/cd", withKey()))).toBe(mocks.nextResponse);
  });

  it("denies an unauthenticated remote POST when login is required", async () => {
    const res = await proxy(guardReq("POST", "/api/external-quota/cd"));
    expect(res.status).toBe(401);
  });

  it("keeps GET on the prefix behind normal auth (the route has no GET)", async () => {
    const res = await proxy(guardReq("GET", "/api/external-quota/cd", withKey()));
    expect(res.status).toBe(401);
  });
});
