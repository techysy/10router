import { describe, it, expect } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import antigravityRegistry from "../../open-sse/providers/registry/antigravity.js";
import { MODEL_PRICING } from "../../open-sse/providers/pricing.js";

describe("Gemini 3.8 Flash Support (Antigravity agy)", () => {
  it("registers gemini-3.8-flash tiered models in antigravity provider registry", () => {
    const agIds = antigravityRegistry.models.map(m => m.id);
    expect(agIds).toContain("gemini-3.8-flash-high");
    expect(agIds).toContain("gemini-3.8-flash-medium");
    expect(agIds).toContain("gemini-3.8-flash-low");
    expect(agIds).toContain("gemini-3.8-flash");
  });

  it("maps 3.8 models to their own tiered entity ids (matches 9router 70f15aa)", () => {
    // 9router 70f15aa: 3.8 has its own tiered family — upstream serves
    // `gemini-3.8-flash-<tier>(<level>)`; the bare id 404s "Requested entity
    // was not found". The un-tiered alias routes to the medium tier.
    const byId = Object.fromEntries(antigravityRegistry.models.map(m => [m.id, m]));
    expect(byId["gemini-3.8-flash-high"].upstreamModelId).toBe("gemini-3.8-flash-high(high)");
    expect(byId["gemini-3.8-flash-medium"].upstreamModelId).toBe("gemini-3.8-flash-medium(medium)");
    expect(byId["gemini-3.8-flash-low"].upstreamModelId).toBe("gemini-3.8-flash-low(low)");
    expect(byId["gemini-3.8-flash"].upstreamModelId).toBe("gemini-3.8-flash-medium(medium)");
  });

  it("resolves capabilities correctly for gemini-3.8 models", () => {
    const caps = getCapabilitiesForModel("antigravity", "gemini-3.8-flash-high");
    expect(caps.vision).toBe(true);
    expect(caps.reasoning).toBe(true);
    expect(caps.thinkingFormat).toBe("gemini-level");
    expect(caps.contextWindow).toBe(1048576);
    expect(caps.maxOutput).toBe(65536);
  });

  it("defines pricing matching gemini-3.7-flash baseline", () => {
    expect(MODEL_PRICING["gemini-3.8-flash"]).toEqual(MODEL_PRICING["gemini-3.7-flash"]);
    expect(MODEL_PRICING["gemini-3.8-flash-high"]).toEqual(MODEL_PRICING["gemini-3.7-flash-high"]);
    expect(MODEL_PRICING["gemini-3.8-flash-medium"]).toEqual(MODEL_PRICING["gemini-3.7-flash-medium"]);
    expect(MODEL_PRICING["gemini-3.8-flash-low"]).toEqual(MODEL_PRICING["gemini-3.7-flash-low"]);
  });
});
