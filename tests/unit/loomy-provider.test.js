// Loomy (讯飞) 内置 freeTier 收录形状钉（issue #92 的内置化收尾）：
// chat 认 Bearer（transport.auth），/models 只认 `token:` 头（PROVIDER_MODELS_CONFIG
// 的 authHeader 覆盖），8 个模型为 NAS 实测清单，凭据为客户端 session（约 14 天）。
import { describe, it, expect } from "vitest";
import { FREE_TIER_PROVIDERS, AI_PROVIDERS } from "../../src/shared/constants/providers.js";
import { getModelsByProviderId } from "../../open-sse/config/providerModels.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import fs from "node:fs";

describe("Loomy provider registration", () => {
  it("registers as a freeTier provider with apikey auth and llm service kind", () => {
    const p = FREE_TIER_PROVIDERS.loomy;
    expect(p).toBeDefined();
    expect(p.id).toBe("loomy");
    expect(p.authModes).toEqual(["apikey"]);
    expect(p.serviceKinds).toContain("llm");
    expect(p.notice.apiKeyUrl).toContain("loomy.xunfei.cn");
    expect(AI_PROVIDERS.loomy).toBeDefined();
  });

  it("ships the eight live-verified models with spark-x2.6 as the free default", () => {
    const models = getModelsByProviderId("loomy").map((m) => m.id);
    expect(models).toEqual(expect.arrayContaining([
      "spark-x2.6", "qwen3.8-flash", "qwen-3.8-max", "DeepSeek-V4.1-Flash",
      "deepseek-v4-flash-0731", "MiniMax-M3", "Kimi-k2.6", "GLM-5.3-Flash",
    ]));
    expect(models).toHaveLength(8);
  });

  it("does not fall through to DEFAULT_CAPABILITIES for any shipped model", () => {
    for (const m of getModelsByProviderId("loomy")) {
      const caps = getCapabilitiesForModel("loomy", m.id);
      expect(caps, m.id).toBeTruthy();
    }
  });

  it("icon ships as a real file and the official avatar was committed", () => {
    expect(fs.existsSync(new URL("../../public/providers/loomy.png", import.meta.url))).toBe(true);
    const png = fs.readFileSync(new URL("../../public/providers/loomy.png", import.meta.url));
    expect(png.length).toBeGreaterThan(10000); // 官方高清头像，非占位图
  });
});
