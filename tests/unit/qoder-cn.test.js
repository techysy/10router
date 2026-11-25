import { describe, it, expect } from "vitest";
import { QoderExecutor } from "../../open-sse/executors/qoder.js";
import {
  QODER_CN_GATEWAY_BASE,
  QODER_CN_QUOTA_USAGE_URL,
  QODER_CN_LOGIN_URL,
  QODER_CN_DEVICE_TOKEN_URL,
  QODER_CN_USERINFO_URL,
  QODER_CN_JOB_TOKEN_EXCHANGE_URL,
} from "../../open-sse/shared/qoder/constants.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import qoderCnOAuth from "../../src/lib/oauth/providers/qoder-cn.js";
import { getQoderUsage } from "../../open-sse/services/usage/misc.js";
import { parseQuotaData, getConnectionLabel, maskEmailLabel } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

describe("qoder-cn provider registry & capabilities", () => {
  const reg = REGISTRY.find((p) => p.id === "qoder-cn");

  it("exists in registry with alias qdc", () => {
    expect(reg).toBeDefined();
    expect(reg.alias).toBe("qdc");
    expect(reg.category).toBe("oauth");
    expect(PROVIDERS["qoder-cn"]).toBeDefined();
    expect(PROVIDER_MODELS.qdc).toBeDefined();
    expect(PROVIDER_MODELS.qdc.length).toBeGreaterThan(0);
  });

  it("resolves capabilities for qoder-cn models without falling back to default", () => {
    const caps = getCapabilitiesForModel("qoder-cn", "qmodel_latest");
    expect(caps.vision).toBe(true);
    expect(caps.reasoning).toBe(true);
    expect(caps.contextWindow).toBe(1000000);
    expect(caps.maxOutput).toBe(65536);

    const glm = getCapabilitiesForModel("qoder-cn", "gm51model");
    expect(glm.reasoning).toBe(true);
    expect(glm.contextWindow).toBe(1000000);
    expect(glm.maxOutput).toBe(48000);

    const dmodel = getCapabilitiesForModel("qoder-cn", "dmodel");
    expect(dmodel.reasoning).toBe(true);
    expect(dmodel.contextWindow).toBe(1000000);
  });
});

describe("QoderExecutor (CN deployment)", () => {
  const executor = new QoderExecutor("qoder-cn", QODER_CN_GATEWAY_BASE);

  it("builds URL pointing to gateway.qoder.com.cn for CN deployment", () => {
    const url = executor.buildUrl({ accessToken: "dt-test-device-token" });
    expect(url).toContain("gateway.qoder.com.cn");
    expect(url).toContain("/algo/api/v2/service/pro/sse/agent_chat_generation");
  });

  it("builds URL pointing to gateway.qoder.com.cn for job tokens", () => {
    const url = executor.buildUrl({ accessToken: "jt-test-job-token" });
    expect(url).toContain("gateway.qoder.com.cn");
    expect(url).toContain("/algo/api/v2/service/pro/sse/agent_chat_generation");
  });
});

describe("qoder-cn OAuth configuration", () => {
  it("points to qoder.com.cn endpoints", () => {
    expect(qoderCnOAuth.config.loginUrl).toBe(QODER_CN_LOGIN_URL);
    expect(qoderCnOAuth.config.deviceTokenUrl).toBe(QODER_CN_DEVICE_TOKEN_URL);
    expect(qoderCnOAuth.config.userInfoUrl).toBe(QODER_CN_USERINFO_URL);
    expect(qoderCnOAuth.flowType).toBe("device_code");
  });

  it("maps tokens with displayName and providerSpecificData", () => {
    const mapped = qoderCnOAuth.mapTokens({
      access_token: "dt-token",
      refresh_token: "rt-token",
      expires_in: 86400,
      _qoderUserId: "uid-123",
      _qoderMachineId: "mid-456",
      _qoderName: "TestUser",
      _qoderEmail: "user@example.com",
      _qoderOrganizationId: "org-789",
    });

    expect(mapped.accessToken).toBe("dt-token");
    expect(mapped.email).toBe("user@example.com");
    expect(mapped.displayName).toBe("TestUser");
    expect(mapped.providerSpecificData.userId).toBe("uid-123");
    expect(mapped.providerSpecificData.machineId).toBe("mid-456");
  });
});

