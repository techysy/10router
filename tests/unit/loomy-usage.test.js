// Loomy 积分额度卡（issue #93）+ 402 计费冷却档位（issue #91 方案 B 缺口）。
//
// 卡面口径（照 #93 建议卡面）：永久积分 = balance 储值行（不过期）；
// 每日赠送积分 = dailyBalance/5000（生产响应不回上限，5000 来自客户端文案）。
// 三个实测坑全钉：生产域 loomyad（绝不打 ossptest）、100002→first-login→重试、
// 重试仍失败只报"积分暂不可查"（认证层可能仍活着，绝不误判登录过期）。
import { describe, it, expect, vi, beforeEach } from "vitest";

const proxyAwareFetch = vi.fn();

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));

const SESSION = "4f27cdd4b0-test-session";

const okRecords = (balance = 10500, dailyBalance = 4119, extra = {}) => ({
  ok: true, status: 200,
  json: async () => ({
    code: "000000", desc: "成功",
    data: { balance, dailyBalance, list: [], total: 0, ...extra },
  }),
  text: async () => "",
});

const codeResponse = (code, desc = "") => ({
  ok: true, status: 200,
  json: async () => ({ code, desc, data: null }),
  text: async () => "",
});

beforeEach(() => proxyAwareFetch.mockReset());

describe("getLoomyUsage — records V1 卡面", () => {
  it("fetches records with the custom token header on loomyad (never ossptest)", async () => {
    proxyAwareFetch.mockResolvedValue(okRecords());
    const { getLoomyUsage } = await import("../../open-sse/services/usage/loomy.js");
    const usage = await getLoomyUsage(SESSION, null);

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    const [url, init] = proxyAwareFetch.mock.calls[0];
    expect(String(url)).toContain("https://loomyad.xunfei.cn/api/v1/points/records");
    expect(String(url)).not.toContain("ossptest");
    expect(init.headers.token).toBe(SESSION);

    expect(usage.plan).toBe("Loomy");
    // isCreditBalance → QuotaPackBar 储值行渲染（不掉进资源包池）；recurring → 每日滚动窗口
    expect(usage.quotas["永久积分"]).toMatchObject({ total: 10500, used: 0, unlimited: true, isCreditBalance: true });
    expect(usage.quotas["每日赠送积分"]).toMatchObject({ total: 5000, used: 5000 - 4119, recurring: true });
  });

  it("daily row uses the 5000文案上限 even when the response omits dailyLimitPoints", async () => {
    proxyAwareFetch.mockResolvedValue(okRecords(0, 0));
    const { getLoomyUsage } = await import("../../open-sse/services/usage/loomy.js");
    const usage = await getLoomyUsage(SESSION, null);
    // 全零：无永久行，每日行仍以 5000 为基数呈现（remaining 0 → 全部已用）
    expect(usage.quotas["永久积分"]).toBeUndefined();
    expect(usage.quotas["每日赠送积分"]).toMatchObject({ total: 5000, used: 5000 });
  });

  it("prefers server-reported dailyConsumedPoints over the limit-minus-remaining guess", async () => {
    proxyAwareFetch.mockResolvedValue(okRecords(10500, 3506, { dailyLimitPoints: 5000, dailyConsumedPoints: 1494 }));
    const { getLoomyUsage } = await import("../../open-sse/services/usage/loomy.js");
    const usage = await getLoomyUsage(SESSION, null);
    expect(usage.quotas["每日赠送积分"]).toMatchObject({ total: 5000, used: 1494 });
  });

  it("resolves legacy field aliases (permanentPoints/dailyPoints/dailyLimit)", async () => {
    proxyAwareFetch.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({
        code: "000000", desc: "成功",
        data: { permanentPoints: 100, dailyPoints: 40, dailyLimit: 500, list: [], total: 0 },
      }),
      text: async () => "",
    });
    const { getLoomyUsage } = await import("../../open-sse/services/usage/loomy.js");
    const usage = await getLoomyUsage(SESSION, null);
    expect(usage.quotas["永久积分"].total).toBe(100);
    expect(usage.quotas["每日赠送积分"]).toMatchObject({ total: 500, used: 460 });
  });

  it("empty records data reports no-points instead of fabricating a 5000 daily row", async () => {
    proxyAwareFetch.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ code: "000000", desc: "成功", data: {} }),
      text: async () => "",
    });
    const { getLoomyUsage } = await import("../../open-sse/services/usage/loomy.js");
    const usage = await getLoomyUsage(SESSION, null);
    expect(usage.quotas).toBeUndefined();
    expect(usage.message).toContain("No points data returned");
  });

  it("100002 → POST first-login → retry records once (client protocol)", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(codeResponse("100002", "登录已失效"))                 // records #1
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ code: "000000", data: {} }), text: async () => "" }) // first-login
      .mockResolvedValueOnce(okRecords());                                        // records #2
    const { getLoomyUsage } = await import("../../open-sse/services/usage/loomy.js");
    const usage = await getLoomyUsage(SESSION, null);

    expect(proxyAwareFetch).toHaveBeenCalledTimes(3);
    const [, firstLoginInit] = proxyAwareFetch.mock.calls[1];
    expect(String(proxyAwareFetch.mock.calls[1][0])).toContain("/api/v1/points/first-login");
    expect(firstLoginInit.method).toBe("POST");
    expect(usage.quotas["永久积分"].total).toBe(10500);
  });

  it("100002 after retry reports points-unavailable WITHOUT claiming session expiry (认证层可能仍活着)", async () => {
    proxyAwareFetch.mockResolvedValue(codeResponse("100002", "登录已失效"));
    const { getLoomyUsage } = await import("../../open-sse/services/usage/loomy.js");
    const usage = await getLoomyUsage(SESSION, null);
    expect(usage.message).toContain("Loomy points unavailable");
    expect(usage.message).not.toMatch(/expired|re-?login/i); // 不误判登录过期
    expect(usage.quotas).toBeUndefined();
  });

  it("maps 401/403 to an auth message", async () => {
    proxyAwareFetch.mockResolvedValue({ ok: false, status: 401, json: async () => ({}), text: async () => "unauthorized" });
    const { getLoomyUsage } = await import("../../open-sse/services/usage/loomy.js");
    const usage = await getLoomyUsage(SESSION, null);
    expect(usage.message).toContain("session has expired");
  });

  it("no key → guidance message, no network", async () => {
    const { getLoomyUsage } = await import("../../open-sse/services/usage/loomy.js");
    const usage = await getLoomyUsage(null, null);
    expect(usage.message).toContain("Loomy session not available");
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });
});
