/** Audit-only: behavioral guard check for new sensitive paths (deleted after run). */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  nextResponse: Symbol("next"),
  jsonResponse: vi.fn((body, init) => ({ status: init?.status || 200, body })),
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
  getConsistentMachineId: vi.fn(),
  verifyDashboardAuthToken: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    next: vi.fn(() => mocks.nextResponse),
    json: mocks.jsonResponse,
    redirect: vi.fn((url) => ({ status: 307, url })),
  },
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  validateApiKey: mocks.validateApiKey,
}));
vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: mocks.getConsistentMachineId,
}));
vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardAuthToken: mocks.verifyDashboardAuthToken,
  // Steady state: a password exists, so the bootstrap-loopback rule stays off.
  isDashboardAuthConfigured: () => true,
}));

const { proxy } = await import("../../src/dashboardGuard.js");

const PEER = "peer-token-fixture";
function req(pathname, ip = "127.0.0.1", extra = {}) {
  return {
    nextUrl: { pathname, searchParams: new URL(`http://x${pathname}`).searchParams },
    headers: new Headers({ "x-10r-peer-token": PEER, "x-10r-real-ip": ip, host: "localhost:20128", ...extra }),
    cookies: { get: () => undefined },
    url: `http://localhost${pathname}`,
    method: "POST",
  };
}

describe("audit: guard behavior for new sensitive paths (requireLogin=false)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TENROUTER_PEER_TOKEN = PEER;
    mocks.getSettings.mockResolvedValue({ requireLogin: false });
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
  });

  it("transfer export/import: ALWAYS_PROTECTED — anonymous remote 401; local export passes to the route's own password re-auth", async () => {
    // Remote is 401 (not 403): transfer deliberately has NO local-only gate —
    // remote dashboards (NAS) use it with JWT/CLI credentials.
    for (const p of ["/api/oauth/transfer/export", "/api/oauth/transfer/import"]) {
      expect((await proxy(req(p, "10.0.0.5"))).status).toBe(401);
    }
    // Same-machine export on a requireLogin=false dashboard passes the GUARD —
    // the route still demands the dashboard password (verifyDashboardPassword)
    // before dumping anything, mirroring the import passphrase authorization.
    expect(await proxy(req("/api/oauth/transfer/export", "127.0.0.1"))).toBe(mocks.nextResponse);
  });

  it("transfer export: local-loopback exemptions do not extend to CSRF/tunnel/remote", async () => {
    const csrf = await proxy(req("/api/oauth/transfer/export", "127.0.0.1", { origin: "https://evil.example" }));
    expect(csrf.status).toBe(401);
    const viaProxy = await proxy(req("/api/oauth/transfer/export", "127.0.0.1", { "x-10r-via-proxy": "1" }));
    expect(viaProxy.status).toBe(401);
    expect((await proxy(req("/api/oauth/transfer/export", "10.0.0.5"))).status).toBe(401);
  });

  it("transfer import: same-machine request on a requireLogin=false dashboard passes (passphrase authorizes inside)", async () => {
    expect(await proxy(req("/api/oauth/transfer/import", "127.0.0.1"))).toBe(mocks.nextResponse);
    // Loopback peer but a cross-site Origin (CSRF) is not a local request.
    const csrf = await proxy(req("/api/oauth/transfer/import", "127.0.0.1", { origin: "https://evil.example" }));
    expect(csrf.status).toBe(401);
    // Arrived through a reverse proxy / tunnel: not local either.
    const viaProxy = await proxy(req("/api/oauth/transfer/import", "127.0.0.1", { "x-10r-via-proxy": "1" }));
    expect(viaProxy.status).toBe(401);
  });

  it("transfer import/export: local but requireLogin=true without a session stays 401", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    expect((await proxy(req("/api/oauth/transfer/import", "127.0.0.1"))).status).toBe(401);
    expect((await proxy(req("/api/oauth/transfer/export", "127.0.0.1"))).status).toBe(401);
  });

  it("transfer routes pass with CLI token", async () => {
    for (const p of ["/api/oauth/transfer/export", "/api/oauth/transfer/import"]) {
      for (const header of ["x-10r-cli-token", "x-9r-cli-token"]) {
        expect(await proxy(req(p, "10.0.0.5", { [header]: "cli-token" }))).toBe(mocks.nextResponse);
      }
    }
  });

  it("transfer export/import with an explicit dashboard password header passes the guard from anywhere (route re-auths it)", async () => {
    // Remote operator on a requireLogin=false NAS has no JWT by design; the
    // password header is the credential and the route's verifyDashboardPassword
    // is the real check. Mirrors the import-usage self-authenticating pattern.
    for (const p of ["/api/oauth/transfer/export", "/api/oauth/transfer/import"]) {
      expect(await proxy(req(p, "10.0.0.5", { "x-10r-password": "pw" }))).toBe(mocks.nextResponse);
      // legacy alias counts
      expect(await proxy(req(p, "10.0.0.5", { "x-9r-password": "pw" }))).toBe(mocks.nextResponse);
      // an empty header value is NOT a credential
      expect((await proxy(req(p, "10.0.0.5", { "x-10r-password": "" }))).status).toBe(401);
      // wrong method never passes
      expect((await proxy({ ...req(p, "10.0.0.5", { "x-10r-password": "pw" }), method: "GET" })).status).toBe(401);
    }
  });

  it("usage/quotas: GET with a valid virtual key passes from anywhere; no/invalid key stays 401", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.validateApiKey.mockImplementation(async (k) => k === "sk-good");
    const get = (ip, extra) => ({ ...req("/api/usage/quotas", ip, extra), method: "GET" });
    expect(await proxy(get("10.0.0.5", { authorization: "Bearer sk-good" }))).toBe(mocks.nextResponse);
    expect((await proxy(get("10.0.0.5", { authorization: "Bearer sk-bad" }))).status).toBe(401);
    expect((await proxy(get("10.0.0.5"))).status).toBe(401);
    // POST is not part of the key exemption
    const post = { ...req("/api/usage/quotas", "10.0.0.5", { authorization: "Bearer sk-good" }), method: "POST" };
    expect((await proxy(post)).status).toBe(401);
  });

  it("verify-password: public (like login) — reachable without auth, remote too", async () => {
    const r = await proxy(req("/api/auth/verify-password", "10.0.0.5"));
    expect(r).toBe(mocks.nextResponse);
  });

  it("custom-models bulk: requires auth (authed local passes via requireLogin=false catch-all — same as sibling single-item PUT)", async () => {
    const local = await proxy(req("/api/models/custom/bulk", "127.0.0.1"));
    expect(local).toBe(mocks.nextResponse); // same posture as single-item PUT /api/models/custom
  });
});

