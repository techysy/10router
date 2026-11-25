// Daily-grant midnight reset (每日赠送积分优先 policy — reopen half).
// auth.js 的烧尽守卫把 dailyGrantRemaining<=0 的号 isActive:false 关闭并盖
// dailyGrantAutoDisabled 戳；本调度器 0 点重开带戳的号 + 快照重置为满额。
// 钉死的行为：
//   1. 只动带 dailyGrantAutoDisabled 戳的号 —— 用户手动关的（无戳）绝不复活
//   2. 只扫 dailyGrantFirst=true 的 provider（每次 tick 重读 settings，开关即时生效）
//   3. 快照重置 dailyGrantRemaining = dailyGrantTotal（首次请求无需等 usage 刷新）
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { msUntilMidnight } from "../../src/sse/services/dailyGrantReset.js";

const { fetchConnMock, updateConnMock, settingsGetMock } = vi.hoisted(() => ({
  fetchConnMock: vi.fn(),
  updateConnMock: vi.fn(),
  settingsGetMock: vi.fn(),
}));

vi.mock("../../src/lib/localDb.js", () => ({
  getSettings: (...a) => settingsGetMock(...a),
  getProviderConnections: (...a) => fetchConnMock(...a),
  updateProviderConnection: (...a) => updateConnMock(...a),
}));

const conn = (id, { active, grant, total, autoDisabled, name } = {}) => ({
  id,
  name: name ?? id,
  isActive: active !== false,
  dailyGrantRemaining: grant,
  dailyGrantTotal: total ?? 5000,
  dailyGrantAutoDisabled: autoDisabled === true,
});

describe("dailyGrantReset midnight scheduler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateConnMock.mockResolvedValue({});
  });

  it("msUntilMidnight anchors at the next LOCAL midnight, not a 24h window", () => {
    // 23:30 本地 → 30 分钟
    const late = new Date(); late.setHours(23, 30, 0, 0);
    expect(Math.round(msUntilMidnight(late.getTime()) / 60000)).toBe(30);
    // 00:10 本地 → 23h50m（跨过整数小时边界用分钟断言，避开 Math.round 抖动）
    const early = new Date(); early.setHours(0, 10, 0, 0);
    const mins = msUntilMidnight(early.getTime()) / 60000;
    expect(mins).toBeGreaterThan(23 * 60);
    expect(mins).toBeLessThan(24 * 60);
  });

  it("reopens ONLY stamped connections; user-disabled (no stamp) stays off", async () => {
    settingsGetMock.mockResolvedValue({ providerStrategies: { loomy: { dailyGrantFirst: true } } });
    fetchConnMock.mockResolvedValue([
      conn("stamped-drained", { active: false, grant: 0, autoDisabled: true }),
      conn("user-disabled", { active: false, grant: 0, autoDisabled: false }),
      conn("still-active", { active: true, grant: 2500, autoDisabled: false }),
    ]);
    const { runDailyGrantResetTick } = await import("../../src/sse/services/dailyGrantReset.js");
    const r = await runDailyGrantResetTick();
    expect(r.reopened).toBe(1);
    expect(r.reset).toBe(1);
    expect(updateConnMock).toHaveBeenCalledTimes(1);
    const [id, patch] = updateConnMock.mock.calls[0];
    expect(id).toBe("stamped-drained");
    expect(patch.isActive).toBe(true);
    expect(patch.dailyGrantRemaining).toBe(5000);
    expect(patch.dailyGrantAutoDisabled).toBe(false);
  });

  it("only scans providers with dailyGrantFirst=true (re-read every tick)", async () => {
    settingsGetMock.mockResolvedValue({ providerStrategies: { other: { earliestExpiryFirst: true } } });
    const { runDailyGrantResetTick } = await import("../../src/sse/services/dailyGrantReset.js");
    const r = await runDailyGrantResetTick();
    expect(r.reopened).toBe(0);
    expect(fetchConnMock).not.toHaveBeenCalled();
  });

  it("toggle-off (no dailyGrantFirst anywhere) is a no-op", async () => {
    settingsGetMock.mockResolvedValue({ providerStrategies: {} });
    const { runDailyGrantResetTick } = await import("../../src/sse/services/dailyGrantReset.js");
    const r = await runDailyGrantResetTick();
    expect(r.reopened).toBe(0);
    expect(fetchConnMock).not.toHaveBeenCalled();
  });

  it("unknown dailyGrantTotal resets snapshot to 0 (healthy flag, usage fetch corrects)", async () => {
    settingsGetMock.mockResolvedValue({ providerStrategies: { loomy: { dailyGrantFirst: true } } });
    fetchConnMock.mockResolvedValue([
      conn("no-total", { active: false, grant: 0, total: 0, autoDisabled: true }),
    ]);
    const { runDailyGrantResetTick } = await import("../../src/sse/services/dailyGrantReset.js");
    const r = await runDailyGrantResetTick();
    expect(r.reopened).toBe(1);
    expect(r.reset).toBe(0); // 无 total 可重置，只重开
    const patch = updateConnMock.mock.calls[0][1];
    expect(patch.isActive).toBe(true);
    expect(patch.dailyGrantRemaining).toBe(0);
  });
});
