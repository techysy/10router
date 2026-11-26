/**
 * 余额优先调度（小额优先 / 大额优先）在 getProviderCredentials 里的接线。
 *
 * 用户 2026-11-26 报「Meoo 的余额优先不生效」，三条根因各有回归：
 * 1. provider 级余额策略不得被全局 fallbackStrategy（round-robin）吞掉 ——
 *    轮询臂按 lastUsedAt 重排，会把已排好的余额序整个丢掉；
 * 2. 纯余额调度也要触发背景配额刷新 —— 否则从没手动刷过配额的号
 *    quotaBalance 为 null，全落 priority 尾组且毫无痕迹；
 * 3. 余额为 null 时退化到 priority 且不炸（未知余额排最后）。
 *
 * 另钉住可观测性：选中时必须打一行 balance-<strategy> selected 日志。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
  validateApiKey: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  pickProxyPoolId: vi.fn(),
  getUsageForProvider: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  updateProviderConnection: mocks.updateProviderConnection,
  getSettings: mocks.getSettings,
  getProxyPools: mocks.getProxyPools,
  validateApiKey: mocks.validateApiKey,
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
  pickProxyPoolId: mocks.pickProxyPoolId,
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (p) => p,
}));
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  info: mocks.logInfo,
  warn: vi.fn(),
}));
vi.mock("open-sse/services/usage.js", () => ({ getUsageForProvider: mocks.getUsageForProvider }));

import { getProviderCredentials } from "../../src/sse/services/auth.js";

// 实测形状（NAS 2026-11-26）：三个 meoo 号余额 28039 / 6375 / 955，
// priority 1 / 2 / 3。小额优先必须选 955 那个号，而不是 priority=1 的大号。
const meooConns = () => [
  { id: "big", provider: "meoo", priority: 1, quotaBalance: 28039 },
  { id: "mid", provider: "meoo", priority: 2, quotaBalance: 6375, lastUsedAt: new Date().toISOString(), consecutiveUseCount: 1 },
  { id: "small", provider: "meoo", priority: 3, quotaBalance: 955 },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveConnectionProxyConfig.mockResolvedValue({});
  mocks.getProxyPools.mockResolvedValue([]);
  mocks.updateProviderConnection.mockResolvedValue(undefined);
  mocks.getUsageForProvider.mockResolvedValue({ quotas: {} });
});

describe("余额优先 — provider 级策略不被全局策略吞掉", () => {
  it("全局 round-robin + provider 小额优先 → 选余额最小的号", async () => {
    mocks.getProviderConnections.mockResolvedValue(meooConns());
    mocks.getSettings.mockResolvedValue({
      fallbackStrategy: "round-robin",
      stickyRoundRobinLimit: 1,
      providerStrategies: { meoo: { balanceStrategy: "lowest-first" } },
    });

    const res = await getProviderCredentials("meoo");
    expect(res.connectionId).toBe("small");
  });

  it("全局 round-robin + provider 大额优先 → 选余额最大的号", async () => {
    mocks.getProviderConnections.mockResolvedValue(meooConns());
    mocks.getSettings.mockResolvedValue({
      fallbackStrategy: "round-robin",
      providerStrategies: { meoo: { balanceStrategy: "highest-first" } },
    });

    const res = await getProviderCredentials("meoo");
    expect(res.connectionId).toBe("big");
  });

  it("全局 fill-first 下小额优先同样生效（默认臂不得绕过余额序）", async () => {
    mocks.getProviderConnections.mockResolvedValue(meooConns());
    mocks.getSettings.mockResolvedValue({
      fallbackStrategy: "fill-first",
      providerStrategies: { meoo: { balanceStrategy: "lowest-first" } },
    });

    const res = await getProviderCredentials("meoo");
    expect(res.connectionId).toBe("small");
  });

  it("provider 显式选轮询时仍走轮询（余额策略未被强加）", async () => {
    mocks.getProviderConnections.mockResolvedValue(meooConns());
    mocks.getSettings.mockResolvedValue({
      fallbackStrategy: "fill-first",
      providerStrategies: { meoo: { fallbackStrategy: "round-robin", stickyRoundRobinLimit: 1, balanceStrategy: "round-robin" } },
    });

    const res = await getProviderCredentials("meoo");
    // 轮询臂：mid 是当前 carrier 但已达 sticky 上限 → 取最久未用的 big
    expect(res.connectionId).toBe("big");
    expect(mocks.updateProviderConnection.mock.calls.some(([, p]) => "consecutiveUseCount" in p)).toBe(true);
  });

  it("没有余额策略时保持手动优先（priority=1）", async () => {
    mocks.getProviderConnections.mockResolvedValue(meooConns());
    mocks.getSettings.mockResolvedValue({ fallbackStrategy: "fill-first", providerStrategies: {} });

    const res = await getProviderCredentials("meoo");
    expect(res.connectionId).toBe("big");
  });
});

describe("余额优先 — 未知余额与刷新门", () => {
  it("余额为 null 的号排在已知余额之后，且不抛异常", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "unknown", provider: "meoo", priority: 1 },
      { id: "known-low", provider: "meoo", priority: 2, quotaBalance: 100 },
      { id: "known-high", provider: "meoo", priority: 3, quotaBalance: 900 },
    ]);
    mocks.getSettings.mockResolvedValue({
      fallbackStrategy: "fill-first",
      providerStrategies: { meoo: { balanceStrategy: "lowest-first" } },
    });

    const res = await getProviderCredentials("meoo");
    expect(res.connectionId).toBe("known-low");
  });

  // 2026-11-26 test.19 现网实测抓到：`balance-lowest-first selected f2b0d6e3
  // (#洋芋) | balance=0` —— 余额耗尽的号被「小额优先」排到最前，每次请求先撞
  // 一轮必失败的 403 再回退。小额优先是「先烧最小的余额」，不是「先试空号」。
  it("余额为 0（已耗尽）的号在两个方向上都沉到队尾", async () => {
    for (const strategy of ["lowest-first", "highest-first"]) {
      vi.clearAllMocks();
      mocks.getProviderConnections.mockResolvedValue([
        { id: "drained", provider: "meoo", priority: 1, quotaBalance: 0 },
        { id: "healthy-low", provider: "meoo", priority: 2, quotaBalance: 400 },
        { id: "healthy-high", provider: "meoo", priority: 3, quotaBalance: 4000 },
      ]);
      mocks.getSettings.mockResolvedValue({
        fallbackStrategy: "fill-first",
        providerStrategies: { meoo: { balanceStrategy: strategy } },
      });

      const res = await getProviderCredentials("meoo");
      expect(res.connectionId).not.toBe("drained");
      expect(res.connectionId).toBe(strategy === "lowest-first" ? "healthy-low" : "healthy-high");
    }
  });

  it("负余额同样按耗尽处理", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "negative", provider: "meoo", priority: 1, quotaBalance: -50 },
      { id: "healthy", provider: "meoo", priority: 2, quotaBalance: 900 },
    ]);
    mocks.getSettings.mockResolvedValue({
      fallbackStrategy: "fill-first",
      providerStrategies: { meoo: { balanceStrategy: "lowest-first" } },
    });

    expect((await getProviderCredentials("meoo")).connectionId).toBe("healthy");
  });

  it("全部余额未知时退化到 priority 顺序", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "u1", provider: "meoo", priority: 1 },
      { id: "u2", provider: "meoo", priority: 2 },
    ]);
    mocks.getSettings.mockResolvedValue({
      fallbackStrategy: "fill-first",
      providerStrategies: { meoo: { balanceStrategy: "highest-first" } },
    });

    const res = await getProviderCredentials("meoo");
    expect(res.connectionId).toBe("u1");
  });

  it("纯余额调度触发背景配额刷新（quotaCheckedAt 缺失的号）", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "fresh", provider: "meoo", priority: 1, quotaBalance: 500 },
      { id: "never-checked", provider: "meoo", priority: 2 },
    ]);
    mocks.getSettings.mockResolvedValue({
      fallbackStrategy: "fill-first",
      providerStrategies: { meoo: { balanceStrategy: "lowest-first" } },
    });

    await getProviderCredentials("meoo");
    // 背景刷新对陈旧号发起 usage 调用（fire-and-forget，等一个 microtask 轮）
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.getUsageForProvider).toHaveBeenCalled();
  });
});

describe("余额优先 — 可观测性", () => {
  it("选中时打 balance-lowest-first selected 日志，带 id 与余额值", async () => {
    mocks.getProviderConnections.mockResolvedValue(meooConns());
    mocks.getSettings.mockResolvedValue({
      fallbackStrategy: "fill-first",
      providerStrategies: { meoo: { balanceStrategy: "lowest-first" } },
    });

    await getProviderCredentials("meoo");
    const line = mocks.logInfo.mock.calls
      .map(([, msg]) => String(msg))
      .find((m) => m.includes("balance-lowest-first selected"));
    expect(line).toBeTruthy();
    expect(line).toContain("small");
    expect(line).toContain("balance=955");
  });
});

// 用户 2026-11-26 追加「再看看其他供应商 优先测量也有问题」。
// 现网实据（NAS minimax-code，4 号全开，quotaCheckedAt 同日 06:44）：
//   a9862f14 #187  prio=1 zone=yellow rem=6.76  expiry=2026-12-09
//   3dc040c2 #1697 prio=2 zone=red    rem=1.50  expiry=2026-12-07
//   84984fde #131  prio=3 zone=red    rem=3.43  expiry=2026-12-05
//   3f22a687 #3710 prio=4 zone=red    rem=1.96  expiry=2026-12-05
// minimax-code 的积分桶是一次性到期包（usage/minimax-code.js ledgerBucketRow：
// detailOnly + recurring:false + 每桶 expireAt），此前误归 PURE_BALANCE，于是
// 到期优先走 relay 臂：zoneRank 把红区号整体沉到队尾，实际先烧 12-09 那个号，
// 12-05 到期的两个包眼看烂掉 —— 与 pack-asset 的「严格烧最近到期包」语义相反。
describe("到期优先 — 一次性到期包必须走 pack-first 臂（不得红区下沉）", () => {
  const minimaxConns = () => [
    { id: "a9862f14", provider: "minimax-code", priority: 1, quotaZone: "yellow", earliestPackageRemaining: 6.76, earliestPackageExpiry: "2026-12-09T16:00:00.000Z" },
    { id: "3dc040c2", provider: "minimax-code", priority: 2, quotaZone: "red", earliestPackageRemaining: 1.5, earliestPackageExpiry: "2026-12-07T16:00:00.000Z" },
    { id: "84984fde", provider: "minimax-code", priority: 3, quotaZone: "red", earliestPackageRemaining: 3.43, earliestPackageExpiry: "2026-12-05T16:00:00.000Z" },
    { id: "3f22a687", provider: "minimax-code", priority: 4, quotaZone: "red", earliestPackageRemaining: 1.96, earliestPackageExpiry: "2026-12-05T16:00:00.000Z" },
  ];

  for (const provider of ["minimax-code", "minimax-code-global", "codebuddy-cn", "qoder"]) {
    it(`${provider}: 到期优先选中最近到期的包，红区号不下沉`, async () => {
      mocks.getProviderConnections.mockResolvedValue(
        minimaxConns().map((c) => ({ ...c, provider })),
      );
      mocks.getSettings.mockResolvedValue({
        fallbackStrategy: "fill-first",
        providerStrategies: { [provider]: { earliestExpiryFirst: true } },
      });

      const res = await getProviderCredentials(provider);
      // 12-05 并列取 priority 靠前的 #131；红区/低余量都不得把它挤下去
      expect(res.connectionId).toBe("84984fde");
      const line = mocks.logInfo.mock.calls.map(([, m]) => String(m)).join("\n");
      expect(line).toContain("#1-pack-first");
    });
  }

  it("滚动订阅供应商（antigravity）红区下沉保持不变", async () => {
    // 同一形状的四个号打在 antigravity 上：它是自动回血的周期窗，红区=已烧穿在
    // 冷却，必须沉到队尾（relay 语义），不能按 pack-first 取 #1。
    mocks.getProviderConnections.mockResolvedValue(minimaxConns().map((c) => ({ ...c, provider: "antigravity" })));
    mocks.getSettings.mockResolvedValue({
      fallbackStrategy: "fill-first",
      providerStrategies: { antigravity: { earliestExpiryFirst: true } },
    });

    const res = await getProviderCredentials("antigravity");
    expect(res.connectionId).toBe("a9862f14");
  });
});

// 用户 2026-11-26「比如 quwork 也可以看下」。quwork/dumate/lingxi/deepai/
// autoclaw/clixad/freepi 此前归 GENERIC —— 详情页的调度下拉只有
// 到期优先/轮询/手动三档，「大额优先/小额优先」这两个选项压根不出现，
// 调度臂也不会读 quotaBalance。归入 PURE_BALANCE 后必须真的能按余额选号。
describe("新归类为 PURE_BALANCE 的供应商 — 余额排序真的接通", () => {
  for (const provider of ["quwork", "dumate", "lingxi", "deepai", "autoclaw", "clixad", "freepi"]) {
    it(`${provider}: 小额优先选中余额最小的号`, async () => {
      mocks.getProviderConnections.mockResolvedValue([
        { id: "hi", provider, priority: 1, quotaBalance: 9000 },
        { id: "lo", provider, priority: 2, quotaBalance: 120 },
      ]);
      mocks.getSettings.mockResolvedValue({
        fallbackStrategy: "fill-first",
        providerStrategies: { [provider]: { balanceStrategy: "lowest-first" } },
      });

      expect((await getProviderCredentials(provider)).connectionId).toBe("lo");
    });
  }

  it("croli 保持 GENERIC — 钱包积分不参与余额调度（不得成为路由信号）", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      { id: "hi", provider: "croli", priority: 1, quotaBalance: 9000 },
      { id: "lo", provider: "croli", priority: 2, quotaBalance: 120 },
    ]);
    mocks.getSettings.mockResolvedValue({
      fallbackStrategy: "fill-first",
      providerStrategies: { croli: { balanceStrategy: "lowest-first" } },
    });

    // 非 PURE_BALANCE → 余额排序臂不参与，仍按手动优先级取 #1
    expect((await getProviderCredentials("croli")).connectionId).toBe("hi");
  });
});