describe("audit: xiaomi desktop detection paths (same-machine bypass)", () => {
  it("auto-import: remote 403 (local-only); local on a requireLogin=false dashboard passes", async () => {
    expect((await proxy(req("/api/oauth/xiaomi-mimo/auto-import", "10.0.0.5"))).status).toBe(403);
    expect(await proxy(req("/api/oauth/xiaomi-mimo/auto-import", "127.0.0.1"))).toBe(mocks.nextResponse);
    const csrf = await proxy(req("/api/oauth/xiaomi-mimo/auto-import", "127.0.0.1", { origin: "https://evil.example" }));
    expect(csrf.status).toBe(403);
  });

  it("desktop status/kill: local passes; CSRF and remote stay 403 (local-only)", async () => {
    expect(await proxy(req("/api/oauth/xiaomi-mimo/desktop-status", "127.0.0.1"))).toBe(mocks.nextResponse);
    expect(await proxy(req("/api/oauth/xiaomi-mimo/desktop-kill", "127.0.0.1"))).toBe(mocks.nextResponse);
    const csrfKill = await proxy(req("/api/oauth/xiaomi-mimo/desktop-kill", "127.0.0.1", { origin: "https://evil.example" }));
    expect(csrfKill.status).toBe(403);
    expect((await proxy(req("/api/oauth/xiaomi-mimo/desktop-kill", "10.0.0.5"))).status).toBe(403);
  });

  it("desktop detection: requireLogin=true without a session stays 401", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    expect((await proxy(req("/api/oauth/xiaomi-mimo/auto-import", "127.0.0.1"))).status).toBe(403);
    expect((await proxy(req("/api/oauth/xiaomi-mimo/desktop-kill", "127.0.0.1"))).status).toBe(403);
  });
});
