import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  exchangeDeepaiCode: vi.fn(),
  createProviderConnection: vi.fn(),
}));

vi.mock("@/models", () => ({ createProviderConnection: mocks.createProviderConnection }));
vi.mock("open-sse/shared/deepai/auth.js", async (importOriginal) => ({
  ...await importOriginal(),
  exchangeDeepaiCode: mocks.exchangeDeepaiCode,
}));
vi.mock("next/server", () => ({
  NextResponse: { json: (body, init) => Response.json(body, init) },
}));

import { POST } from "../../src/app/api/oauth/deepai/exchange/route.js";

const KEY = "issued-account-key";
let fetchMock;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.exchangeDeepaiCode.mockResolvedValue({ apiKey: KEY, username: "someone", isPro: false });
  mocks.createProviderConnection.mockImplementation(async (data) => ({ id: "connection-1", ...data }));
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function request(code = "one-time-code") {
  return new Request("http://localhost/api/oauth/deepai/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
}

describe("DeepAI exchange preserves a successful sign-in", () => {
  it.each([401, 403, 429, 500])("saves the issued key when Theos returns HTTP %s", async (status) => {
    fetchMock.mockResolvedValue(Response.json({ error: { code: "auth_required" } }, { status }));
    const response = await POST(request());
    const body = await response.json();
    expect(response.status).toBe(201);
    expect(mocks.createProviderConnection).toHaveBeenCalledOnce();
    expect(mocks.createProviderConnection).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: KEY,
      provider: "deepai",
      testStatus: "unknown",
      allowOverwrite: false,
      lastError: expect.stringContaining(`HTTP ${status}`),
    }));
    expect(body.warning).toContain("auth_required");
    expect(body.connection.apiKey).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(KEY);
  });

  it("identifies an account's social sign-in restriction without reporting a bad key", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: { code: "social_login_required" } }, { status: 403 }));
    const response = await POST(request());
    const body = await response.json();
    expect(response.status).toBe(201);
    expect(body.warning).toContain("Google 或 Apple");
    expect(body.warning).toContain("social_login_required");
  });

  it("preserves a newly issued key when free Theos requires a device", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: { code: "machine_required" } }, { status: 403 }));
    const response = await POST(request());
    const body = await response.json();
    expect(response.status).toBe(201);
    expect(body.warning).toContain("machine_required");
    expect(body.warning).toContain("设备验证");
    expect(body.warning).not.toContain("重新授权");
    expect(body.connection.testStatus).toBe("unknown");
    expect(body.connection.apiKey).toBeUndefined();
  });

  it.each([
    { error: { code: KEY, message: `bad key ${KEY}` } },
    { error: { code: `invalid_${KEY}`, message: KEY } },
    { error: `<html>${KEY}</html>` },
  ])("does not echo upstream response bodies or credentials", async (payload) => {
    fetchMock.mockResolvedValue(Response.json(payload, { status: 403 }));
    const body = await (await POST(request())).json();
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect(body.warning).toContain("HTTP 403");
    expect(body.warning).not.toContain("<html>");
  });

  it("preserves the key when the quota endpoint sends an HTML challenge", async () => {
    fetchMock.mockResolvedValue(new Response("<html>Challenge</html>", { status: 403 }));
    const response = await POST(request());
    const body = await response.json();
    expect(response.status).toBe(201);
    expect(body.warning).toContain("HTTP 403");
    expect(body.warning).not.toContain("Challenge");
  });

  it("bounds the quota request and preserves credentials on network failure", async () => {
    fetchMock.mockRejectedValue(new DOMException("Timed out", "TimeoutError"));
    const response = await POST(request());
    const body = await response.json();
    expect(response.status).toBe(201);
    expect(body.warning).toContain("额度查询暂时无法完成");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.deepai.org/deepai_code/theos");
    expect(init.headers["Api-Key"]).toBe(KEY);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not claim inference was tested even when the quota request succeeds", async () => {
    fetchMock.mockResolvedValue(Response.json({ balance: 52 }));
    const response = await POST(request());
    const body = await response.json();
    expect(response.status).toBe(201);
    expect(body.connection.testStatus).toBe("unknown");
    expect(body.warning).toBeUndefined();
    expect(body.connection.lastError).toBeUndefined();
    expect(body.connection.apiKey).toBeUndefined();
  });

  it("still rejects an invalid authorization code without creating a connection", async () => {
    mocks.exchangeDeepaiCode.mockRejectedValue(new Error("invalid code"));
    const response = await POST(request());
    expect(response.status).toBe(400);
    expect(mocks.createProviderConnection).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not overwrite a connection with the same name", async () => {
    fetchMock.mockResolvedValue(Response.json({ balance: 52 }));
    mocks.createProviderConnection.mockRejectedValue(Object.assign(new Error("duplicate"), { code: "PROVIDER_NAME_CONFLICT" }));
    const response = await POST(request());
    expect(response.status).toBe(409);
  });
});
