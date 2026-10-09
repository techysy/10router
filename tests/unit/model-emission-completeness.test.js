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
const { GET: modelsInfoGET } = await import("../../src/app/api/v1/models/info/route.js");

/**
 * buildModelsList has six emit sites. Three of them used to hand-roll the
 * capability/token shape and drifted apart:
 *
 *   static-catalog fallback  → `capabilities` only, no token trio at all
 *   zero-connection customs  → token trio, but no `capabilities` and no
 *                              catalogue lookup
 *   combinations             → fixed earlier, after clients were already
 *                              guessing windows from model names
 *
 * A model that reaches a client with no `context_length` / `context_window`
 * gets its window guessed from the id — and guessed high, so it never reaches
 * its compaction threshold and hard-fails upstream. This file pins every path
 * to the same shape.
 */
describe("model emission completeness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue([]);
    mocks.getProviderNodes.mockResolvedValue([]);
    mocks.getCombos.mockResolvedValue([]);
    mocks.getCustomModels.mockResolvedValue([]);
    mocks.getModelAliases.mockResolvedValue({});
    mocks.getDisabledModels.mockResolvedValue({});
    mocks.getAllModelCaps.mockResolvedValue({});
  });

  it("static-catalog fallback emits the token trio, not just capabilities", async () => {
    // A DB that throws takes this path.
    mocks.getProviderConnections.mockRejectedValue(new Error("db down"));

    const models = await buildModelsList([LLM]);
    const qf = models.find((m) => m.id === "qdc/qfmodel");

    expect(qf).toBeDefined();
    expect(qf.capabilities).toBeDefined();
    expect(qf.context_length).toBe(1000000);
    expect(qf.context_window).toBe(1000000);
    expect(qf.max_completion_tokens).toBe(65536);
  });

  it("static-catalog fallback honors dashboard pins over the table", async () => {
    mocks.getProviderConnections.mockRejectedValue(new Error("db down"));
    mocks.getAllModelCaps.mockResolvedValue({
      qdc: { qfmodel: { contextWindow: 123456, maxOutput: 7777 } },
    });

    const models = await buildModelsList([LLM]);
    const qf = models.find((m) => m.id === "qdc/qfmodel");

    expect(qf.context_length).toBe(123456);
    expect(qf.max_completion_tokens).toBe(7777);
  });

  it("zero-connection custom models emit a capabilities block too", async () => {
    mocks.getCustomModels.mockResolvedValue([
      { id: "my-model", providerAlias: "qdc", contextWindow: 500000, maxOutput: 32000 },
    ]);

    const models = await buildModelsList([LLM]);
    const entry = models.find((m) => m.id === "qdc/my-model");

    expect(entry).toBeDefined();
    expect(entry.capabilities).toBeDefined();
    expect(entry.context_length).toBe(500000);
    expect(entry.context_window).toBe(500000);
    expect(entry.max_completion_tokens).toBe(32000);
    // The nested block must agree with the snake_case names.
    expect(entry.capabilities.contextWindow).toBe(500000);
    expect(entry.capabilities.maxOutput).toBe(32000);
  });

  it("zero-connection customs fall back to the catalogue when the id resolves", async () => {
    // The user left both fields blank; the id is one the table knows, so the
    // "供应商上报的" value must come through (the dashboard's own wording).
    mocks.getCustomModels.mockResolvedValue([
      { id: "qfmodel", providerAlias: "qdc" },
    ]);

    const models = await buildModelsList([LLM]);
    const entry = models.find((m) => m.id === "qdc/qfmodel");

    expect(entry).toBeDefined();
    expect(entry.context_length).toBe(1000000);
    expect(entry.max_completion_tokens).toBe(65536);
  });

  it("does NOT stamp the 200K floor on a blank custom model the table knows nothing about", async () => {
    // "没有内置默认值: 留空时使用供应商上报的" — a blank stays blank rather than
    // being handed a number the provider never claimed.
    mocks.getCustomModels.mockResolvedValue([
      { id: "totally-unknown-model", providerAlias: "qdc" },
    ]);

    const models = await buildModelsList([LLM]);
    const entry = models.find((m) => m.id === "qdc/totally-unknown-model");

    expect(entry).toBeDefined();
    expect(entry.context_length).toBeUndefined();
    expect(entry.context_window).toBeUndefined();
    expect(entry.max_completion_tokens).toBeUndefined();
    // But the capability block is still published, so vision/tools are visible.
    expect(entry.capabilities).toBeDefined();
  });
});

describe("/v1/models/info agrees with /v1/models", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderConnections.mockResolvedValue([]);
    mocks.getProviderNodes.mockResolvedValue([]);
    mocks.getCombos.mockResolvedValue([]);
    mocks.getCustomModels.mockResolvedValue([]);
    mocks.getModelAliases.mockResolvedValue({});
    mocks.getDisabledModels.mockResolvedValue({});
    mocks.getAllModelCaps.mockResolvedValue({});
  });

  it("emits the snake_case names clients actually match", async () => {
    const res = await modelsInfoGET(
      new Request("http://x/v1/models/info?id=qdc/qfmodel")
    );
    const info = await res.json();

    expect(res.status).toBe(200);
    expect(info.context_window).toBe(1000000);
    expect(info.context_length).toBe(1000000);
    expect(info.max_completion_tokens).toBe(65536);
    expect(info.contextWindow).toBe(1000000);
    expect(info.maxOutput).toBe(65536);
    expect(info.capabilities).toBeDefined();
  });

  it("reports the same window as buildModelsList for the same model", async () => {
    // A healthy DB with zero connections deliberately exposes nothing built-in,
    // so force the static-catalog path to get a listed row to compare against.
    mocks.getProviderConnections.mockRejectedValue(new Error("db down"));
    const models = await buildModelsList([LLM]);
    const listed = models.find((m) => m.id === "qdc/qfmodel");
    expect(listed).toBeDefined();

    const res = await modelsInfoGET(
      new Request("http://x/v1/models/info?id=qdc/qfmodel")
    );
    const info = await res.json();

    // The raw registry row and the capability table can disagree (bai's
    // deepseek-v3.2 publishes 131072/65536, the table says 128000/64000).
    // Both endpoints follow the table, so they must not disagree with each other.
    expect(info.context_window).toBe(listed.context_window);
    expect(info.max_completion_tokens).toBe(listed.max_completion_tokens);
  });

  it("leaves image-model capability tags alone", async () => {
    // Registry `capabilities` on image rows is a *tag array* (["edit"]) — a
    // different vocabulary from the resolved capability object. It must survive.
    const res = await modelsInfoGET(
      new Request("http://x/v1/models/info?id=agnes/agnes-image-2.1-flash")
    );
    if (res.status !== 200) return; // provider not in this build's registry
    const info = await res.json();
    expect(Array.isArray(info.capabilities)).toBe(true);
  });
});
