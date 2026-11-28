import { createHash } from "node:crypto";
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
const refresh = () => `${token().split(".")[0]}.refresh.private-refresh`;
const exchangeUrl = `${ORCATERM_CONFIG.apiUrl}?action=OAuthExchangeToken`;
const granted = () => Response.json({ data: { Response: {
  Code: 0, AccessToken: token(), RefreshToken: refresh(), ExpiresIn: 7200,
  User: { UserId: "wechat-user", Provider: "wechat", Username: "Orca user" },
} } });
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
    if (url === exchangeUrl) return granted();
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

  it("starts a desktop PKCE sign-in without contacting OrcaTerm or revealing the verifier", async () => {
    const session = await authorize();
    expect(proxyAwareFetch).not.toHaveBeenCalled();
    const url = new URL(session.authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe(ORCATERM_CONFIG.authorizeUrl);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      provider: "wechat", source: "desktop", return_url: ORCATERM_CONFIG.desktopReturnUrl, codeChallengeMethod: "S256",
    });
    expect(url.searchParams.get("session_id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(url.searchParams.get("codeChallenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(session)).not.toMatch(/verifier/i);
  });

  it("redeems the session with its PKCE verifier and stores a distinct refresh token server-side", async () => {
    const session = await authorize();
    const response = await request("exchange", { sessionId: session.sessionId });
    expect(response.status).toBe(200);
    const [url, init] = vi.mocked(proxyAwareFetch).mock.calls[0];
    expect(url).toBe(exchangeUrl);
    const sent = JSON.parse(init.body);
    const challenge = new URL(session.authorizeUrl).searchParams;
    expect(sent.action).toBe("OAuthExchangeToken");
    expect(sent.data.sessionId).toBe(challenge.get("session_id"));
    expect(createHash("sha256").update(sent.data.codeVerifier).digest("base64url")).toBe(challenge.get("codeChallenge"));
    expect(db.create).toHaveBeenCalledWith(expect.objectContaining({
      provider: "orcaterm", authType: "oauth", accessToken: token(), refreshToken: refresh(),
      providerSpecificData: { userId: "wechat-user", loginMethod: "wechat" }, testStatus: "unknown",
    }));
    const text = await response.text();
    expect(text).toContain("created-connection");
    expect(text).not.toContain("private-signature");
    expect(text).not.toContain("private-refresh");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("redeems a session once, even if two exchanges arrive concurrently", async () => {
    const session = await authorize();
    let release;
    vi.mocked(proxyAwareFetch).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const first = request("exchange", { sessionId: session.sessionId });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await request("exchange", { sessionId: session.sessionId });
    expect(second.status).toBe(409);
    release(granted());
    expect((await first).status).toBe(200);
    expect((await request("exchange", { sessionId: session.sessionId })).status).toBe(400);
    expect(db.create).toHaveBeenCalledTimes(1);
  });

  it("reports an unfinished scan and requires a new link afterwards", async () => {
    const session = await authorize();
    vi.mocked(proxyAwareFetch).mockResolvedValueOnce(Response.json({ data: { Response: {
      Error: { Code: "TOKEN_EXPIRED", Message: "expired" },
    } } }));
    const response = await request("exchange", { sessionId: session.sessionId });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("TOKEN_EXPIRED");
    expect((await request("exchange", { sessionId: session.sessionId })).status).toBe(400);
    expect(db.create).not.toHaveBeenCalled();
  });

  it("rejects expired and cancelled sessions without contacting OrcaTerm", async () => {
    vi.useFakeTimers();
    const expired = await authorize();
    vi.advanceTimersByTime(ORCATERM_CONFIG.loginTtlMs + 1);
    expect((await request("exchange", { sessionId: expired.sessionId })).status).toBe(400);
    const cancelled = await authorize();
    expect((await request("cancel", { sessionId: cancelled.sessionId })).status).toBe(200);
    expect((await request("exchange", { sessionId: cancelled.sessionId })).status).toBe(400);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
    expect(db.create).not.toHaveBeenCalled();
  });

  it("re-authorizes the matching account without destroying name, priority or provider metadata", async () => {
    db.list.mockResolvedValue([{
      id: "existing", authType: "oauth", name: "My account", priority: 7,
      providerSpecificData: { userId: "wechat-user", customSetting: true },
    }]);
    const session = await authorize();
    expect((await request("exchange", { sessionId: session.sessionId })).status).toBe(200);
    expect(db.create).not.toHaveBeenCalled();
    expect(db.update).toHaveBeenCalledWith("existing", expect.objectContaining({
      resetErrorState: true, refreshToken: refresh(),
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
  });

  it("caps authorize calls per trusted client IP", async () => {
    for (let i = 0; i < ORCATERM_CONFIG.maxAuthorizeRequests; i++) {
      const response = await requestFromIp("authorize", "198.51.100.5");
      expect(response.status).toBe(200);
      sessions.push(await response.json());
    }
    expect((await requestFromIp("authorize", "198.51.100.5")).status).toBe(429);
    const other = await requestFromIp("authorize", "198.51.100.6");
    expect(other.status).toBe(200);
    sessions.push(await other.json());
  });

  it("does not disclose raw errors containing credentials", async () => {
    const session = await authorize();
    vi.mocked(proxyAwareFetch).mockRejectedValue(new Error(`Network debug: ${token()}`));
    const response = await request("exchange", { sessionId: session.sessionId });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("private-signature");
  });
});
