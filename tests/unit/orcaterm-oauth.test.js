import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { ORCATERM_CONFIG } from "../../open-sse/config/orcaterm.js";
import { POST } from "../../src/app/api/oauth/orcaterm/[action]/route.js";
import { cancelOrcaTermLoginSession } from "../../src/lib/oauth/orcatermSessions.js";

const db = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/db/index.js", () => ({
  createProviderConnection: db.create,
  getProviderConnections: db.list,
  updateProviderConnection: db.update,
}));
vi.mock("next/server", () => ({
  NextResponse: { json: (body, init) => Response.json(body, init) },
}));
vi.mock("../../open-sse/utils/proxyFetch.js", async (original) => ({
  ...await original(), proxyAwareFetch: vi.fn(),
}));

const sessions = [];
const token = () => `e30.${Buffer.from(JSON.stringify({
  userId: "wechat-user", providerUsername: "Orca user", exp: Math.floor(Date.now() / 1000) + 7200,
})).toString("base64url")}.private-signature`;
const config = () => ({ code: 0, data: {
  appid: "wx-test", state: `state-${sessions.length}`, scope: "snsapi_login", redirect_uri: ORCATERM_CONFIG.bridgeUrl,
} });
const request = (action, body = {}, headers = {}) => POST(new Request(`http://localhost/api/oauth/orcaterm/${action}`, {
  method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
}), { params: Promise.resolve({ action }) });
const requestFromIp = (action, ip, body = {}) => POST(new Request(`http://localhost/api/oauth/orcaterm/${action}`, {
  method: "POST", headers: {
    "Content-Type": "application/json", "x-10r-real-ip": ip, "x-10r-peer-token": "test-peer-token",
  }, body: JSON.stringify(body),
}), { params: Promise.resolve({ action }) });
async function authorize() {
  const response = await request("authorize");
  expect(response.status).toBe(200);
  const session = await response.json();
  sessions.push(session);
  return session;
}

beforeEach(() => {
  vi.mocked(proxyAwareFetch).mockReset().mockImplementation(async (url) => {
    if (url === ORCATERM_CONFIG.wechatConfigUrl) return Response.json(config());
    if (url === ORCATERM_CONFIG.exchangeUrl) return Response.json({ code: 0, data: { accessToken: token() } });
    throw new Error("Unexpected upstream request");
  });
  db.list.mockReset().mockResolvedValue([]);
  db.create.mockReset().mockImplementation(async (data) => ({ id: "created-connection", ...data }));
  db.update.mockReset().mockImplementation(async (id, data) => ({ id, name: "Existing account", ...data }));
});
afterEach(() => {
  for (const session of sessions.splice(0)) cancelOrcaTermLoginSession(session.sessionId);
  vi.useRealTimers();
});