describe("qoder and qoder-cn quota normalization", () => {
  it("emits only buckets that carry allowance, and skips empty org/user", () => {
    // total=0 buckets used to be charted as "剩 0 / 0"; they carry no allowance,
    // so they are hidden now. Qoder accounts always have an empty `user` and
    // `organization`, which made the card half empty rows.
    const raw = {
      quotas: {
        user: { total: 0, used: 0, remaining: 0, unit: "credits" },
        addOn: { total: 600, used: 0, remaining: 600, unit: "credits" },
        organization: { total: 0, used: 0, remaining: 0, unit: "credits" },
      },
    };

    const cnNormalized = parseQuotaData("qoder-cn", raw);
    expect(cnNormalized).toHaveLength(1);
    expect(cnNormalized[0].name).toBe("Resource Package");
    expect(cnNormalized[0].total).toBe(600);

    const intlNormalized = parseQuotaData("qoder", {
      quotas: {
        user: { total: 0, used: 0, remaining: 0, unit: "credits" },
        addOn: { total: 100, used: 0, remaining: 100, unit: "credits" },
        organization: { total: 0, used: 0, remaining: 0, unit: "credits" },
      },
    });
    expect(intlNormalized).toHaveLength(1);
    expect(intlNormalized[0].name).toBe("Resource Package");
    expect(intlNormalized[0].total).toBe(100);
  });

  it("charts addOn as ONE aggregate row — packs are detail-only breakdown", () => {
    // Regression: charting addOn AND its packs[] double-counted the same credits
    // (500 + 100 inside a 600 total). The card charts the aggregate only; the
    // packs ride along `detailOnly` so the per-pack table keeps their dates.
    const raw = {
      quotas: {
        user: { total: 0, used: 0, remaining: 0, unit: "credits" },
        addOn: {
          total: 600,
          used: 100,
          remaining: 500,
          unit: "credits",
          resetAt: "2026-09-30T15:59:00.000Z",
          packs: [
            { total: 500, used: 100, remaining: 400, expiresAt: "2026-09-30T15:59:00.000Z" },
            { total: 100, used: 0, remaining: 100, expiresAt: "2026-10-18T02:00:00.000Z" },
          ],
        },
        organization: { total: 0, used: 0, remaining: 0, unit: "credits" },
      },
    };

    const normalized = parseQuotaData("qoder-cn", raw);
    const charted = normalized.filter((q) => !q.detailOnly);
    expect(charted.map((q) => q.name)).toEqual(["Resource Package"]);
    expect(normalized[0].total).toBe(600);
    expect(normalized[0].used).toBe(100);
    // Mixed per-pack expiries → no single countdown on the aggregate (matches
    // the official web UI); the dates live in the per-pack table.
    expect(normalized[0].resetAt).toBe(null);
    expect(normalized[0].aggregate).toBe(true);
    // Its packs are itemised below, so the details list them instead of it.
    expect(normalized[0].summarizesDetail).toBe(true);

    const packs = normalized.filter((q) => q.detailOnly);
    expect(packs.map((q) => q.name)).toEqual(["Bonus Pack 1", "Bonus Pack 2"]);
    expect(packs.map((q) => q.resetAt)).toEqual(["2026-09-30T15:59:00.000Z", "2026-10-18T02:00:00.000Z"]);
    expect(packs.every((q) => q.recurring === false)).toBe(true);
    // The detail rows are the breakdown: they sum to the aggregate, not beside it.
    expect(packs.reduce((s, q) => s + q.total, 0)).toBe(charted[0].total);
  });

  it("labels Qoder connections by display name, not email", () => {
    expect(
      getConnectionLabel({
        provider: "qoder",
        name: "i@techysy.com",
        email: "i@techysy.com",
        displayName: "ShiYanG Yu",
      }),
    ).toBe("ShiYanG Yu");
    expect(
      getConnectionLabel({
        provider: "qoder-cn",
        name: "yu_shiyang",
        email: "yu_shiyang",
        displayName: "yu_shiyang",
      }),
    ).toBe("yu_shiyang");
    // Non-Qoder providers keep preferring the connection name.
    expect(
      getConnectionLabel({
        provider: "codex",
        name: "user@example.com",
        displayName: "Some Name",
      }),
    ).toBe("user@example.com");

    // If user configured a custom name on Qoder/Qoder-CN, that custom name wins over displayName.
    expect(
      getConnectionLabel({
        provider: "qoder-cn",
        name: "主号",
        displayName: "yu_shiyang",
      }),
    ).toBe("主号");
    expect(
      getConnectionLabel({
        provider: "qoder",
        name: "备用",
        email: "i@shiyangyu.com",
        displayName: "ShiYanG Yu",
      }),
    ).toBe("备用");
  });

  it("QwenWork labels follow the Qoder privacy posture: displayName first, masked email when the account has none", () => {
    // Free intl accounts often have no profile name — the raw email must not
    // print (user report 2026-11-22「邮箱又显示出来了」).
    expect(
      getConnectionLabel({
        provider: "qwenwork",
        name: "techysy.ai@gmail.com",
        email: "techysy.ai@gmail.com",
        displayName: null,
      }),
    ).toBe("tec****@gmail.com");
    expect(
      getConnectionLabel({
        provider: "qwenwork-cn",
        name: "余师洋",
        email: "yu_shiyang@qq.com",
        displayName: "余师洋",
      }),
    ).toBe("余师洋");
    expect(
      getConnectionLabel({
        provider: "qwenwork",
        name: "我的连接",
        email: "techysy.ai@gmail.com",
        displayName: null,
      }),
    ).toBe("我的连接");
    // The mask helper itself: keep enough to recognize the account.
    expect(maskEmailLabel("abc@example.com")).toBe("abc****@example.com");
    expect(maskEmailLabel("ab@example.com")).toBe("ab****@example.com");
    expect(maskEmailLabel("no-at-sign")).toBe("no-at-sign");
  });
});
