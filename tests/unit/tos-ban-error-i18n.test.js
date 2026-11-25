// 账号封禁（ToS violation）错误文案的 i18n 与分支判定。
// 2026-11-06 反重力三账号全灭实测（HTTP 403）：
//   "This service has been disabled in this account for violation of Terms of
//    Service. Please submit an appeal to continue using this product."
// 关键性质：封禁不会重置 —— 措辞必须引导申诉，绝不能落进 429 的「等待重置」
// 模板让用户干等一个不会来的恢复。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { translateQuotaError } from "@/shared/utils/quotaError.js";

const rootDir = resolve(__dirname, "../..");

// 真实上游 payload（截自 NAS 配额测试行）。
const REAL_TOS_BAN_ERROR =
  "This service has been disabled in this account for violation of Terms of Service. Please submit an appeal to continue using this product.";

describe("ToS ban error i18n（账号封禁 ≠ 额度烧穿）", () => {
  const zhCN = JSON.parse(readFileSync(resolve(rootDir, "public/i18n/literals/zh-CN.json"), "utf8"));
  const zhTW = JSON.parse(readFileSync(resolve(rootDir, "public/i18n/literals/zh-TW.json"), "utf8"));
  const BAN_KEY = "This account has been disabled by the provider for violating its Terms of Service. Submit an appeal on the provider's console to restore it.";

  it("三语字典都有封禁模板，且含「申诉」引导", () => {
    expect(zhCN[BAN_KEY]).toContain("封禁");
    expect(zhCN[BAN_KEY]).toContain("申诉");
    expect(zhTW[BAN_KEY]).toContain("封禁");
    expect(zhTW[BAN_KEY]).toContain("申訴");
  });

  it("封禁措辞绝不渲染成等待重置", () => {
    for (const dict of [zhCN, zhTW]) {
      const msg = dict[BAN_KEY];
      expect(msg).not.toMatch(/重置|重啟|resets?/i);
    }
  });

  it("translateQuotaError 把真实封禁 payload 映射到封禁模板", () => {
    const msg = translateQuotaError(REAL_TOS_BAN_ERROR);
    // zh 测试环境下返回中文模板；en 直接原样回显 key 文本。
    expect(msg === zhCN[BAN_KEY] || msg === BAN_KEY).toBe(true);
    expect(msg).not.toContain("Individual quota reached");
  });

  it("封禁分支优先于额度分支（payload 同时含两类特征时封禁赢）", () => {
    const mixed = `${REAL_TOS_BAN_ERROR} [429]: Individual quota reached. Resets in 1h.`;
    const msg = translateQuotaError(mixed);
    expect(msg).not.toContain("额度已用完");
  });

  it("普通 429 额度耗尽不受封禁分支影响（回归）", () => {
    const msg = translateQuotaError(
      "[429]: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h27m36s.",
    );
    expect(msg).not.toBe(BAN_KEY);
  });
});
