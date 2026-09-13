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
}));

const { proxy } = await import("../../src/dashboardGuard.js");

const PEER = "peer-token-fixture";
function req(pathname, ip = "127.0.0.1", extra = {}) {
  return {
    nextUrl: { pathname, searchParams: new URL(`http://x${pathname}`).searchParams },
    headers: new Headers({ "x-9r-peer-token": PEER, "x-9r-real-ip": ip, host: "localhost:20128", ...extra }),
    cookies: { get: () => undefined },
    url: `http://localhost${pathname}`,
    method: "POST",
  };
}

describe("audit: guard behavior for new sensitive paths (requireLogin=false)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NINEROUTER_PEER_TOKEN = PEER;
    mocks.getSettings.mockResolvedValue({ requireLogin: false });
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
  });

  it("transfer export/import: ALWAYS_PROTECTED — anonymous 401 both remote and local", async () => {
    // Remote is 401 (not 403): transfer deliberately has NO local-only gate —
    // remote dashboards (NAS) use it with JWT/CLI credentials.
    for (const p of ["/api/oauth/transfer/export", "/api/oauth/transfer/import"]) {
      expect((await proxy(req(p, "10.0.0.5"))).status).toBe(401);
      const local = await proxy(req(p, "127.0.0.1"));
      expect(local.status).toBe(401); // 免密 catch-all blocked by ALWAYS_PROTECTED
    }
  });

  it("transfer routes pass with CLI token", async () => {
    for (const p of ["/api/oauth/transfer/export", "/api/oauth/transfer/import"]) {
      const r = await proxy(req(p, "10.0.0.5", { "x-9r-cli-token": "cli-token" }));
      if (r !== mocks.nextResponse) {
        console.log("CLI_FAIL", p, JSON.stringify(r), "machineIdCalls:", JSON.stringify(mocks.getConsistentMachineId.mock.calls), "headerSeen:", new Headers(Object.entries({"x-9r-cli-token":"cli-token"})).get("x-9r-cli-token"));
      }
      expect(r).toBe(mocks.nextResponse);
    }
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
