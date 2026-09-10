import { describe, expect, it } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { resolveStep } from "../../scripts/audit-capabilities.mjs";

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
    }
    // The 1M/384000 numbers above are DeepSeek's published ceiling, not a law of
    // nature: a reseller may override them with its own (more conservative)
    // hints, and its id casing may not even hit the canonical row. Assert the
    // canonical profile through a lookup that actually resolves to it.
    expect(resolveStep("deepseek", "deepseek-v4-flash-vision-exp").step).toBe("canonical");
    expect(getCapabilitiesForModel("deepseek", "deepseek-v4-flash-vision-exp")).toMatchObject({
      maxOutput: 384000,
      contextWindow: 1000000,
    });
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

// `deepseek-flash` is the official id DeepSeek introduced on 2026-09-10 for
// V4.1-Flash ("Change the model name to deepseek-flash to call the latest V4.1
// Flash model"), and opencode-go exposes the same bare id. Without a canonical row
// the id falls through to the `*deepseek*` pattern — the V3.2 profile of 128K
// context / 64000 output / no vision — so images are stripped and max_tokens is
// clamped six times under the real ceiling.
const OFFICIAL_ID = REGISTRY.flatMap((entry) =>
  (entry.models || [])
    .map((m) => (typeof m === "string" ? m : m.id))
    .filter((id) => id === "deepseek-flash")
    .map((id) => ({ provider: entry.id, id }))
);

describe("DeepSeek V4.1-Flash official id (deepseek-flash)", () => {
  it("is offered by the first-party provider and by opencode-go", () => {
    const providers = OFFICIAL_ID.map((m) => m.provider).sort();
    expect(providers).toEqual(["deepseek", "opencode-go"]);
  });

  it("resolves from the canonical row, not the V3 *deepseek* wildcard", () => {
    for (const { provider, id } of OFFICIAL_ID) {
      const step = resolveStep(provider, id);
      expect(`${provider}/${id} ${step.step}:${step.key}`).toBe(`${provider}/${id} canonical:${id}`);
    }
  });

  it("carries the first-party V4.1-Flash profile", () => {
    // Values from DeepSeek's Models & Pricing table: 1M context, MAX OUTPUT 384K,
    // Vision ✓ (native multimodal), thinking on by default and switchable off.
    for (const { provider, id } of OFFICIAL_ID) {
      expect(getCapabilitiesForModel(provider, id)).toMatchObject({
        vision: true,
        reasoning: true,
        thinkingFormat: "deepseek",
        contextWindow: 1000000,
        maxOutput: 384000,
      });
    }
  });
});

// opencode-go's own docs table lists the V4.1-Flash id as `deepseek-v4.1-flash` (its
// public /models catalog carries both that and `deepseek-flash`), and codebuddy-cn
// serves the same id through its OpenAI-compatible gateway.
const DOTTED_ID = REGISTRY.flatMap((entry) =>
  (entry.models || [])
    .map((m) => (typeof m === "string" ? m : m.id))
    .filter((id) => id === "deepseek-v4.1-flash")
    .map((id) => ({ provider: entry.id, id }))
);

describe("DeepSeek V4.1-Flash id with dots (deepseek-v4.1-flash)", () => {
  it("is offered by opencode-go and codebuddy-cn", () => {
    expect(DOTTED_ID.map((m) => m.provider).sort()).toEqual(["codebuddy-cn", "opencode-go"]);
  });

  it("resolves from the canonical row where the provider has no override", () => {
    const step = resolveStep("opencode-go", "deepseek-v4.1-flash");
    expect(`${step.step}:${step.key}`).toBe("canonical:deepseek-v4.1-flash");
    expect(getCapabilitiesForModel("opencode-go", "deepseek-v4.1-flash")).toMatchObject({
      vision: true,
      reasoning: true,
      thinkingFormat: "deepseek",
      contextWindow: 1000000,
      maxOutput: 384000,
    });
  });

  it("keeps codebuddy-cn on its provider-exact override (openai thinking shape)", () => {
    // The canonical row must not leak the `deepseek` thinking format into CN — its
    // gateway is OpenAI-compatible, and the provider row wins over canonical.
    const step = resolveStep("codebuddy-cn", "deepseek-v4.1-flash");
    expect(`${step.step}:${step.key}`).toBe("provider:deepseek-v4.1-flash");
    expect(getCapabilitiesForModel("codebuddy-cn", "deepseek-v4.1-flash")).toMatchObject({
      vision: true,
      reasoning: true,
      thinkingFormat: "openai",
      thinkingCanDisable: true,
      contextWindow: 1000000,
      maxOutput: 384000,
    });
  });
});
