// Per-provider strategy persistence (settings.providerStrategies) against the REAL store.
//
// 用户 2026-11-26 报「Meoo 余额优先不生效」，DB 里 providerStrategies.meoo 整项
// 不存在。根因是仪表盘的保存形状：GET 整块 map → 改自己这一家 → PATCH 整块回写，
// 而 updateSettings 只按顶层键合并，于是那次写入用客户端快照覆盖了其它 provider
// 的策略（并发标签页/调度器刚写的项静默消失）。
// setProviderStrategyOverride 把合并搬进事务内，本文件钉住这一点。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-provider-strategy-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {} }
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const strategies = async () => (await db.getSettings()).providerStrategies || {};

describe("setProviderStrategyOverride (real store)", () => {
  it("helper is exported through both the db index and the localDb shim", async () => {
    expect(typeof db.setProviderStrategyOverride).toBe("function");
    const shim = await import("@/lib/localDb");
    expect(typeof shim.setProviderStrategyOverride).toBe("function");
  });

  it("set → get roundtrip keeps the balance strategy", async () => {
    await db.setProviderStrategyOverride("meoo", { balanceStrategy: "lowest-first" });
    expect((await strategies()).meoo).toEqual({ balanceStrategy: "lowest-first" });
  });

  it("writing one provider does not clobber another provider's entry", async () => {
    await db.setProviderStrategyOverride("keep-a", { earliestExpiryFirst: true });
    await db.setProviderStrategyOverride("keep-b", { fallbackStrategy: "round-robin", stickyRoundRobinLimit: 2 });
    await db.setProviderStrategyOverride("meoo", { balanceStrategy: "highest-first" });

    const s = await strategies();
    expect(s["keep-a"]).toEqual({ earliestExpiryFirst: true });
    expect(s["keep-b"]).toEqual({ fallbackStrategy: "round-robin", stickyRoundRobinLimit: 2 });
    expect(s.meoo).toEqual({ balanceStrategy: "highest-first" });
  });

  it("an empty override removes only that provider's entry", async () => {
    await db.setProviderStrategyOverride("drop-me", { balanceStrategy: "lowest-first" });
    await db.setProviderStrategyOverride("stay", { earliestExpiryFirst: true });
    await db.setProviderStrategyOverride("drop-me", {});

    const s = await strategies();
    expect(s["drop-me"]).toBeUndefined();
    expect(s.stay).toEqual({ earliestExpiryFirst: true });
  });

  it("null override removes the entry too (back to global defaults)", async () => {
    await db.setProviderStrategyOverride("drop-null", { balanceStrategy: "lowest-first" });
    await db.setProviderStrategyOverride("drop-null", null);
    expect((await strategies())["drop-null"]).toBeUndefined();
  });

  it("concurrent writes for different providers — no lost update", async () => {
    const providers = Array.from({ length: 8 }, (_, i) => `race-${i}`);
    await Promise.all(providers.map((p, i) =>
      db.setProviderStrategyOverride(p, { balanceStrategy: i % 2 ? "lowest-first" : "highest-first" })));

    const s = await strategies();
    for (const [i, p] of providers.entries()) {
      expect(s[p]).toEqual({ balanceStrategy: i % 2 ? "lowest-first" : "highest-first" });
    }
  });

  it("rejects a missing providerId instead of writing a bogus key", async () => {
    await expect(db.setProviderStrategyOverride("", { balanceStrategy: "lowest-first" })).rejects.toThrow();
  });
});
