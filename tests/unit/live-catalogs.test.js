import { afterEach, describe, expect, it, vi } from "vitest";

// proxyFetch snapshots globalThis.fetch at import time, so stubbing fetch alone
// would let the catalogue test hit the real host. Route it through the current
// global on every call instead.
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (url, options) => globalThis.fetch(url, options),
}));

import {
  atomcodePlanTier,
  catalogHasModel,
  parseAtomcodeGatewayCatalog,
  parseAtomcodePlanCatalog,
  parseCodeartsAgentDetail,
  parseCodeartsBenefit,
  parseCodeartsBenefitGate,
  parseCodeartsBuiltin,
  parseLobsterAiCatalog,
  parseLoomyCatalog,
  parseOfficeaceCatalog,
  parseRaccoonCatalog,
  parseTraeSoloCatalog,
  resetLiveCatalogCache,
  resolveLoomyCatalog,
} from "../../open-sse/services/liveCatalogs.js";
import {
  forgetLiveModels,
  isModelAllowedForProvider,
  rememberLiveModels,
} from "../../open-sse/services/model.js";

afterEach(() => {
  vi.unstubAllGlobals();
  resetLiveCatalogCache();
  forgetLiveModels("loomy");
});

describe("Loomy catalogue", () => {
  it("keeps chat models, maps declared capabilities, and drops image entries", () => {
    const models = parseLoomyCatalog({
      data: [
        {
          id: "DeepSeek-V4.1-Flash",
          name: "DeepSeek V4.1 Flash(x2.0)",
          type: "chat",
          context_length: 1048576,
          max_output_tokens: 384000,
          capabilities: {
            reasoning: true,
            vision: true,
            function_calling: true,
            input_modalities: ["text", "image"],
          },
        },
        {
          id: "qwen3.8-flash",
          type: "chat",
          capabilities: { reasoning: false, function_calling: true, input_modalities: ["text"] },
        },
        { id: "Hy-Image-3.5-preview", type: "image" },
      ],
    });

    expect(models.map((m) => m.id)).toEqual(["DeepSeek-V4.1-Flash", "qwen3.8-flash"]);
    expect(models[0].capabilities).toMatchObject({
      tools: true,
      vision: true,
      reasoning: true,
      contextWindow: 1048576,
      maxOutput: 384000,
    });
    expect(models[1].capabilities.vision).toBe(false);
  });

  it("caches per connection and can refuse a stale catalogue", async () => {
    const connection = { id: "conn-1", accessToken: "token-1" };
    const ok = () =>
      new Response(
        JSON.stringify({ data: [{ id: "m1", type: "chat", capabilities: { reasoning: true } }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );

    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal("fetch", fetchMock);

    const first = await resolveLoomyCatalog(connection);
    const second = await resolveLoomyCatalog(connection);
    expect(first.models[0].id).toBe("m1");
    expect(second.models[0].id).toBe("m1");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ error: "expired" }), { status: 401 })
    );
    await expect(
      resolveLoomyCatalog(connection, { forceRefresh: true, allowStale: false })
    ).rejects.toThrow(/HTTP 401/);

    const stale = await resolveLoomyCatalog(connection, { forceRefresh: true });
    expect(stale.stale).toBe(true);
    expect(stale.models[0].id).toBe("m1");
  });

  it("admits a live-advertised id to a strict provider gate", () => {
    expect(isModelAllowedForProvider("loomy", "brand-new-live-model")).toBe(false);
    rememberLiveModels("loomy", ["brand-new-live-model"]);
    expect(isModelAllowedForProvider("loomy", "brand-new-live-model")).toBe(true);
  });
});

