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

const LLM = "llm";
const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");

// Combos aggregate member capabilities and advertise them to the client. The
// aggregate lives in `capabilities.contextWindow` (camelCase, nested), but
// clients do not recurse into nested objects — Claude CLI and mirasim match
// `context_window` / `context_length` at the top level and otherwise fall back
// to guessing the window from the model name, which guesses high. The two model
// paths already emit those names; the combo path did not, so a combo's context
// never reached the agent at all.
describe("buildModelsList — combo context reaches the agent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue([]);
    mocks.getProviderNodes.mockResolvedValue([]);
    mocks.getCustomModels.mockResolvedValue([]);
    mocks.getModelAliases.mockResolvedValue({});
    mocks.getDisabledModels.mockResolvedValue({});
    mocks.getAllModelCaps.mockResolvedValue({});
    mocks.getSettings.mockResolvedValue({});
  });

  it("emits the snake_case context names the agent reads, alongside the nested block", async () => {
    // kimi-k2.6 已随 2026-11-05 目录换代从 CN 下架。成员改用仍在目录的
    // kimi-k2.8-preview(256K/32K) 与 glm-5.3-flash(1M/32K)：contextWindow 取
    // min → 256K，maxOutput 取 max → 32K（聚合是 max，成员必须都 ≤32K 才能保
    // 持原断言形状——旧成员 k2.6 的 CN 行当年恰好也是 32000）。
    mocks.getCombos.mockResolvedValue([
      {
        name: "kimi-preview",
        models: ["codebuddy-cn/kimi-k2.8-preview", "codebuddy-cn/glm-5.3-flash"],
      },
    ]);

    const models = await buildModelsList([LLM]);
    const combo = models.find((m) => m.id === "kimi-preview");

    expect(combo).toBeDefined();
    // Nested block still there for clients that do recurse.
    expect(combo.capabilities.contextWindow).toBe(256000);
    // The two names the agent actually matches on.
    expect(combo.context_window).toBe(256000);
    expect(combo.context_length).toBe(256000);
    expect(combo.max_completion_tokens).toBe(32000);
  });

  it("takes the context from the combo-caps contract (min across members)", async () => {
    // glm-5.2 is 1M, kimi-k2.8-preview is 256K → the combo must advertise the
    // lower one, because whichever member serves the request has to hold it.
    mocks.getCombos.mockResolvedValue([
      {
        name: "mixed",
        models: ["codebuddy-cn/glm-5.2", "codebuddy-cn/kimi-k2.8-preview"],
      },
    ]);

    const models = await buildModelsList([LLM]);
    const combo = models.find((m) => m.id === "mixed");

    expect(combo.context_window).toBe(256000);
    expect(combo.context_length).toBe(256000);
  });

  it("honors a user-pinned member window in the emitted context", async () => {
    // Same shape PR #51 fixed for the nested aggregate: a dashboard pin on one
    // member must reach the client-visible context, not just the nested block.
    mocks.getCombos.mockResolvedValue([
      {
        name: "pinned",
        models: ["codebuddy-cn/kimi-k2.8-preview"],
      },
    ]);
    mocks.getAllModelCaps.mockResolvedValue({
      "codebuddy-cn": { "kimi-k2.8-preview": { contextWindow: 1_000_000, maxOutput: 128000 } },
    });

    const models = await buildModelsList([LLM]);
    const combo = models.find((m) => m.id === "pinned");

    expect(combo.context_window).toBe(1_000_000);
    expect(combo.context_length).toBe(1_000_000);
    expect(combo.max_completion_tokens).toBe(128000);
  });

  it("does not invent context fields when the aggregate has no window", async () => {
    // A web combo carries `kind` and no LLM aggregate — nothing to advertise,
    // and a fabricated context_window would be worse than none.
    mocks.getCombos.mockResolvedValue([
      { name: "searchy", models: [], kind: "webSearch" },
    ]);

    const models = await buildModelsList([LLM, "webSearch"]);
    const combo = models.find((m) => m.id === "searchy");

    expect(combo.kind).toBe("webSearch");
    expect(combo.context_window).toBeUndefined();
    expect(combo.context_length).toBeUndefined();
  });
});