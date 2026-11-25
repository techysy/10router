import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const rootDir = resolve(__dirname, "../..");

describe("Usage Quota & Provider Limits i18n", () => {
  const zhCN = JSON.parse(readFileSync(resolve(rootDir, "public/i18n/literals/zh-CN.json"), "utf8"));
  const zhTW = JSON.parse(readFileSync(resolve(rootDir, "public/i18n/literals/zh-TW.json"), "utf8"));

  it("zh-CN dictionary contains required quota names and notice translations", () => {
    expect(zhCN["session (5h)"]).toBe("滚动");
    expect(zhCN["weekly (7d)"]).toBe("每周");
    expect(zhCN["Personal"]).toBe("个人");
    expect(zhCN["Organization"]).toBe("组织");
    expect(zhCN["Balance"]).toBe("余额");
    expect(zhCN["Balance (CNY)"]).toBe("余额 (CNY)");
    expect(zhCN["Balance (USD)"]).toBe("余额 (USD)");
    expect(zhCN["Balance ($)"]).toBe("余额 ($)");
    expect(zhCN["MiniMax API key invalid or inactive. Use an active Token/Coding Plan key."]).toContain("MiniMax API 密钥无效或未激活");
    expect(zhCN["Xiaomi MiMo Desktop not connected. Add credentials to view usage."]).toContain("小米 MiMo 桌面版未连接");
    expect(zhCN["Weekly quota requires Xiaomi account session. API key alone is insufficient."]).toContain("每周配额需要小米账号会话");
    expect(zhCN["Billed at standard API / plan rates — no separate quota to display."]).toContain("无独立配额");
    expect(zhCN["MiniMax API key not available."]).toBe("未提供 MiniMax API 密钥。");
    expect(zhCN["Command Code API key not configured."]).toBe("Command Code API 密钥未配置。");
    expect(zhCN["Command Code API key invalid or expired."]).toBe("Command Code API 密钥无效或已过期。");
    expect(zhCN["Qoder usage unavailable: no access token"]).toBe("Qoder 用量不可用：无访问令牌");
    expect(zhCN["Last 7 days (≥50 real requests)"]).toBe("最近 7 天（≥50 次真实有效请求）");
    expect(zhCN["No nodes with 50+ requests in this period"]).toBe("本时间段内没有请求数达到 50 的节点");
  });

  it("zh-TW dictionary contains required quota names and notice translations", () => {
    expect(zhTW["session (5h)"]).toBe("滾動");
    expect(zhTW["weekly (7d)"]).toBe("每週");
    expect(zhTW["Personal"]).toBe("個人");
    expect(zhTW["Organization"]).toBe("組織");
    expect(zhTW["Balance"]).toBe("餘額");
    expect(zhTW["Balance (CNY)"]).toBe("餘額 (CNY)");
    expect(zhTW["Balance (USD)"]).toBe("餘額 (USD)");
    expect(zhTW["Balance ($)"]).toBe("餘額 ($)");
    expect(zhTW["MiniMax API key invalid or inactive. Use an active Token/Coding Plan key."]).toContain("MiniMax API 金鑰無效或未啟用");
    expect(zhTW["Xiaomi MiMo Desktop not connected. Add credentials to view usage."]).toContain("小米 MiMo 桌面版未連線");
    expect(zhTW["Weekly quota requires Xiaomi account session. API key alone is insufficient."]).toContain("每週配額需要小米帳號工作階段");
    expect(zhTW["Billed at standard API / plan rates — no separate quota to display."]).toContain("無獨立配額");
    expect(zhTW["MiniMax API key not available."]).toBe("未提供 MiniMax API 金鑰。");
    expect(zhTW["Command Code API key not configured."]).toBe("Command Code API 金鑰未設定。");
    expect(zhTW["Command Code API key invalid or expired."]).toBe("Command Code API 金鑰無效或已過期。");
    expect(zhTW["Qoder usage unavailable: no access token"]).toBe("Qoder 用量無法使用：無存取權杖");
    expect(zhTW["Last 7 days (≥50 real requests)"]).toBe("最近 7 天（≥50 次真實有效請求）");
    expect(zhTW["No nodes with 50+ requests in this period"]).toBe("本時間段內沒有請求數達到 50 的節點");
  });

  it("ProviderLimitCard pipes quota.name through translateQuotaName and error/message through translate", () => {
    const src = readFileSync(
      resolve(rootDir, "src/app/(dashboard)/dashboard/usage/components/ProviderLimits/ProviderLimitCard.js"),
      "utf8",
    );
    expect(src).toContain("label={translateQuotaName(quota.name)}");
    expect(src).toContain("{translate(message)}");
    expect(src).toContain("{translate(error)}");
    expect(src).toContain('title={translate("Refresh quota")}');
    expect(src).toContain('{translate("No quota data available")}');
  });

  it("QuotaProgressBar pipes label through translateQuotaName", () => {
    const src = readFileSync(
      resolve(rootDir, "src/app/(dashboard)/dashboard/usage/components/ProviderLimits/QuotaProgressBar.js"),
      "utf8",
    );
    expect(src).toContain("{translateQuotaName(label)}");
    expect(src).toContain("{translate(resetWord)}");
  });

  it("QuotaTable defines translateQuotaName with pattern support for Bonus Pack, weekly, and Balance", () => {
    const quotaNameSrc = readFileSync(
      resolve(rootDir, "src/shared/utils/quotaName.js"),
      "utf8",
    );
    expect(quotaNameSrc).toContain("export function translateQuotaName(name)");
    expect(quotaNameSrc).toContain("Bonus Pack");
    expect(quotaNameSrc).toContain("weekly");
    expect(quotaNameSrc).toContain("Balance");

    const tableSrc = readFileSync(
      resolve(rootDir, "src/app/(dashboard)/dashboard/usage/components/ProviderLimits/QuotaTable.js"),
      "utf8",
    );
    expect(tableSrc).toContain("export { translateQuotaName }");
  });

  it("Croli quota card strings are localized (trial row name, wallet line, credits unit)", () => {
    expect(zhCN["Trial daily allowance"]).toBe("试用每日额度");
    expect(zhCN["Croli wallet balance"]).toBe("Croli 钱包余额");
    expect(zhCN["Separate from daily trial quota"]).toBe("与每日试用额度分开");
    expect(zhCN["credits"]).toBe("积分");
    expect(zhTW["Trial daily allowance"]).toBe("試用每日額度");
    expect(zhTW["Croli wallet balance"]).toBe("Croli 錢包餘額");
    expect(zhTW["Separate from daily trial quota"]).toBe("與每日試用額度分開");
    expect(zhTW["credits"]).toBe("積分");

    // The wallet line must pipe its strings through translate(), not render
    // them as hardcoded JSX text (the row name goes via QuotaTable's
    // translateQuotaName, which resolves through the same dictionaries).
    const indexSrc = readFileSync(
      resolve(rootDir, "src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js"),
      "utf8",
    );
    expect(indexSrc).toContain('{translate("Croli wallet balance")}');
    expect(indexSrc).toContain("{translate(\"credits\")}");
    expect(indexSrc).toContain('{translate("Separate from daily trial quota")}');
    expect(indexSrc).not.toMatch(/>Croli wallet balance </);
    expect(indexSrc).not.toMatch(/>Separate from daily trial quota</);
  });
});
