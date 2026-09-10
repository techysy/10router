import { describe, expect, it } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

// Every DeepSeek V4 entry the registry actually offers, paired with its provider.
const OFFERED = REGISTRY.flatMap((entry) =>
  (entry.models || [])
    .map((m) => (typeof m === "string" ? m : m.id))
    .filter((id) => id && /deepseek-v4/i.test(id))
    .map((id) => ({ provider: entry.id, id }))
);

const VISION_EXP = OFFERED.filter((m) => /vision/i.test(m.id));
// V4.1-Flash (and its thinker variants) is multimodal per its model card and
// models.dev; everything else in the family is text→text.
const MULTIMODAL = OFFERED.filter((m) => /v4\.1-flash/i.test(m.id));
const TEXT_ONLY = OFFERED.filter((m) => !/vision|v4\.1-flash/i.test(m.id));

describe("DeepSeek V4 capability resolution", () => {
  it("offers both a vision and a text variant (sanity check on the fixture)", () => {
    expect(VISION_EXP.length).toBeGreaterThan(0);
    expect(TEXT_ONLY.length).toBeGreaterThan(0);
  });

  it("reports vision on every provider that serves the -vision-exp id", () => {
    // The id was previously only declared inside the codebuddy-cn block, so the
    // four providers that really serve it (commandcode / deepseek / opencode-go /
    // B.AI) all fell through to the *deepseek-v4* pattern, which declares no
    // vision at all — images were stripped before dispatch even though the model
    // reads them. The canonical MODEL_CAPABILITIES row fixes every provider at
    // once; this guard keeps a future provider from missing it.
    expect(VISION_EXP.length).toBeGreaterThanOrEqual(4);
    for (const { provider, id } of VISION_EXP) {
      const caps = getCapabilitiesForModel(provider, id);
      expect(`${provider}/${id} vision=${caps.vision}`).toBe(`${provider}/${id} vision=true`);
      expect(caps.maxOutput).toBe(384000);
      expect(caps.contextWindow).toBe(1000000);
    }
  });

  it("keeps plain V4 Flash / V4 Pro text-only", () => {
    // deepseek-v4-flash / deepseek-v4-pro are text→text (the model card says so
    // for V4-Pro, Ark's first-party deepseek-v4-flash-ga-260731 and
    // deepseek-v4-pro-ga-260813 both report attach:false, and every models.dev
    // entry agrees). An earlier revision of the V4.1-Flash entry claimed
    // vision:true for deepseek-v4-flash because the model card lists it as a
    // sibling id — that would have sent images to a text-only upstream.
    expect(TEXT_ONLY.length).toBeGreaterThan(10);
    for (const { provider, id } of TEXT_ONLY) {
      expect(`${provider}/${id} vision=${getCapabilitiesForModel(provider, id).vision}`).toBe(`${provider}/${id} vision=false`);
    }
  });

  it("keeps V4.1-Flash multimodal", () => {
    expect(MULTIMODAL.length).toBeGreaterThan(0);
    for (const { provider, id } of MULTIMODAL) {
      expect(getCapabilitiesForModel(provider, id).vision).toBe(true);
    }
  });
});
