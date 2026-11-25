import { describe, it, expect } from "vitest";

import { APIKEY_PROVIDERS, getProviderByAlias } from "../../src/shared/constants/providers.js";
import { getModelsByProviderId } from "../../open-sse/config/providerModels.js";
import { parseModel } from "../../open-sse/services/model.js";

describe("Nace Drex System One provider", () => {
  it("registers nace in APIKEY_PROVIDERS with systemone service kind", () => {
    const p = APIKEY_PROVIDERS.nace;
    expect(p).toBeDefined();
    expect(p.serviceKinds).toContain("systemone");
    expect(p.systemoneConfig).toMatchObject({
      baseUrl: "https://console.nace.ai/v1/systemone",
      authType: "apikey",
      authHeader: "bearer",
    });
  });

  it("exposes drex-max and drex-v2.0 models", () => {
    const models = getModelsByProviderId("nace");
    const ids = models.map((m) => m.id);
    expect(ids).toContain("drex-max");
    expect(ids).toContain("drex-v2.0");
  });

  it("resolves alias nace to nace provider", () => {
    expect(getProviderByAlias("nace")?.id).toBe("nace");
    expect(parseModel("nace/drex-max")).toMatchObject({
      provider: "nace",
      model: "drex-max",
    });
  });
});
