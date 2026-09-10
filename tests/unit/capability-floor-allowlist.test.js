import { describe, expect, it } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { DEFAULT_CAPABILITIES, getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { ALLOWLIST, CHAT_MODELS, DISPUTED, VISION_NAME, resolveStep } from "../../scripts/audit-capabilities.mjs";

// The allowlist and the resolver replay live in scripts/audit-capabilities.mjs, which
// CI also runs as a report step — one definition, not two.

describe("capability resolution invariants", () => {
  it("the audit's chain agrees with getCapabilitiesForModel for every registry model", () => {
    const mismatches = [];
    for (const entry of REGISTRY) {
      for (const raw of entry.models || []) {
        const id = typeof raw === "string" ? raw : raw.id;
        if (!id) continue;
        const { caps } = resolveStep(entry.id, id);
        const expected = { ...DEFAULT_CAPABILITIES, ...caps };
        if (JSON.stringify(getCapabilitiesForModel(entry.id, id)) !== JSON.stringify(expected)) {
          mismatches.push(`${entry.id}/${id}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("names a capability source (provider / canonical / pattern) for every chat model not on the allowlist", () => {
    const floor = CHAT_MODELS.filter((m) => resolveStep(m.provider, m.id).step === "floor");
    const unexpected = floor.map((m) => `${m.provider}/${m.id}`).filter((key) => !(key in ALLOWLIST));
    // A new model here means it silently inherits DEFAULT_CAPABILITIES. Give it a
    // row in open-sse/providers/capabilities.js, or add a reasoned allowlist entry
    // (in scripts/audit-capabilities.mjs).
    expect(unexpected).toEqual([]);
  });

  it("keeps the allowlist free of stale entries", () => {
    const floorKeys = new Set(
      CHAT_MODELS.filter((m) => resolveStep(m.provider, m.id).step === "floor").map((m) => `${m.provider}/${m.id}`)
    );
    const stale = Object.keys(ALLOWLIST).filter((key) => !floorKeys.has(key));
    // If a model here gained a row, delete the allowlist entry instead of leaving
    // a note that no longer describes reality.
    expect(stale).toEqual([]);
  });

  it("allows media ids only when the registry really tags them as media", () => {
    for (const [key, reason] of Object.entries(ALLOWLIST)) {
      if (reason !== "media") continue;
      const model = CHAT_MODELS.find((m) => `${m.provider}/${m.id}` === key);
      expect(`${key} kind=${model?.kind}`).toBe(`${key} kind=image`);
    }
  });

  it("never marks an id that reads as multimodal as text-only", () => {
    // Guards the DeepSeek-V4 / hy4-preview class of bug in the other direction: an
    // id explicitly marked vision (…-vision-…, -vl-, omni) must not resolve to
    // vision:false. Only the knowingly-disputed ids are excused.
    const wrong = CHAT_MODELS.filter((m) => VISION_NAME.test(m.id))
      .filter((m) => getCapabilitiesForModel(m.provider, m.id).vision === false)
      .map((m) => `${m.provider}/${m.id}`)
      .filter((key) => !DISPUTED.has(key));
    expect(wrong).toEqual([]);
  });
});
