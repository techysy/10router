// Numes (numes.ai) provider: registry wiring and capability pinning. No
// network — the wire protocol itself (Bearer auth + OpenAI Chat
// Completions, reasoning_effort accepted) was verified live on 2026-11-23
// with a test key: GET /api/v1/models 200 (309 ids, OpenRouter-shaped
// catalog) and POST /api/v1/chat/completions 200 non-stream + SSE stream
// (z-ai/glm-5.3:free answered "pong").
import { describe, expect, it } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { resolveStep } from "../../scripts/audit-capabilities.mjs";

describe("Numes provider registry", () => {
  const entry = REGISTRY.find((e) => e.id === "numes");

  it("is registered as an API-key provider on the marketplace endpoint", () => {
    expect(entry).toBeDefined();
    expect(entry.category).toBe("apikey");
    expect(entry.authModes).toContain("apikey");
    expect(PROVIDERS.numes.baseUrl).toBe("https://api.numes.ai/api/v1/chat/completions");
    expect(PROVIDERS.numes.validateUrl).toBe("https://api.numes.ai/api/v1/models");
    expect(PROVIDERS.numes.format).toBe("openai");
    // The gateway accepts the OpenAI reasoning_effort shorthand
    // (docs/features/reasoning) — the wire shape for every model here.
    expect(PROVIDERS.numes.thinkingFormat).toBe("openai");
  });

  it("carries the OpenRouter-shaped catalog contract", () => {
    // No modelsFetcher: GET /models requires Bearer auth (401 without it) and
    // the dashboard's suggested-models proxy fetches without credentials.
    expect(entry.modelsFetcher).toBeUndefined();
    // The catalog drifts (309 ids at onboarding); anything outside the static
    // list is accepted by id.
    expect(entry.passthroughModels).toBe(true);
  });

  it("anchors the free roster — ids a plain (paid-endpoint) id never routes to", () => {
    const ids = entry.models.map((m) => m.id);
    for (const free of [
      "z-ai/glm-5.3:free",
      "z-ai/glm-5.3-flash:free",
      "deepseek/deepseek-v4.1-flash:free",
      "moonshotai/kimi-k3.1-pro:free",
      "nvidia/nemotron-3-ultra-550b-a55b:free",
    ]) {
      expect(ids).toContain(free);
    }
  });

  it("names every static model with its vendor namespace (no bare ids)", () => {
    for (const m of entry.models) {
      expect(m.id).toMatch(/^[a-z0-9-]+\/[a-z0-9._:+-]+$/i);
      expect(m.name).toBeTruthy();
    }
    expect(PROVIDER_MODELS.numes.length).toBe(entry.models.length);
  });

  it("resolves every static model above the capability floor", () => {
    const floored = entry.models
      .map((m) => m.id)
      .filter((id) => resolveStep("numes", id).step === "floor");
    expect(floored).toEqual([]);
  });

  it("pins the ids the shared tables would mis-resolve", () => {
    // Dotted Claude id: the canonical table only carries the dashed
    // claude-haiku-5-5 key, so without the provider row this lands on the
    // *claude*haiku* pattern (200K, claude-budget).
    const haiku = getCapabilitiesForModel("numes", "anthropic/claude-haiku-5.5");
    expect(haiku.contextWindow).toBe(1000000);
    expect(haiku.thinkingFormat).toBe("openai");
    // Tencent Hy ids match no pattern at all (only hy3* exists) — floor.
    expect(getCapabilitiesForModel("numes", "tencent/hy4").contextWindow).toBe(1000000);
    expect(getCapabilitiesForModel("numes", "tencent/hy4-flash").contextWindow).toBe(960000);
    // :free suffix keeps these off the canonical rows; the family pattern
    // would strip images from the multimodal models behind them.
    expect(getCapabilitiesForModel("numes", "deepseek/deepseek-v4.1-flash:free").vision).toBe(true);
    expect(getCapabilitiesForModel("numes", "z-ai/glm-5.3-flash:free").vision).toBe(true);
  });
});