describe("LobsterAI catalogue", () => {
  it("reads the array-shaped data envelope", () => {
    const models = parseLobsterAiCatalog({
      code: 0,
      data: [
        {
          modelId: "glm-5.2",
          modelName: "GLM-5.2",
          contextWindow: 200000,
          maxTokens: 32000,
          supportsImage: false,
          supportsThinking: true,
        },
        { modelId: "kimi-k2.6", modelName: "Kimi K2.6" },
      ],
    });
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      id: "glm-5.2",
      name: "GLM-5.2",
      capabilities: { tools: true, vision: false, reasoning: true, contextWindow: 200000, maxOutput: 32000 },
    });
  });

  it("raises a business-envelope failure instead of returning an empty list", () => {
    expect(() => parseLobsterAiCatalog({ code: 40101, message: "refresh rejected" })).toThrow(
      /refresh rejected/
    );
  });
});

describe("AtomCode catalogue", () => {
  it("infers the plan tier from status-v2 and keeps only advertised models", () => {
    expect(atomcodePlanTier({ codingplan_free: { plan_name: "CodingPlan Lite-体验版" } })).toBe("Lite");
    expect(atomcodePlanTier({ plan_type: "CodingPlan Max" })).toBe("Max");
    expect(atomcodePlanTier({ plan_type: "Pro" })).toBe("Pro");
    expect(atomcodePlanTier({})).toBe(null);

    const models = parseAtomcodePlanCatalog({
      models: [
        {
          id: 123,
          display_model_name: "glm5.3-flash",
          plan_available: true,
          context_window: 512000,
          supports_vision: true,
          reasoning_effort_levels: ["low", "high"],
        },
        { display_model_name: "not-on-plan", plan_available: false },
        { id: 9, plan_available: true },
      ],
    });
    expect(models).toEqual([
      {
        id: "glm5.3-flash",
        name: "glm5.3-flash",
        capabilities: {
          tools: true,
          vision: true,
          reasoning: true,
          contextWindow: 512000,
        },
      },
    ]);
  });

  it("reads the AI Hub OpenAI envelope", () => {
    const models = parseAtomcodeGatewayCatalog({
      data: [{ id: "Qwen/Qwen3-32B", name: "Qwen3-32B", context_length: 131072 }],
    });
    expect(models[0]).toMatchObject({
      id: "Qwen/Qwen3-32B",
      name: "Qwen3-32B",
      capabilities: { tools: true, contextWindow: 131072 },
    });
  });
});

describe("Raccoon catalogue", () => {
  it("flattens categories and normalises the upstream field names", () => {
    const models = parseRaccoonCatalog({
      data: {
        categories: [
          {
            models: [
              {
                name: "raccoon-8c4485",
                displayName: "Raccoon-Work",
                tags: ["vision", "office"],
                params: { context_window: 1000000, max_tokens: 100000 },
              },
              { name: "raccoon-chat-ml-5-5", description: "A very long internal sentence used as the internal code for this model" },
            ],
          },
        ],
      },
    });
    expect(models.map((m) => m.id)).toEqual(["raccoon-8c4485", "raccoon-chat-ml-5-5"]);
    expect(models[0]).toMatchObject({
      name: "Raccoon-Work",
      capabilities: {
        tools: true,
        vision: true,
        reasoning: true,
        contextWindow: 1000000,
        maxOutput: 100000,
      },
    });
    expect(models[1].name).toBe("raccoon-chat-ml-5-5");
  });
});

