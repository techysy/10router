/**
 * #174 — Antigravity Gemini 4 Hydrogen: only `gemini-4-hydrogen-sonar` is a real
 * upstream entity on the accounts we can probe. The three tier ids shipped by
 * 2089bb78f were pattern-inferred from the Argon family and never live-probed;
 * they answer 404 "Requested entity was not found" both with and without the
 * "(level)" suffix, and each 404 costs a 120s per-model account lock plus an
 * account walk (ERROR_RULES `{status:404}` → COOLDOWN.long).
 *
 * These tests lock the wiring that makes the tier ids work: the suffix carries
 * the thinking level, chatCore strips it off the wire model, and the executor
 * must therefore send the live entity name with generationConfig.thinkingConfig
 * set to the tier. Verified against the real upstream from the NAS (3 accounts).
 */
import { describe, it, expect } from "vitest";
import { getModelsByProviderId, getModelUpstreamId } from "../../open-sse/config/providerModels.js";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { stripThinkingSuffix } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";

const LIVE_ENTITY = "gemini-4-hydrogen-sonar";
const TIERS = [
  ["gemini-4-hydrogen-high", "high"],
  ["gemini-4-hydrogen-medium", "medium"],
  ["gemini-4-hydrogen-low", "low"],
];

describe("Hydrogen registry ids route onto the live upstream entity", () => {
  it("publishes the real entity id plus tier aliases onto it", () => {
    const ids = getModelsByProviderId("ag").map((m) => m.id);
    expect(ids).toContain(LIVE_ENTITY);
    for (const [id] of TIERS) expect(ids).toContain(id);
    // The un-tiered spelling users had already configured (and which 404'd
    // through passthrough) now resolves too.
    expect(ids).toContain("gemini-4-hydrogen");
  });

  it.each(TIERS)("%s resolves to the live entity with its level in the suffix", (id, level) => {
    expect(getModelUpstreamId("ag", id)).toBe(`${LIVE_ENTITY}(${level})`);
    // What actually goes on the wire (chatCore.js strips the suffix after
    // applyThinking has read it).
    expect(stripThinkingSuffix(getModelUpstreamId("ag", id))).toBe(LIVE_ENTITY);
  });

  it("keeps the bare entity id suffix-free", () => {
    expect(getModelUpstreamId("ag", LIVE_ENTITY)).toBe(LIVE_ENTITY);
    // The un-tiered alias mirrors the gemini-3.8-flash precedent → medium.
    expect(getModelUpstreamId("ag", "gemini-4-hydrogen")).toBe(`${LIVE_ENTITY}(medium)`);
  });
});

describe("Hydrogen envelope is the shape the upstream accepts", () => {
  // Full chain, exactly the order chatCore runs it: translateRequest(upstreamModel)
  // → applyThinking (inside) → body.model = stripThinkingSuffix → executor.
  function wireFor(clientModel) {
    const upstreamModel = getModelUpstreamId("ag", clientModel);
    const body = { model: clientModel, messages: [{ role: "user", content: "Say pong" }], stream: false };
    const translated = translateRequest("openai", "antigravity", upstreamModel, body, true, null, "antigravity");
    translated.model = stripThinkingSuffix(upstreamModel);
    return new AntigravityExecutor().transformRequest(clientModel, translated, true, {
      projectId: "bright-fuze-test", connectionId: "test",
    });
  }

  it.each(TIERS)("sends the live entity with thinkingLevel=%s for %s", (id, level) => {
    const sent = wireFor(id);
    expect(sent.model).toBe(LIVE_ENTITY);
    expect(sent.request.generationConfig.thinkingConfig.thinkingLevel).toBe(level);
    expect(sent.request.generationConfig.thinkingConfig.includeThoughts).toBe(true);
  });

  it("does not leak the parenthesised suffix onto the wire", () => {
    // A model field like "x(high)" is what 404'd before the fix — the entity
    // Google knows has no parentheses at all.
    for (const [id] of TIERS) {
      expect(wireFor(id).model).not.toMatch(/[()]/);
    }
  });
});

describe("Hydrogen capability row follows the live catalog, not the Argon pattern", () => {
  // fetchAvailableModels (2026-11-26, identical on 3 accounts):
  // maxTokens 1048576 · maxOutputTokens 65536 · supportsImages · supportsVideo ·
  // supportsThinking(minThinkingBudget 32) · apiProvider GOOGLE_GEMINI.
  it.each([[LIVE_ENTITY], ...TIERS.map(([id]) => [id])])("%s carries the probed spec", (id) => {
    const caps = getCapabilitiesForModel("ag", id);
    expect(caps.maxOutput).toBe(65536);          // not *gemini-4*'s 1048576
    expect(caps.contextWindow).toBe(1048576);
    expect(caps.vision).toBe(true);
    expect(caps.videoInput).toBe(true);          // catalog declares supportsVideo
    expect(caps.pdf).toBe(true);                 // supportedMimeTypes application/pdf
    expect(caps.audioInput).toBe(false);         // catalog publishes no audio flag
    expect(caps.reasoning).toBe(true);
    expect(caps.thinkingFormat).toBe("gemini-level");
    expect(caps.thinkingCanDisable).toBe(false); // "minimal" → 400 (measured)
    expect(getThinkingLevels("ag", id)).toEqual(["low", "medium", "high"]);
  });

  it("resolves through the provider row, so the pattern cannot drift it", () => {
    // The four ids must not silently fall back to *gemini-4* (Argon's 1M output).
    expect(getCapabilitiesForModel("ag", LIVE_ENTITY).maxOutput)
      .not.toBe(getCapabilitiesForModel("gemini", "gemini-4-argon").maxOutput);
  });

  it("bills at the Gemini 4 rate like the rest of the family", () => {
    const p = getPricingForModel("antigravity", LIVE_ENTITY);
    expect(p).toMatchObject({ input: 2.0, output: 10.0 });
  });
});
