import { describe, it, expect } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { resolveProviderAlias, parseModel } from "open-sse/services/model.js";

/**
 * Global guard against alias hijacking across the provider registry.
 *
 * `open-sse/services/model.js` builds a single alias -> providerId map by walking
 * the registry in order, last writer wins. So when two providers list the same
 * alias, the one registered later silently steals every request for the other —
 * exactly what happened when StepFun CN added `sfcn`, which SiliconFlow CN has
 * owned since v1.1.3 (verify-alias's token list even baked the wrong mapping in).
 *
 * A provider publishes its spelling in FOUR places, and each one feeds a
 * different map. A collision in any of them degrades silently:
 *
 *   id, alias, aliases[]  -> ALIAS_TO_PROVIDER_ID   (request routing, parseModel)
 *   alias || id           -> PROVIDER_MODELS key     (which catalogue a lookup hits)
 *   uiAlias || alias || id-> loadKeyGroups canonical (disabled-models / modelCaps)
 *   uiAlias || alias      -> validProviderIds        (/api/models custom-model owner)
 *
 * The first version of this file walked only `aliases[]`, which is how two
 * whole collisions got in unnoticed: `tr` claimed by Trae's `alias`/`uiAlias`
 * and TokenRouter's `aliases[]`, and `mmf` claimed by Mimo Free's
 * `alias`/`uiAlias` and the provider whose id *is* `mmf`. Both were invisible
 * because the fields carrying them were never read. Walk every spelling.
 */
const spellingsOf = (p) =>
  [p.id, p.alias, p.uiAlias, ...(Array.isArray(p.aliases) ? p.aliases : [])].filter(Boolean);

