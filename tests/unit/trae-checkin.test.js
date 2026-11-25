// Trae 每日签到（traeCheckin）— 协议口径移植自 CreditDaddy traeClient.checkinTrae，
// 头组合 / 9074 换号重试 / 「已经签到」文案归 already 的判定与 CD #28/#31 实测对齐。
// 站点边界：ug 签到接口只在 api.trae.cn 注册——intl 连接不参与。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { proxyFetchMock } = vi.hoisted(() => ({ proxyFetchMock: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: (...args) => proxyFetchMock(...args) }));

function conn(overrides = {}) {
  return {
    id: "conn-1",
    provider: "trae-cn",
    isActive: true,
    accessToken: "hdr.sig.sig",
    name: "Trae 测试",
    providerSpecificData: { site: "cn", userId: "u-77" },
    ...overrides,
  };
}

// 信封化的 Trae 响应
const traeRes = (body, code = 0, message = "success") =>
  new Response(JSON.stringify({ code, message, ...body }), { status: 200 });

describe("Trae 每日签到 — 资格过滤", () => {
  it("trae-cn 连接参与；intl trae 连接不参与（接口只在国内站注册）", async () => {
    const { isEligibleTraeConnection } = await import("../../src/sse/services/traeCheckin.js");
    expect(isEligibleTraeConnection(conn())).toBe(true);
    // trae 条目（国际站）不放行
    expect(isEligibleTraeConnection(conn({ provider: "trae", providerSpecificData: { site: "intl" } }))).toBe(false);
    // 拆线前老连接：trae 条目但 site=cn —— 参与
    expect(isEligibleTraeConnection(conn({ provider: "trae" }))).toBe(true);
    // 无 token 不参与
    expect(isEligibleTraeConnection(conn({ accessToken: "" }))).toBe(false);
    expect(isEligibleTraeConnection(conn({ isActive: false }))).toBe(false);
    // 非 trae 连接不参与
    expect(isEligibleTraeConnection(conn({ provider: "minimax-code" }))).toBe(false);
  });
});

