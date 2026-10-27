import { describe, it, expect } from "vitest";
import { extractConnectionBalance } from "../../open-sse/services/usage/balanceExtractor.js";
import { getProviderQuotaCategory, PROVIDER_QUOTA_TYPES } from "../../open-sse/config/providerCategories.js";

describe("extractConnectionBalance", () => {
  it("extracts DeepSeek CNY balance", () => {
    const usage = {
      quotas: {
        "Balance (CNY)": { total: 45.67, used: 0, remainingPercentage: 100 },
      },
    };
    expect(extractConnectionBalance(usage)).toBe(45.67);
  });

  it("extracts StepFun USD balance with remaining", () => {
    const usage = {
      quotas: {
        "Balance (USD)": { total: 100, used: 20, remaining: 80 },
      },
    };
    expect(extractConnectionBalance(usage)).toBe(80);
  });

  it("extracts MiniMax Code credit balance", () => {
    const usage = {
      quotas: {
        Credits: { total: 1500, used: 300, isCreditBalance: true },
      },
    };
    expect(extractConnectionBalance(usage)).toBe(1200);
  });

  it("returns null for subscription only quotas", () => {
    const usage = {
      quotas: {
        "5 hours": { total: 100, used: 20, resetAt: "2026-10-23T20:00:00Z", recurring: true },
      },
    };
    expect(extractConnectionBalance(usage)).toBeNull();
  });

  it("returns null for empty or null usage", () => {
    expect(extractConnectionBalance(null)).toBeNull();
    expect(extractConnectionBalance({})).toBeNull();
    expect(extractConnectionBalance({ quotas: {} })).toBeNull();
  });
});

describe("getProviderQuotaCategory", () => {
  it("classifies minimax-code and minimax-code-global as PURE_BALANCE", () => {
    expect(getProviderQuotaCategory("minimax-code")).toBe(PROVIDER_QUOTA_TYPES.PURE_BALANCE);
    expect(getProviderQuotaCategory("minimax-code-global")).toBe(PROVIDER_QUOTA_TYPES.PURE_BALANCE);
  });
});
