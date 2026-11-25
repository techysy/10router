import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ proxyAwareFetch: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.proxyAwareFetch }));

import { getDeepaiUsage } from "../../open-sse/services/usage/deepai.js";

beforeEach(() => vi.clearAllMocks());

describe("DeepAI quota error classification", () => {
  it("distinguishes the live machine_required response from a rejected API key", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(Response.json({
      error: {
        code: "machine_required",
        type: "machine_required",
        message: "Free daily Theos are not available right now. Restart DeepAI Code to try again.",
      },
    }, { status: 403 }));
    const result = await getDeepaiUsage("live-key");
    expect(result.message).toContain("machine_required");
    expect(result.message).toContain("设备验证");
    expect(result.message).toContain("免费模型可单独测试使用");
    expect(result.message).not.toContain("旧 Key 失效");
    expect(result.message).not.toContain("deepai-account.bin");
    expect(result.quotas).toBeUndefined();
  });

  it("still identifies an authentication error", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(Response.json({ error: { code: "auth_required" } }, { status: 401 }));
    const result = await getDeepaiUsage("expired-key");
    expect(result.message).toContain("HTTP 401");
    expect(result.message).toContain("auth_required");
    expect(result.message).toContain("重新授权");
    expect(result.message).not.toContain("设备验证");
  });

  it("preserves an upstream zero balance and zero grant without inventing quota", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(Response.json({
      enabled: true, balance: "0.00000", granted: "0.00000", refresh_at: null,
    }));
    const result = await getDeepaiUsage("account-with-no-grant");
    expect(result.message).toBeUndefined();
    expect(result.quotas["Balance （Theos)"].total).toBe(0);
    expect(result.quotas["Balance （Theos)"].remainingPercentage).toBe(0);
    expect(result.quotas["Balance （Theos)"].unlimited).toBe(false);
    expect(result.quotas["Daily grant （每日发放）"]).toBeUndefined();
  });

  it("explains a social-login restriction", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(Response.json({ error: { type: "social_login_required" } }, { status: 403 }));
    expect((await getDeepaiUsage("account-key")).message).toContain("Google 或 Apple");
  });

  it.each([403, 429, 500])("does not blame the key for an unknown HTTP %s response", async (status) => {
    mocks.proxyAwareFetch.mockResolvedValue(Response.json({ error: { code: "quota_unavailable" } }, { status }));
    const result = await getDeepaiUsage("account-key");
    expect(result.message).toContain(`HTTP ${status}`);
    expect(result.message).toContain("quota_unavailable");
    expect(result.message).not.toContain("旧 Key 失效");
    expect(result.quotas).toBeUndefined();
  });

  it("does not expose an HTML challenge or echoed credential", async () => {
    mocks.proxyAwareFetch.mockResolvedValueOnce(new Response("<html>challenge for secret</html>", { status: 403 }));
    expect((await getDeepaiUsage("secret")).message).not.toContain("secret");
    mocks.proxyAwareFetch.mockResolvedValueOnce(Response.json({ error: { code: "invalid_secret", message: "secret" } }, { status: 403 }));
    expect((await getDeepaiUsage("secret")).message).not.toContain("secret");
  });

  it("keeps successful balances and proxy/header forwarding intact", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(Response.json({ balance: 42, granted: 52, refresh_at: "2026-11-17T10:22:00+08:00" }));
    const proxy = { connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.test" };
    const result = await getDeepaiUsage(" account-key ", proxy);
    expect(result.quotas["Balance （Theos)"].total).toBe(42);
    expect(result.quotas["Daily grant （每日发放）"].used).toBe(10);
    expect(result.message).toBeUndefined();
    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      "https://api.deepai.org/deepai_code/theos",
      expect.objectContaining({ headers: expect.objectContaining({ "Api-Key": "account-key", "X-DeepAI-Code-Theos": "4" }) }),
      proxy,
    );
  });
});