describe("Trae 每日签到 — 签到流程", () => {
  const realFetch = globalThis.fetch;
  let calls;

  beforeEach(() => {
    calls = [];
    proxyFetchMock.mockReset();
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  it("status 已签（checked_in=1）→ already，不打 claim", async () => {
    const { checkinOneTrae } = await import("../../src/sse/services/traeCheckin.js");
    proxyFetchMock.mockImplementation(async (url) => {
      calls.push(String(url));
      return traeRes({ data: { checked_in: 1 } });
    });
    const r = await checkinOneTrae(conn());
    expect(r.status).toBe("already");
    expect(calls.some((u) => u.includes("/checkin_credits/claim"))).toBe(false);
  });

  it("status 未签 → claim 领取，credits 从响应取；请求头带 CD 实测组合与派生设备号", async () => {
    const { checkinOneTrae } = await import("../../src/sse/services/traeCheckin.js");
    proxyFetchMock.mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("status")) return traeRes({ data: { checked_in: 0, credits: 150 } });
      return traeRes({ data: { credits: 150 } });
    });
    const r = await checkinOneTrae(conn());
    expect(r.status).toBe("checked-in");
    expect(r.claimedAmount).toBe(150);

    const statusCall = calls.find((c) => String(c.url).includes("status"));
    const h = statusCall.init.headers;
    expect(h.authorization).toBe("Cloud-IDE-JWT hdr.sig.sig");
    expect(h["x-device-id"]).toMatch(/^\d{16}$/);
    expect(h["x-user-region"]).toBe("CN");
    expect(h["package-type"]).toBe("stable_cn");
    expect(h["x-market-user-id"]).toMatch(/^[0-9a-f-]{36}$/);
    // 同一连接重复签到：派生设备号恒定（跨天稳定指纹）
    const r2 = await checkinOneTrae(conn());
    const statusCall2 = calls.filter((c) => String(c.url).includes("status"))[1];
    expect(statusCall2.init.headers["x-device-id"]).toBe(h["x-device-id"]);
  });

  it("CD 推送的真机号（psd.creditDaddyTraeDevice）优先于派生号", async () => {
    const { checkinOneTrae } = await import("../../src/sse/services/traeCheckin.js");
    proxyFetchMock.mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("status")) return traeRes({ data: { checked_in: 0 } });
      return traeRes({ data: { credits: 100 } });
    });
    const withCd = conn({ providerSpecificData: { site: "cn", userId: "u-77", creditDaddyTraeDevice: { deviceId: "9876543210987654" } } });
    const r = await checkinOneTrae(withCd);
    expect(r.status).toBe("checked-in");
    const h = calls.find((c) => String(c.url).includes("status")).init.headers;
    expect(h["x-device-id"]).toBe("9876543210987654");
  });

  it("claim 9074 → 换派生设备号重试（attempt 递增），成功归 checked-in", async () => {
    const { checkinOneTrae } = await import("../../src/sse/services/traeCheckin.js");
    let claimAttempts = 0;
    proxyFetchMock.mockImplementation(async (url, init) => {
      calls.push({ url: String(url), dev: init.headers["x-device-id"] });
      if (String(url).includes("status")) return traeRes({ data: { checked_in: 0 } });
      claimAttempts++;
      if (claimAttempts <= 2) return traeRes({}, 9074, "当前参与用户太多");
      return traeRes({ data: { credits: 120 } });
    });
    const r = await checkinOneTrae(conn());
    expect(r.status).toBe("checked-in");
    expect(r.claimedAmount).toBe(120);
    expect(claimAttempts).toBe(3);
    // 三次 claim 的设备号互不相同（轮换派生）
    const devs = calls.filter((c) => String(c.url).includes("claim")).map((c) => c.dev);
    expect(new Set(devs).size).toBe(3);
  }, 20000);

  it("claim「已经签到」文案归 already（CD #28：同 IP 多账号被风控合并时的服务端拒绝）", async () => {
    const { checkinOneTrae } = await import("../../src/sse/services/traeCheckin.js");
    proxyFetchMock.mockImplementation(async (url) => {
      if (String(url).includes("status")) return traeRes({ data: { checked_in: 0 } });
      return traeRes({}, 1201, "当前设备今日已经签到");
    });
    const r = await checkinOneTrae(conn());
    expect(r.status).toBe("already");
  });

  it("HTTP 401 → failed（凭据失效）；claim 9074 重试耗尽归 failed", async () => {
    const { checkinOneTrae } = await import("../../src/sse/services/traeCheckin.js");
    proxyFetchMock.mockImplementation(async () => new Response("denied", { status: 401 }));
    const dead = await checkinOneTrae(conn());
    expect(dead.status).toBe("failed");
    expect(dead.error).toMatch(/Authentication failed/);

    proxyFetchMock.mockImplementation(async (url) => {
      if (String(url).includes("status")) return traeRes({ data: { checked_in: 0 } });
      return traeRes({}, 9074, "nope");
    });
    const exhausted = await checkinOneTrae(conn());
    expect(exhausted.status).toBe("failed");
  }, 40000);

  it("code 1001 → failed（JWT 被吊销口径）", async () => {
    const { checkinOneTrae } = await import("../../src/sse/services/traeCheckin.js");
    proxyFetchMock.mockImplementation(async () => traeRes({}, 1001, "token revoked"));
    const r = await checkinOneTrae(conn());
    expect(r.status).toBe("failed");
  });
});

describe("Trae 每日签到 — 调度参数", () => {
  it("tick 间隔 ~2h 带 jitter，且永不为 0", async () => {
    const { msUntilNextTick } = await import("../../src/sse/services/traeCheckin.js");
    for (let i = 0; i < 20; i++) {
      const ms = msUntilNextTick(Date.now(), () => 0.5);
      expect(ms).toBeGreaterThanOrEqual(2 * 60 * 60 * 1000);
      expect(ms).toBeLessThanOrEqual(2 * 60 * 60 * 1000 + 10 * 60 * 1000);
    }
  });
});
