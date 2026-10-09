import { describe, expect, it } from "vitest";
import {
  PROVIDER_MODELS,
  PROVIDER_ID_TO_ALIAS,
  getModelSupportedFormats,
  getModelTargetFormat,
  getModelStrip,
  getProviderModels,
} from "../../open-sse/config/providerModels.js";

/**
 * PROVIDER_MODELS is keyed by `alias || id`, so the two spellings of a provider
 * are not interchangeable — `opencode-zen` is stored as `ocz`, `qoder-cn` as
 * `qdc`. The accessors used to do a raw key lookup, which returned "no such
 * model" for the canonical id: null supportedFormats, no targetFormat, no strip
 * list. chatCore converts first, so production was fine, but a test or a new
 * caller that passed the id asserted nothing and still went green. That is how
 * a whole "15 models are missing their format declarations" reading happened:
 * the probe passed `opencode-zen`, got null, and the registry was never at
 * fault. The accessors normalise now; this pins it.
 */
const CASES = [
  // [id, alias, a model that exists in both spellings' catalogue]
  ["opencode-zen", "ocz", "claude-sonnet-5-5"],
  ["qoder-cn", "qdc", "qfmodel"],
  ["qoder", "qd", "qfmodel"],
  ["codebuddy-intl", "cbai", "space-bunny-free"],
];

describe("provider model lookups accept either spelling", () => {
  it("resolves the same catalogue by id and by alias", () => {
    for (const [id, alias] of CASES) {
      const byId = getProviderModels(id);
      const byAlias = getProviderModels(alias);
      expect(byId.length, `${id} vs ${alias}: catalogue size`).toBe(byAlias.length);
      expect(byId.length, `${id} resolved to an empty catalogue`).toBeGreaterThan(0);
    }
  });

  it("resolves the same supportedFormats by id and by alias", () => {
    for (const [id, alias, model] of CASES) {
      expect(getModelSupportedFormats(id, model), `${id}/${model} vs ${alias}/${model}`).toEqual(
        getModelSupportedFormats(alias, model)
      );
    }
    // And a model that DOES declare formats must not look undeclared under the
    // canonical id — the exact misreading that produced a phantom "15 models
    // are missing their declarations" finding.
    expect(getModelSupportedFormats("opencode-zen", "claude-sonnet-5-5")).toEqual(["claude"]);
    expect(getModelSupportedFormats("opencode-zen", "gemini-3.8-flash")).toEqual(["openai"]);
  });

  it("resolves the same targetFormat and strip list by id and by alias", () => {
    for (const [id, alias, model] of CASES) {
      expect(getModelTargetFormat(id, model), `${id}/${model} targetFormat`).toEqual(
        getModelTargetFormat(alias, model)
      );
      expect(getModelStrip(id, model), `${id}/${model} strip`).toEqual(
        getModelStrip(alias, model)
      );
    }
  });

  it("still returns null for a model that genuinely does not exist", () => {
    // Normalisation must not turn a miss into a hit.
    expect(getModelSupportedFormats("opencode-zen", "no-such-model-at-all")).toBeNull();
  });

  it("every provider whose id and alias differ is covered by the lookup", () => {
    // The case list above is a sample; this is the sweep. Any provider with a
    // distinct alias must resolve to a non-empty catalogue by BOTH spellings,
    // otherwise the sample could drift while the bug is already back.
    const divergent = Object.entries(PROVIDER_ID_TO_ALIAS).filter(([id, alias]) => id !== alias);
    expect(divergent.length).toBeGreaterThan(20);
    const empty = [];
    for (const [id, alias] of divergent) {
      // Skip providers with no catalogue at all (some store an empty list —
      // e.g. zed — which is truthy but has nothing to resolve).
      if (!PROVIDER_MODELS[alias]?.length) continue;
      if (getProviderModels(id).length === 0) empty.push(id);
    }
    expect(empty, `id spelling resolves to an empty catalogue:\n${empty.join("\n")}`).toEqual([]);
  });
});