describe("provider registry alias uniqueness", () => {
  it("no spelling is claimed by more than one provider (id/alias/uiAlias/aliases)", () => {
    const owners = new Map(); // spelling -> Set(providerId)
    for (const p of REGISTRY) {
      for (const a of spellingsOf(p)) {
        if (!owners.has(a)) owners.set(a, new Set());
        owners.get(a).add(p.id);
      }
    }
    const collisions = [...owners.entries()]
      .filter(([, ids]) => ids.size > 1)
      .map(([a, ids]) => `${a} -> ${[...ids].join(", ")}`);
    expect(
      collisions,
      `spellings claimed by multiple providers:\n${collisions.join("\n")}`
    ).toEqual([]);
  });

  it("no spelling shadows a different provider's id", () => {
    const ids = new Set(REGISTRY.map((p) => p.id));
    const conflicts = [];
    for (const p of REGISTRY) {
      for (const a of spellingsOf(p)) {
        if (a !== p.id && ids.has(a)) {
          conflicts.push(`${a} (spelling of ${p.id}) collides with a provider id`);
        }
      }
    }
    expect(conflicts, conflicts.join("\n")).toEqual([]);
  });

  it("every request-routing spelling resolves back to its own provider", () => {
    // ALIAS_TO_PROVIDER_ID is written from id, alias and aliases[] (not uiAlias).
    // A spelling that resolves to someone else is live misrouting.
    const wrong = [];
    for (const p of REGISTRY) {
      for (const a of [p.id, p.alias, ...(Array.isArray(p.aliases) ? p.aliases : [])].filter(Boolean)) {
        const got = resolveProviderAlias(a);
        if (got !== p.id) wrong.push(`${a} -> ${got} (expected ${p.id})`);
      }
    }
    expect(wrong, wrong.join("\n")).toEqual([]);
  });

  it("every uiAlias is also a request-routing spelling", () => {
    // /api/models puts uiAlias into validProviderIds, so a custom model may be
    // filed under it. parseModel then resolves it through ALIAS_TO_PROVIDER_ID —
    // if the registry never claims it there, the prefix falls through unchanged
    // and the model lands on a provider that does not exist.
    const unreachable = [];
    for (const p of REGISTRY) {
      if (!p.uiAlias || p.uiAlias === p.id) continue;
      const claimed = [p.id, p.alias, ...(Array.isArray(p.aliases) ? p.aliases : [])].filter(Boolean);
      if (!claimed.includes(p.uiAlias)) unreachable.push(`${p.uiAlias} (uiAlias of ${p.id})`);
    }
    expect(unreachable, unreachable.join("\n")).toEqual([]);
  });

  it("PROVIDER_MODELS is keyed uniquely (alias || id)", () => {
    // providers/index.js does PROVIDER_MODELS[entry.alias || entry.id] = models,
    // so two entries sharing that key have one catalogue silently overwrite the
    // other's. Both Mimo entries did exactly this on the key `mmf`.
    const seen = new Map();
    const clashes = [];
    for (const p of REGISTRY) {
      const key = p.alias || p.id;
      if (!key) continue;
      if (seen.has(key) && seen.get(key) !== p.id) clashes.push(`${key} <- ${seen.get(key)} and ${p.id}`);
      seen.set(key, p.id);
    }
    expect(clashes, clashes.join("\n")).toEqual([]);
    // And every entry that declares a catalogue has it under that key.
    const missing = REGISTRY.filter(
      (p) => p.models !== undefined && !PROVIDER_MODELS[p.alias || p.id]
    ).map((p) => p.id);
    expect(missing, missing.join("\n")).toEqual([]);
  });

  it("disabled-models key-groups do not merge two providers", () => {
    // disabledModelsRepo's canonical name is `uiAlias || alias || id`. Two
    // providers sharing one canonical collapse into a single key-group, so
    // toggling a model id on one toggles it on the other.
    const seen = new Map();
    const merges = [];
    for (const p of REGISTRY) {
      const canonical = p.uiAlias || p.alias || p.id;
      if (!canonical) continue;
      if (seen.has(canonical) && seen.get(canonical) !== p.id) {
        merges.push(`${canonical} <- ${seen.get(canonical)} and ${p.id}`);
      }
      seen.set(canonical, p.id);
    }
    expect(merges, merges.join("\n")).toEqual([]);
  });

  // Regression pin for the sfcn fix: the short alias must resolve to its rightful
  // owner in both directions, and StepFun CN keeps its own `sf-cn`.
  it("sfcn resolves to siliconflow-cn, sf-cn to stepfun-cn", () => {
    expect(resolveProviderAlias("sfcn")).toBe("siliconflow-cn");
    expect(resolveProviderAlias("sf-cn")).toBe("stepfun-cn");
    expect(parseModel("sfcn/deepseek-ai/DeepSeek-V3.2").provider).toBe("siliconflow-cn");
    expect(parseModel("sf-cn/step-5-preview").provider).toBe("stepfun-cn");
  });

  // Regression pins for the two collisions the guard above missed while it only
  // walked `aliases[]`. Trae owns `tr` (it is the prefix its catalogue emits);
  // TokenRouter is reached as `tokenrouter/…`. The bare `mmf` id belongs to the
  // entry whose id is `mmf`; Mimo Free owns its own id as its spelling.
  it("tr belongs to trae, mmf to the mmf provider, mimo-free to itself", () => {
    expect(resolveProviderAlias("tr")).toBe("trae");
    expect(parseModel("tr/xxx").provider).toBe("trae");
    expect(resolveProviderAlias("tokenrouter")).toBe("tokenrouter");
    expect(parseModel("tokenrouter/xxx").provider).toBe("tokenrouter");

    expect(resolveProviderAlias("mmf")).toBe("mmf");
    expect(parseModel("mmf/mimo-auto").provider).toBe("mmf");
    expect(resolveProviderAlias("mimo-free")).toBe("mimo-free");
    expect(parseModel("mimo-free/mimo-auto").provider).toBe("mimo-free");

    // The two Mimo entries must keep separate catalogues. Before the fix both
    // wrote PROVIDER_MODELS["mmf"], so one silently overwrote the other and
    // PROVIDER_MODELS["mimo-free"] did not exist at all.
    expect(Array.isArray(PROVIDER_MODELS["mmf"])).toBe(true);
    expect(Array.isArray(PROVIDER_MODELS["mimo-free"])).toBe(true);
    expect(PROVIDER_MODELS["mmf"]).not.toBe(PROVIDER_MODELS["mimo-free"]);
  });
});