describe("OrcaTerm OAuth endpoint", () => {
  beforeEach(() => { process.env.TENROUTER_PEER_TOKEN = "test-peer-token"; });
  afterEach(() => { delete process.env.TENROUTER_PEER_TOKEN; });

  it("keeps access and renewal credentials server-side", async () => {
    const session = await authorize();
    expect(session).not.toHaveProperty("accessToken");
    const response = await request("exchange", { ...session, code: "wechat-code" });
    expect(response.status).toBe(200);
    expect(db.create).toHaveBeenCalledWith(expect.objectContaining({
      provider: "orcaterm", authType: "oauth", accessToken: token(), refreshToken: token(),
      providerSpecificData: { userId: "wechat-user", loginMethod: "wechat" }, testStatus: "unknown",
    }));
    const text = await response.text();
    expect(text).toContain("created-connection");
    expect(text).not.toContain("private-signature");
    expect(text).not.toContain("accessToken");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects mismatched state before any code exchange and permits the valid callback", async () => {
    const session = await authorize();
    const rejected = await request("exchange", { ...session, state: "attacker-state", code: "code" });
    expect(rejected.status).toBe(400);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(db.create).not.toHaveBeenCalled();
    expect((await request("exchange", { ...session, code: "legitimate-code" })).status).toBe(200);
  });

  it("consumes a grant once, even if callbacks arrive concurrently", async () => {
    const session = await authorize();
    let release;
    vi.mocked(proxyAwareFetch).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const first = request("exchange", { ...session, code: "same-code" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await request("exchange", { ...session, code: "same-code" });
    expect(second.status).toBe(400);
    release(Response.json({ code: 0, data: { accessToken: token() } }));
    expect((await first).status).toBe(200);
    expect(db.create).toHaveBeenCalledTimes(1);
  });

  it("rejects expired and cancelled sessions without exchanging a code", async () => {
    vi.useFakeTimers();
    const expired = await authorize();
    vi.advanceTimersByTime(ORCATERM_CONFIG.loginTtlMs + 1);
    expect((await request("exchange", { ...expired, code: "code" })).status).toBe(400);
    const cancelled = await authorize();
    expect((await request("cancel", cancelled)).status).toBe(200);
    expect((await request("exchange", { ...cancelled, code: "code" })).status).toBe(400);
    expect(db.create).not.toHaveBeenCalled();
  });

  it("re-authorizes the matching account without destroying name, priority or provider metadata", async () => {
    db.list.mockResolvedValue([{
      id: "existing", authType: "oauth", name: "My account", priority: 7,
      providerSpecificData: { userId: "wechat-user", customSetting: true },
    }]);
    const session = await authorize();
    expect((await request("exchange", { ...session, code: "new-code" })).status).toBe(200);
    expect(db.create).not.toHaveBeenCalled();
    expect(db.update).toHaveBeenCalledWith("existing", expect.objectContaining({
      resetErrorState: true,
      providerSpecificData: { userId: "wechat-user", customSetting: true, loginMethod: "wechat" },
    }));
    expect(db.update.mock.calls[0][1]).not.toHaveProperty("priority");
    expect(db.update.mock.calls[0][1]).not.toHaveProperty("name");
  });

  it("refuses form and cross-site requests rather than weakening the dashboard guard", async () => {
    expect((await request("authorize", {}, { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await request("authorize", {}, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("enforces the request-body limit while reading, including without Content-Length", async () => {
    const body = JSON.stringify({ sessionId: "x", padding: "x".repeat(ORCATERM_CONFIG.loginBodyMaxBytes + 1) });
    const response = await request("authorize", JSON.parse(body));
    expect(response.status).toBe(413);
    expect(proxyAwareFetch).not.toHaveBeenCalled();

    const streamingRequest = new Request("http://localhost/api/oauth/orcaterm/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"padding":"'));
          controller.enqueue(new Uint8Array(ORCATERM_CONFIG.loginBodyMaxBytes).fill(120));
          controller.close();
        },
      }),
      duplex: "half",
    });
    const streamed = await POST(streamingRequest, { params: Promise.resolve({ action: "authorize" }) });
    expect(streamed.status).toBe(413);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("caps authorize calls per trusted client IP before the upstream", async () => {
    for (let i = 0; i < ORCATERM_CONFIG.maxAuthorizeRequests; i++) {
      expect((await requestFromIp("authorize", "198.51.100.5")).status).toBe(200);
    }
    expect((await requestFromIp("authorize", "198.51.100.5")).status).toBe(429);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(ORCATERM_CONFIG.maxAuthorizeRequests);
    expect((await requestFromIp("authorize", "198.51.100.6")).status).toBe(200);
  });

  it("caps simultaneous upstream login-config requests", async () => {
    const releases = [];
    vi.mocked(proxyAwareFetch).mockImplementation(() => new Promise((resolve) => {
      releases.push(() => resolve(Response.json(config())));
    }));
    const pending = Array.from({ length: ORCATERM_CONFIG.maxInFlightLoginRequests }, () => request("authorize"));
    await vi.waitFor(() => expect(releases).toHaveLength(ORCATERM_CONFIG.maxInFlightLoginRequests));
    const overflow = await request("authorize");
    expect(overflow.status).toBe(429);
    expect(releases).toHaveLength(ORCATERM_CONFIG.maxInFlightLoginRequests);
    releases.forEach((release) => release());
    for (const response of await Promise.all(pending)) {
      expect(response.status).toBe(200);
      const session = await response.json();
      sessions.push(session);
    }
  });

  it("does not disclose raw errors containing credentials", async () => {
    vi.mocked(proxyAwareFetch).mockRejectedValue(new Error(`Network debug: ${token()}`));
    const response = await request("authorize");
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("private-signature");
  });
});
