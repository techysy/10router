import { describe, expect, it } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import {
  PROVIDER_CAPABILITIES,
  getCapabilitiesForModel,
} from "../../open-sse/providers/capabilities.js";

/**
 * Every transport/UI spelling of a provider must reach that provider's own
 * capability rows.
 *
 * getCapabilitiesForModel looks up PROVIDER_CAPABILITIES[spelling] with no alias
 * normalization of its own, and combo seats / custom-model providerAlias / the
 * AI_MODELS prefix all use the short spellings. A spelling that is not wired to
 * its provider's table silently falls through MODEL → PATTERN → DEFAULT, so the
 * same model gets a different window and a different thinkingFormat depending on
 * how it was written:
 *
 *   tokenharbor/claude-haiku-5.5:free  →  1000000 / 128000  claude-adaptive
 *   th/claude-haiku-5.5:free           →   200000 /  64000  claude-budget
 *
 * That is not hypothetical — `cbai` shipped that way, and `th`/`thh`/`ps`/
 * `atria-asi` were all missing until this test existed. The shims themselves are
 * hand-written in capabilities.js (the registry cannot be imported from there:
 * registry/*.js import capabilities.js, so a top-level REGISTRY import is a cycle
 * that hits the TDZ). This test derives the REQUIRED set from the registry, so
 * forgetting to add a line fails here instead of degrading silently.
 */
const spellingsOf = (p) =>
  [p.alias, p.uiAlias, ...(Array.isArray(p.aliases) ? p.aliases : [])].filter(Boolean);

describe("capability alias shims", () => {
  it("wires every provider spelling to that provider's own capability table", () => {
    const missing = [];
    const drifted = [];
    for (const p of REGISTRY) {
      const idCaps = PROVIDER_CAPABILITIES[p.id];
      if (!idCaps) continue; // nothing to share
      for (const name of new Set(spellingsOf(p))) {
        if (name === p.id) continue;
        const aliasCaps = PROVIDER_CAPABILITIES[name];
        if (aliasCaps === undefined) missing.push(`${name} (spelling of ${p.id})`);
        else if (aliasCaps !== idCaps) drifted.push(`${name} (spelling of ${p.id})`);
      }
    }
    expect(missing, `spellings with no capability shim:\n${missing.join("\n")}`).toEqual([]);
    expect(drifted, `spellings pointing at a different table:\n${drifted.join("\n")}`).toEqual([]);
  });

  it("resolves alias spellings to the same caps as the canonical id", () => {
    // The regression that shipped: `th` vs `tokenharbor` on the same pinned row.
    for (const [alias, id, model] of [
      ["th", "tokenharbor", "claude-haiku-5.5:free"],
      ["thh", "tokenharbor", "claude-haiku-5.5:free"],
      ["ps", "poolside", "laguna-s-2.1"],
      ["atria-asi", "atria", "atria"],
      ["cbai", "codebuddy-intl", "space-bunny-free"],
      ["qd", "qoder", "qfmodel"],
      ["qdc", "qoder-cn", "qfmodel"],
      ["cx", "codex", "gpt-5.5-codex"],
    ]) {
      expect(getCapabilitiesForModel(alias, model), `${alias}/${model}`).toEqual(
        getCapabilitiesForModel(id, model)
      );
    }
  });

  it("keeps the tokenharbor haiku row off the 200K floor under every spelling", () => {
    for (const spelling of ["tokenharbor", "th", "thh"]) {
      const caps = getCapabilitiesForModel(spelling, "claude-haiku-5.5:free");
      expect(caps.contextWindow, `${spelling} hit the floor`).toBe(1000000);
      expect(caps.thinkingFormat, `${spelling} picked the wrong thinking shape`).toBe(
        "claude-adaptive"
      );
    }
  });
});
