import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getProviderNodes: vi.fn(),
  getCombos: vi.fn(),
  getCustomModels: vi.fn(),
  getModelAliases: vi.fn(),
  getDisabledModels: vi.fn(),
  getSettings: vi.fn(),
  getAllModelCaps: vi.fn(),
  resolveQoderModels: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getProviderNodes: mocks.getProviderNodes,
  getCombos: mocks.getCombos,
  getCustomModels: mocks.getCustomModels,
  getModelAliases: mocks.getModelAliases,
  getSettings: mocks.getSettings,
}));

vi.mock("@/lib/modelCapsDb", () => ({ getAllModelCaps: mocks.getAllModelCaps }));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: mocks.getDisabledModels }));
vi.mock("../../open-sse/services/qoderModels.js", () => ({
  resolveQoderModels: mocks.resolveQoderModels,
}));

const LLM = "llm";
const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");
const { getCapabilitiesForModel } = await import("../../open-sse/providers/capabilities.js");

// Qoder exposes opaque internal ids (qfmodel, kmodel, …) and serves them over a
// live catalog. The context has to reach the agent as the top-level snake_case
// names — clients that only match `context_length` / `context_window` do not
// recurse into `capabilities.contextWindow`, so a model that reaches them with
// no such field gets its window guessed from the name. Qwen3.8-Flash reads as
// "3.8" to a name-guesser and lands far off its real 1M.
describe("buildModelsList — qoder context reaches the agent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue([]);
    mocks.getProviderNodes.mockResolvedValue([]);
    mocks.getCombos.mockResolvedValue([]);
    mocks.getCustomModels.mockResolvedValue([]);
    mocks.getModelAliases.mockResolvedValue({});
    mocks.getDisabledModels.mockResolvedValue({});
    mocks.getAllModelCaps.mockResolvedValue({});
    mocks.resolveQoderModels.mockResolvedValue(null);
  });

  it("emits the context fields for qoder-cn's opaque ids (static catalog path)", async () => {
    // qoder-cn has no live resolver — it serves PROVIDER_MODELS. `enabledModels`
    // is the dashboard's explicit allow-list and is what a configured install
    // carries.
    mocks.getProviderConnections.mockResolvedValue([
      {
        provider: "qoder-cn",
        isActive: true,
        providerSpecificData: { enabledModels: ["qfmodel", "qmodel_38max"] },
      },
    ]);

    const models = await buildModelsList([LLM]);
    const qf = models.find((m) => m.id === "qdc/qfmodel");

    expect(qf).toBeDefined();
    // Qwen3.8-Flash — 1M input. The nested block and the two snake_case names
    // must agree; a client that reads either convention sees the same number.
    expect(qf.context_length).toBe(1000000);
    expect(qf.context_window).toBe(1000000);
    expect(qf.max_completion_tokens).toBe(65536);
    expect(qf.capabilities.contextWindow).toBe(1000000);
    expect(qf.capabilities.maxOutput).toBe(65536);
  });

  it("emits the context fields for qoder intl's live catalog too", async () => {
    // qoder (INTL) resolves its model list upstream at request time. The
    // resolver returns bare { id, name } — no capability data — so the values
    // must still come from the capability table, not go missing with the live
    // catalog's partial shape.
    mocks.getProviderConnections.mockResolvedValue([
      { provider: "qoder", isActive: true, providerSpecificData: {} },
    ]);
    mocks.resolveQoderModels.mockResolvedValue({
      models: [
        { id: "qfmodel", name: "Qwen3.8-Flash" },
        { id: "kmodel", name: "Kimi-K2.7-Code" },
      ],
    });

    const models = await buildModelsList([LLM]);
    const qf = models.find((m) => m.id === "qd/qfmodel");
    const km = models.find((m) => m.id === "qd/kmodel");

    expect(qf?.context_window).toBe(1000000);
    expect(qf?.context_length).toBe(1000000);
    expect(qf?.max_completion_tokens).toBe(65536);
    // kmodel is the deliberate counter-example: Kimi-K2.7-Code is 256K, not
    // 1M. Asserting it proves the test is reading the real per-id rows rather
    // than a blanket 1M that would silence a genuine drift.
    expect(km?.context_window).toBe(256000);
    expect(km?.max_completion_tokens).toBe(65536);
  });

  it("does not let the live catalog's partial shape override the real window", async () => {
    // The resolver's payload is spread over the global caps (discoveredCaps
    // last). A live row that ever grows a `capabilities` block must not be able
    // to stamp a stub window over the table's real one.
    mocks.getProviderConnections.mockResolvedValue([
      { provider: "qoder", isActive: true, providerSpecificData: {} },
    ]);
    mocks.resolveQoderModels.mockResolvedValue({
      models: [
        { id: "qfmodel", name: "Qwen3.8-Flash", capabilities: { tools: true } },
      ],
    });

    const models = await buildModelsList([LLM]);
    const qf = models.find((m) => m.id === "qd/qfmodel");

    expect(qf?.context_window).toBe(1000000);
    expect(qf?.capabilities?.tools).toBe(true);
  });
});

describe("qoder capability lookup — alias normalization", () => {
  it("resolves qd/qdc identically to qoder/qoder-cn", () => {
    // /api/models builds ids from PROVIDER_MODELS' key, which is the alias. If
    // the alias is not normalized onto the provider's capability block the same
    // model falls to DEFAULT_CAPABILITIES (200K/64K) under one spelling and
    // hits the real row under the other — the exact drift that cbai had.
    for (const [alias, id] of [
      ["qd", "qoder"],
      ["qdc", "qoder-cn"],
    ]) {
      for (const model of ["qfmodel", "kmodel", "qmodel_38max", "mmodel"]) {
        expect(
          getCapabilitiesForModel(alias, model),
          `${alias}/${model} drifted from ${id}`,
        ).toEqual(getCapabilitiesForModel(id, model));
      }
    }
  });

  it("keeps every qoder opaque id out of the 200K default floor", () => {
    // Every internal id in the qoder tables is declared. A silent 200K floor
    // means vision/reasoning get stripped and the window is cut to a fifth,
    // with no error anywhere.
    for (const provider of ["qoder", "qoder-cn", "qd", "qdc"]) {
      for (const model of ["qfmodel", "kmodel", "qmodel_38max", "dmodel", "dfmodel"]) {
        const caps = getCapabilitiesForModel(provider, model);
        expect([provider, model, caps.contextWindow], `${provider}/${model} hit the floor`).not.toEqual([
          provider,
          model,
          200000,
        ]);
      }
    }
  });
});
