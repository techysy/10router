import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { getModelsByProviderId } from "../../open-sse/config/providerModels.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";

afterEach(() => vi.restoreAllMocks());

// 2026-11-18: GPT-6.2 上线(上游元数据 GET /api/providers/<conn>/models 原始
// 字段,群友真机抓取;models.dev 7 家网关同源佐证)。sol/astra 双系 + [1m]
// 长上下文变体 + -review 自动 review 变体(照 gpt-5.6-*-review)。上游
// minimal_client_version 0.166.0 背书 CLI 指纹 0.169.0(2c8d067c0)。
describe("Codex GPT-6.2 Sol/Astra catalog", () => {
  it.each(["gpt-6.2-sol", "gpt-6.2-astra"])("lists %s as a Responses Lite model with the five thinking levels", (model) => {
    const entry = getModelsByProviderId("codex").find((item) => item.id === model);
    expect(entry?.responsesLite).toBe(true);
    expect(entry?.thinkingLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(getThinkingLevels("codex", model)).toEqual(entry.thinkingLevels);
  });

  it.each(["gpt-6.2-sol", "gpt-6.2-astra"])("publishes [1m] variants of %s pointing at the base id", (model) => {
    const entry = getModelsByProviderId("codex").find((item) => item.id === `${model}[1m]`);
    expect(entry?.upstreamModelId).toBe(model);
    expect(entry?.responsesLite).toBe(true);
  });

  it.each(["gpt-6.2-sol", "gpt-6.2-astra"])("publishes %s-review with quotaFamily review", (model) => {
    const entry = getModelsByProviderId("codex").find((item) => item.id === `${model}-review`);
    expect(entry?.upstreamModelId).toBe(model);
    expect(entry?.quotaFamily).toBe("review");
  });

  it("caps sol at the upstream 500k window with audio input (upstream modalities text+image+audio)", () => {
    expect(getCapabilitiesForModel("codex", "gpt-6.2-sol")).toMatchObject({
      vision: true,
      audioInput: true,
      reasoning: true,
      search: true,
      thinkingFormat: "openai",
      contextWindow: 500000,
      maxOutput: 128000,
    });
  });

  it("caps astra at the upstream 272k window (text+image, no audio)", () => {
    const caps = getCapabilitiesForModel("codex", "gpt-6.2-astra");
    expect(caps).toMatchObject({ vision: true, reasoning: true, contextWindow: 272000, maxOutput: 128000 });
    expect(caps.audioInput).toBeFalsy();
  });

  it.each(["gpt-6.2-sol", "gpt-6.2-astra"])("caps %[1m] at the upstream max_context_window 872k", (model) => {
    expect(getCapabilitiesForModel("codex", `${model}[1m]`).contextWindow).toBe(872000);
  });

  it("prices sol 4/15 and astra 16/60 (models.dev aggregate, 7 gateways)", () => {
    expect(getPricingForModel("codex", "gpt-6.2-sol")).toMatchObject({ input: 4.00, output: 15.00 });
    expect(getPricingForModel("codex", "gpt-6.2-astra")).toMatchObject({ input: 16.00, output: 60.00 });
  });

  it("keeps the transport headers on 0.169.0 (minimal_client_version 0.166.0 gate)", () => {
    expect(PROVIDERS.codex.cliVersion).toBe("0.169.0");
    expect(new CodexExecutor("cx", PROVIDERS.codex)).toBeDefined();
  });
});