describe("CodeArts catalogue", () => {
  it("reads builtin rows, agent details, and the benefit switch", () => {
    const builtin = parseCodeartsBuiltin({
      builtinModels: [
        {
          model_id: "GLM-5.2",
          model_name: "GLM 5.2",
          context_window: 200000,
          max_tokens: 131072,
          supports_images: true,
        },
        { model_id: "disabled", enable: false },
      ],
    });
    expect(builtin).toHaveLength(1);
    expect(builtin[0]).toMatchObject({
      id: "GLM-5.2",
      name: "GLM 5.2",
      capabilities: { tools: true, vision: true, contextWindow: 200000, maxOutput: 65536 },
    });

    const agent = parseCodeartsAgentDetail({
      gpts: {
        models: [
          {
            model_alias: "agent-a",
            model_name: "Agent A",
            model_parameters: {
              model_id: "deepseek-v4.1-flash",
              display_enabled: true,
              enabled: true,
              context_window: 384000,
            },
          },
          {
            model_alias: "hidden",
            model_parameters: { display_enabled: false },
          },
        ],
      },
    });
    expect(agent.map((m) => m.id)).toEqual(["deepseek-v4.1-flash"]);

    expect(parseCodeartsBenefitGate({ enabled: true })).toBe(true);
    expect(parseCodeartsBenefitGate({ enabled: false })).toBe(false);
  });

  it("parses the benefit gateway's sorted model list", () => {
    const models = parseCodeartsBenefit({
      error_code: "0000",
      result: {
        models: [
          { model_id: "b", model_name: "B", sort: 2, context_window: 1000 },
          { model_id: "a", model_name: "A", sort: 1 },
          { model_id: "" },
        ],
      },
    });
    expect(models.map((m) => m.id)).toEqual(["a", "b"]);
  });
});

describe("OfficeAce catalogue", () => {
  it("reads the OpenAI gateway envelope and keeps missing capabilities missing", () => {
    const models = parseOfficeaceCatalog({
      object: "list",
      data: [
        { id: "glm-5.3", display_name: "GLM 5.3", context_length: 198000, max_output_tokens: 32000 },
        { object: "model" },
        { id: "  " },
      ],
    });
    expect(models).toEqual([
      {
        id: "glm-5.3",
        name: "GLM 5.3",
        capabilities: { tools: true, contextWindow: 198000, maxOutput: 32000 },
      },
    ]);
  });
});

describe("Trae SOLO catalogue", () => {
  it("filters hidden/dead/placeholder configs and advertises the -solo suffix", () => {
    const models = parseTraeSoloCatalog({
      config_info_list: [
        {
          config_name: "glm-5.2",
          display_config: { display_name: "GLM 5.2", model_capability: "chat_model", multimodal: false },
          context_window_tokens: { dev: 200000 },
          model_detail_list: [{ max_tokens: 32000 }],
        },
        {
          config_name: "kimi-k2.6",
          display_config: { display_name: "Kimi K2.6", model_capability: "reasoning_model", multimodal: true },
          model_detail_list: [{ max_tokens: 16000 }],
        },
        { config_name: "deepseek-v4-flash", display_config: { display_name: "Dead" } },
        { config_name: "hidden", is_invisible_to_user: true, display_config: { display_name: "Hidden" } },
        { config_name: "off", config_switch: false, display_config: { display_name: "Off" } },
        { config_name: "no-name", display_config: {} },
        { config_name: "glm-5.2", display_config: { display_name: "Duplicate" } },
      ],
    });

    expect(models.map((m) => m.id)).toEqual(["glm-5.2-solo", "kimi-k2.6-solo"]);
    expect(models[0].capabilities).toMatchObject({
      tools: true,
      vision: false,
      reasoning: false,
      contextWindow: 200000,
      maxOutput: 32000,
    });
    expect(models[1].capabilities).toMatchObject({
      vision: true,
      reasoning: true,
      maxOutput: 16000,
    });
  });
});

describe("catalogHasModel", () => {
  const models = [{ id: "vendor/model-a" }, { id: "glm-5.2-solo" }];

  it("accepts provider-prefixed ids and the SOLO suffix round-trip", () => {
    expect(catalogHasModel(models, "loomy/vendor/model-a")).toBe(true);
    expect(catalogHasModel(models, "glm-5.2")).toBe(true);
    expect(catalogHasModel([{ id: "GLM-5.2" }], "glm-5.2", { caseInsensitive: true })).toBe(true);
    expect(catalogHasModel(models, "missing")).toBe(false);
  });
});
