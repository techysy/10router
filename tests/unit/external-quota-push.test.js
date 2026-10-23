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
  filterClaimedExternalRows,
  findClaimedExternalRow,
  attachClaimRefreshUrls,
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

  it("keeps summarizesDetail so a pushed summary row stays out of the per-pack details", () => {
    const r = normalizeExternalQuotaPayload("cd", {
      quotas: {
        Balance: { used: 0, total: 32.88, name: "现金余额：¥ 0.00 · 赠送余额：¥ 32.88 (CNY)", summarizesDetail: true },
        Voucher: { used: 0, total: 32.88, name: "赠送余额 (CNY)", detailOnly: true },
      },
    });
    expect(r.ok).toBe(true);
    const byKey = Object.fromEntries(r.snapshot.entries.map((e) => [e.key, e]));
    expect(byKey.Balance.summarizesDetail).toBe(true);
    expect(byKey.Voucher.detailOnly).toBe(true);
  });

  it("keeps isCreditBalance so a pushed stored-value balance renders as one value, not X / Y", () => {
    const r = normalizeExternalQuotaPayload("cd", {
      quotas: { Balance: { used: 0, total: 25, name: "Balance (USD)", isCreditBalance: true, displayRemaining: true } },
    });
    expect(r.ok).toBe(true);
    expect(r.snapshot.entries[0].isCreditBalance).toBe(true);
  });

  it("keeps checkinToday / streakDays as read-only display fields (#77)", () => {
    const r = normalizeExternalQuotaPayload("cd", {
      provider: "minimax-code",
      quotas: {
        "MM账号": { used: 0, total: 88, displayRemaining: true, recurring: true, checkinToday: true, streakDays: 7 },
        other: { used: 0, total: 10, checkinToday: false },
      },
    });
    expect(r.ok).toBe(true);
    const byKey = Object.fromEntries(r.snapshot.entries.map((e) => [e.key, e]));
    expect(byKey["MM账号"].checkinToday).toBe(true);
    expect(byKey["MM账号"].streakDays).toBe(7);
    // false is a real value ("not signed in today"), kept distinct from absent
    expect(byKey.other.checkinToday).toBe(false);
    expect(byKey.other.streakDays).toBeUndefined();
  });

  it("drops malformed check-in fields without failing the push (#77 向后兼容)", () => {
    // Old CD payload: neither field at all → still a valid snapshot.
    const old = normalizeExternalQuotaPayload("cd", { quotas: { a: { used: 0, total: 32 } } });
    expect(old.ok).toBe(true);
    expect(old.snapshot.entries[0].checkinToday).toBeUndefined();

    // Non-boolean checkinToday / non-integer streakDays are dropped, not crashed on.
    const bad = normalizeExternalQuotaPayload("cd", {
      quotas: { a: { used: 0, total: 32, checkinToday: "yes", streakDays: 7.5 } },
    });
    expect(bad.ok).toBe(true);
    expect(bad.snapshot.entries[0].checkinToday).toBeUndefined();
    expect(bad.snapshot.entries[0].streakDays).toBeUndefined();
  });

  it("claims by same provider + name (alias matching): claimed rows leave the wall, the connection finds them", () => {
    const rows = [
      { id: "ext:river-a", provider: "river", name: "谷歌#1" },
      { id: "ext:mimo-a", provider: "xiaomi-mimo", name: "Xiaomi MiMo (UID: 6786673)" },
    ];
    const conns = [
      { id: "c1", provider: "river", name: " 谷歌#1 " },   // 去空格 + 忽略大小写也要认领
      { id: "c2", provider: "xiaomi-mimo", name: "test" }, // 不同名 → 不认领
    ];
    const left = filterClaimedExternalRows(conns, rows);
    expect(left.map((r) => r.id)).toEqual(["ext:mimo-a"]);
    expect(findClaimedExternalRow(conns[0], rows)?.id).toBe("ext:river-a");
    expect(findClaimedExternalRow(conns[1], rows)).toBeNull();
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

// LongCat via CreditDaddy (2026-10) pushed pack rows with the real numbers
// embedded in `name` while the numeric fields lied: used=0,
// remainingPercentage=100, total=REMAINING. The card read as a full pack.
// recoverUsedFromName repairs used/total from the name — only when the pushed
// numbers are absent or zero; an explicit used always wins.
describe("recoverUsedFromName — defensive repair of numbers-in-name pushes", () => {
  const push = (row) => normalizeExternalQuotaPayload("longcat-704460616", { quotas: { Pack1: row } });

  it("recovers used from '36%已消耗' when used=0 (real LongCat shape)", () => {
    const r = push({
      used: 0, total: 3175704, remainingPercentage: 100,
      name: "317.57 万 / 500 万 · 赠送 · 至 10-25 · 36%已消耗",
    });
    const e = r.snapshot.entries[0];
    // The remaining/total pair IS the numbers (5,000,000 − 3,175,700); the
    // trailing "36%已消耗" is the pusher's own rounding of the same fact.
    expect(e.used).toBeCloseTo(1_824_300, 0);
    // the name's total wins over the mis-pushed one (which was the remaining)
    expect(e.total).toBe(5_000_000);
    // stale percentage describing the broken shape is dropped
    expect(e.remainingPercentage).toBeUndefined();
  });

  it("recovers used from a '剩余 X / Y' remaining pair", () => {
    const r = push({ used: 0, total: 5000000, name: "剩余 317.57 万 / 500 万" });
    const e = r.snapshot.entries[0];
    expect(e.used).toBeCloseTo(1_824_300, 0);
  });

  it("recovers from a percent-consumed name even without 万 units", () => {
    const r = push({ used: 0, total: 100, name: "55 / 100 · 45% consumed" });
    expect(r.snapshot.entries[0].used).toBeCloseTo(45, 2);
  });

  it("never touches a row whose pushed used is already > 0", () => {
    const r = push({ used: 50, total: 100, name: "99%已消耗" });
    const e = r.snapshot.entries[0];
    expect(e.used).toBe(50);
    expect(e.total).toBe(100);
  });

  it("leaves names without any recognizable pattern untouched", () => {
    const r = push({ used: 0, total: 100, name: "赠送资源包" });
    const e = r.snapshot.entries[0];
    expect(e.used).toBe(0);
    expect(e.total).toBe(100);
  });

  it("does not modify the name itself", () => {
    const r = push({ used: 0, total: 3175704, name: "317.57 万 / 500 万 · 赠送 · 至 10-25 · 36%已消耗" });
    expect(r.snapshot.entries[0].name).toContain("36%已消耗");
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

describe("refreshUrl callback field (external cards only)", () => {
  it("accepts and persists an http(s) refreshUrl on the snapshot", () => {
    const url = "http://127.0.0.1:47860/api/quota-refresh?source=tokenharbor&exp=1893456000&sig=" + "a".repeat(64);
    const r = normalizeExternalQuotaPayload("tokenharbor", {
      provider: "tokenharbor",
      refreshUrl: url,
      quotas: { daily: { used: 1, total: 2 } },
    });
    expect(r.ok).toBe(true);
    expect(r.snapshot.refreshUrl).toBe(url);
  });

  it("drops an empty refreshUrl and leaves null on older pushes", () => {
    const r = normalizeExternalQuotaPayload("tokenharbor", {
      refreshUrl: "   ",
      quotas: { daily: { used: 1, total: 2 } },
    });
    expect(r.ok).toBe(true);
    expect(r.snapshot.refreshUrl).toBeNull();

    const r2 = normalizeExternalQuotaPayload("tokenharbor", { quotas: { daily: { used: 1, total: 2 } } });
    expect(r2.snapshot.refreshUrl).toBeNull();
  });

  it("rejects non-http refreshUrl and non-scalar refreshUrl", () => {
    // javascript: / data: URLs must never ride the whitelist
    expect(normalizeExternalQuotaPayload("tokenharbor", {
      refreshUrl: "javascript:alert(1)",
      quotas: { daily: { used: 1, total: 2 } },
    }).ok).toBe(false);
    expect(normalizeExternalQuotaPayload("tokenharbor", {
      refreshUrl: { url: "http://x" },
      quotas: { daily: { used: 1, total: 2 } },
    }).ok).toBe(false);
    expect(normalizeExternalQuotaPayload("tokenharbor", {
      refreshUrl: ["http://x"],
      quotas: { daily: { used: 1, total: 2 } },
    }).ok).toBe(false);
  });

  it("clips overlong refreshUrl instead of storing the world", () => {
    const r = normalizeExternalQuotaPayload("tokenharbor", {
      refreshUrl: "http://x/" + "a".repeat(2000),
      quotas: { daily: { used: 1, total: 2 } },
    });
    expect(r.ok).toBe(true);
    expect(r.snapshot.refreshUrl.length).toBeLessThanOrEqual(500);
  });

  it("mirrors the callback onto the claiming connection row (attachClaimRefreshUrls)", () => {
    // The bug this pins: a claimed push card (River 谷歌#1) disappears from the
    // wall and its numbers show on the CONNECTION card — but the connection
    // row carried no refreshUrl, so that card's button only re-read the local
    // snapshot and the pusher never got a re-measure POST.
    const rows = [
      { id: "ext:river-a", provider: "river", name: "谷歌#1", refreshUrl: "http://cd.local/refresh?sig=1" },
      { id: "ext:mimo-a", provider: "xiaomi-mimo", name: "mimo", refreshUrl: null },
    ];
    const conns = [
      { id: "c1", provider: "river", name: "谷歌#1" },
      { id: "c2", provider: "xiaomi-mimo", name: "mimo" },
      { id: "c3", provider: "river", name: "other" },
    ];
    attachClaimRefreshUrls(conns, rows);
    expect(conns[0].refreshUrl).toBe("http://cd.local/refresh?sig=1");
    // Claimed push without a callback (older pushes) → row stays without one.
    expect(conns[1].refreshUrl).toBeUndefined();
    expect(conns[2].refreshUrl).toBeUndefined();
  });

  it("accepts a LongCat token-pack push shaped for the official burn order", () => {
    // LongCat (2026-10 platform rules): gift packs burn BEFORE purchase packs
    // while the purchase pack is untouched; once the purchase pack starts
    // burning, ALL packs rank purely by expiry. 10Router does not simulate the
    // order (the platform deducts, we display) — the push just needs giftPack
    // flags and per-pack expiry through the whitelist intact.
    const r = normalizeExternalQuotaPayload("longcat", {
      provider: "longcat",
      label: "LongCat 资源包",
      refreshUrl: "http://127.0.0.1:47860/quota-refresh?source=longcat&sig=" + "b".repeat(64),
      quotas: {
        // Live gift pack: 353.28万 remaining of 500万, expires first
        "赠送资源包": {
          used: 146.72, total: 500, name: "Token 资源包（赠送）",
          resetAt: "2026-10-25T00:00:00Z", giftPack: true, detailOnly: true,
        },
        // Untouched 1000万 purchase pack expiring later
        "购买资源包": {
          used: 0, total: 1000, name: "1000万 Token（购买）",
          resetAt: "2026-11-11T00:00:00Z", detailOnly: true,
        },
      },
    });
    expect(r.ok).toBe(true);
    expect(r.snapshot.source).toBe("longcat");
    const byKey = Object.fromEntries(r.snapshot.entries.map((e) => [e.key, e]));
    expect(byKey["赠送资源包"].giftPack).toBe(true);
    expect(byKey["赠送资源包"].resetAt).toBe("2026-10-25T00:00:00Z");
    expect(byKey["购买资源包"].total).toBe(1000);
    expect(r.snapshot.refreshUrl).toMatch(/^http:/);
  });
});
