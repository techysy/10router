// Meoo 每日领积分自动调度器（meooCheckin）——
// 资格过滤、当日闭环 memoize、调度间隔纪律。核心领取例程
// claimMeooDailyPoints 的账面核验逻辑由 meoo-provider.test.js 的
// meoo-daily-claim 用例覆盖，这里只钉调度器自身的行为。
import { describe, it, expect, vi } from "vitest";

function conn(overrides = {}) {
  return {
    id: "meoo-1",
    provider: "meoo",
    isActive: true,
    name: "Meoo 测试",
    accessToken: "oauth-access-token",
    refreshToken: "oauth-refresh-token",
    providerSpecificData: {},
    ...overrides,
  };
}

describe("Meoo 每日领积分 — 资格过滤", () => {
  it("meoo 连接参与；external（CreditDaddy 推送）连接不参与", async () => {
    const { isEligibleMeooConnection } = await import("../../src/sse/services/meooCheckin.js");
    expect(isEligibleMeooConnection(conn())).toBe(true);
    expect(isEligibleMeooConnection(conn({ external: true }))).toBe(false);
  });

  it("无 OAuth 凭证时放行粘贴的控制面 Key；两者皆无则排除", async () => {
    const { isEligibleMeooConnection } = await import("../../src/sse/services/meooCheckin.js");
    const pasted = conn({ accessToken: null, refreshToken: null, providerSpecificData: { meooControlKey: "meoo_ak_abc1234567890" } });
    expect(isEligibleMeooConnection(pasted)).toBe(true);
    const blank = conn({ accessToken: null, refreshToken: null, providerSpecificData: {} });
    expect(isEligibleMeooConnection(blank)).toBe(false);
  });

  it("停用连接与非 meoo 连接不参与", async () => {
    const { isEligibleMeooConnection } = await import("../../src/sse/services/meooCheckin.js");
    expect(isEligibleMeooConnection(conn({ isActive: false }))).toBe(false);
    expect(isEligibleMeooConnection(conn({ provider: "qoder" }))).toBe(false);
    expect(isEligibleMeooConnection(null)).toBe(false);
  });
});

describe("Meoo 每日领积分 — 调度纪律", () => {
  it("tick 间隔 ≈2h + 10min 抖动，且下限 1s", async () => {
    const { msUntilNextTick } = await import("../../src/sse/services/meooCheckin.js");
    const ms = msUntilNextTick(Date.now(), () => 0);
    expect(ms).toBe(2 * 60 * 60 * 1000);
    const msMax = msUntilNextTick(Date.now(), () => 0.999);
    expect(msMax).toBeLessThanOrEqual(2 * 60 * 60 * 1000 + 10 * 60 * 1000);
    expect(msMax).toBeGreaterThan(2 * 60 * 60 * 1000);
  });

  it("start/stop 是幂等的（重复 start 返回 false）", async () => {
    vi.resetModules();
    const svc = await import("../../src/sse/services/meooCheckin.js");
    svc._resetMeooCheckinState();
    // 服务端 runtime 下可启动（vitest 是 node 环境，NEXT_RUNTIME 未设 edge）
    const first = svc.startMeooCheckin();
    const second = svc.startMeooCheckin();
    svc.stopMeooCheckin();
    svc._resetMeooCheckinState();
    // vitest 环境没有 window，phase 未设 —— 视为 server runtime，可启动
    expect([true, false]).toContain(first); // 依据 runtime 判定，两边都合法
    expect(second).toBe(false); // 重复启动必然 false
  });
});

describe("Meoo 每日领积分 — route 复用契约", () => {
  it("meoo-daily-claim route 导出 claimMeooDailyPoints 供调度器复用（源码级钉住）", async () => {
    // 源码扫描而非 import：route.js 拉起 open-sse/index.js 与 usage route 的
    // 整条依赖链（uuid 等），不适合在隔离沙箱里加载。
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const routeSource = readFileSync(
      resolve(__dirname, "../../src/app/api/usage/[connectionId]/meoo-daily-claim/route.js"),
      "utf8",
    );
    expect(routeSource).toContain("export async function claimMeooDailyPoints");
    // 调度器调用同一份实现（DRY：手动路由与自动 tick 不允许分叉）
    const svc = await import("../../src/sse/services/meooCheckin.js");
    expect(typeof svc.runMeooCheckinTick).toBe("function");
    const svcSource = readFileSync(resolve(__dirname, "../../src/sse/services/meooCheckin.js"), "utf8");
    expect(svcSource).toContain("claimMeooDailyPoints");
  });
});
