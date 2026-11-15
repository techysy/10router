// /api/health 的排水信号（issue #97 收尾）:activeRequests = 在途 relay
// 请求总数,fnOS 面板自动更新重启前轮询它等排空。健康端点不 import DB 层 ——
// 求和直接读 usageRepo 维护的注册表 global,这里是该求和的纯函数测试。
import { describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => ({ body, init }),
  },
}));

const { sumPendingRequests } = await import("../../src/app/api/health/route.js");

describe("sumPendingRequests（health.activeRequests 排水信号）", () => {
  it("按账号/模型注册表求和在途计数", () => {
    expect(sumPendingRequests({
      "conn-1": { "qwen3.8-flash (meoo)": 2, "kimi-k3 (qoder)": 1 },
      "conn-2": { "glm-5.2 (zcode)": 3 },
    })).toBe(6);
  });

  it("零值与负值不计入;空注册表 → 0", () => {
    expect(sumPendingRequests({
      "conn-1": { "m1 (p1)": 0, "m2 (p1)": -2 },
    })).toBe(0);
    expect(sumPendingRequests({})).toBe(0);
  });

  it("缺参/脏数据不抛 —— 健康端点绝不因排水信号失败", () => {
    expect(sumPendingRequests(undefined)).toBe(0);
    expect(sumPendingRequests(null)).toBe(0);
    expect(sumPendingRequests({ "conn-1": null })).toBe(0);
    expect(sumPendingRequests({ "conn-1": { "m (p)": "not-a-number" } })).toBe(0);
  });
});
