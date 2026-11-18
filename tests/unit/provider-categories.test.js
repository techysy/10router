// Provider category audit: free-beta platforms must sit in the Free Tier
// section (category "freeTier"), paid platforms in the API-key section.
// Category drives UI grouping via byCategory() in src/shared/constants/providers.js.
import { describe, it, expect } from "vitest";

import {
  APIKEY_PROVIDERS,
  FREE_TIER_PROVIDERS,
} from "@/shared/constants/providers.js";

describe("provider categories", () => {
  it("groups free public-beta providers under freeTier", () => {
    expect(FREE_TIER_PROVIDERS.dots).toBeTruthy();
    expect(FREE_TIER_PROVIDERS.sensenova).toBeTruthy();
    expect(APIKEY_PROVIDERS.dots).toBeUndefined();
    expect(APIKEY_PROVIDERS.sensenova).toBeUndefined();
  });

  it("keeps paid platforms under apikey", () => {
    expect(APIKEY_PROVIDERS.longcat).toBeTruthy();
    expect(APIKEY_PROVIDERS.bai).toBeTruthy();
    expect(FREE_TIER_PROVIDERS.longcat).toBeUndefined();
    expect(FREE_TIER_PROVIDERS.bai).toBeUndefined();
  });

  it("free-beta entries declare apikey-only auth (no oauth on the card)", () => {
    for (const id of ["dots", "sensenova"]) {
      expect(FREE_TIER_PROVIDERS[id].authType).toBe("apikey");
      expect(FREE_TIER_PROVIDERS[id].authModes).toEqual(["apikey"]);
      // Key acquisition link must survive the category move.
      expect(FREE_TIER_PROVIDERS[id].notice?.apiKeyUrl).toBeTruthy();
    }
  });

  it("dots carries the freeTrial flag (docs list prices but billing is 0)", () => {
    // 2026-11-18 官方定价页核验:$0.14/$0.28 已挂出但「暂不收费」。
    // 卡片据此渲染绿色「免费」徽章;恢复收费时删 registry 的 freeTrial。
    expect(FREE_TIER_PROVIDERS.dots.freeTrial).toBe(true);
    // sensenova 的收费状态未逐页核验,不挂旗标。
    expect(FREE_TIER_PROVIDERS.sensenova.freeTrial).toBeUndefined();
  });
});
