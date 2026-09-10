import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getProviderNodes: vi.fn(),
  getCombos: vi.fn(),
  getCustomModels: vi.fn(),
  getModelAliases: vi.fn(),
  getDisabledModels: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getProviderNodes: mocks.getProviderNodes,
  getCombos: mocks.getCombos,
  getCustomModels: mocks.getCustomModels,
  getModelAliases: mocks.getModelAliases,
}));

vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: mocks.getDisabledModels,
}));

// The models route pulls in heavy open-sse module chains; import it lazily so
// the mocks above are registered first.
const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");

const LLM_KIND = "llm";

describe("buildModelsList — empty-connection behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderNodes.mockResolvedValue([]);
    mocks.getCombos.mockResolvedValue([]);
    mocks.getCustomModels.mockResolvedValue([]);
    mocks.getModelAliases.mockResolvedValue({});
    mocks.getDisabledModels.mockResolvedValue({});
  });

  it("does NOT dump the full built-in catalog when the DB is healthy but has zero provider connections", async () => {
    mocks.getProviderConnections.mockResolvedValue([]);
    // User explicitly added a couple of OpenCode free models.
    mocks.getCustomModels.mockResolvedValue([
      { providerAlias: "oc", id: "mimo-v2.5-free", type: "llm", name: "mimo-v2.5-free" },
      { providerAlias: "oc", id: "deepseek-v4-flash-free", type: "llm", name: "deepseek-v4-flash-free" },
    ]);

    const models = await buildModelsList([LLM_KIND]);
    const ids = models.map((m) => m.id);

    // User-configured custom models ARE exposed...
    expect(ids).toContain("oc/mimo-v2.5-free");
    expect(ids).toContain("oc/deepseek-v4-flash-free");

    // ...but the full static catalog is NOT (a known built-in model must be absent),
    // and the list stays small instead of the ~680 built-in entries.
    expect(ids).not.toContain("alicode-intl/qwen3.5-plus");
    expect(models.length).toBeLessThan(50);
  });

  it("still returns the full static catalog as a fallback when the DB itself is unavailable", async () => {
    mocks.getProviderConnections.mockRejectedValue(new Error("db gone"));

    const models = await buildModelsList([LLM_KIND]);
    const ids = models.map((m) => m.id);

    // Known built-in model present when DB is truly unavailable (fallback).
    expect(ids).toContain("alicode-intl/qwen3.5-plus");
    expect(models.length).toBeGreaterThan(100);
  });

  it("keeps per-connection model listing when connections exist (unchanged behavior)", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "conn-1",
        provider: "openai-compatible",
        authType: "apikey",
        isActive: true,
        providerSpecificData: { baseUrl: "https://example.com/v1", prefix: "my" },
      },
    ]);
    // Compatible providers may attempt a live /models fetch; make it return empty
    // so the test stays hermetic and focused on the empty-connection fix.
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 })
    );

    const models = await buildModelsList([LLM_KIND]);
    // Static catalog is not dumped wholesale when a connection exists.
    const ids = models.map((m) => m.id);
    expect(ids).not.toContain("alicode-intl/qwen3.5-plus");
  });

  it("filters orphan custom models whose providerAlias points at a deleted node", async () => {
    // Some connections exist (so the connected branch runs). One customModel is
    // keyed to a provider node that no longer exists (deleted / failed import).
    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "conn-1",
        provider: "openai-compatible-chat-validnode-1234",
        authType: "apikey",
        isActive: true,
        providerSpecificData: { baseUrl: "https://example.com/v1", prefix: "ok" },
      },
    ]);
    mocks.getProviderNodes.mockResolvedValue([
      { id: "openai-compatible-chat-validnode-1234", type: "openai-compatible", name: "Valid" },
    ]);
    mocks.getCustomModels.mockResolvedValue([
      // Valid: alias is a real provider (noAuth opencode alias `oc`)
      { providerAlias: "oc", id: "mimo-v2.5-free", type: "llm", name: "mimo-v2.5-free" },
      // Valid: alias is an existing provider node id
      { providerAlias: "openai-compatible-chat-validnode-1234", id: "glm-5.2", type: "llm", name: "glm-5.2" },
      // Orphan: alias references a node that has been deleted
      { providerAlias: "openai-compatible-chat-deletednode-9999", id: "qwen-3", type: "llm", name: "qwen-3" },
    ]);
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 })
    );

    const models = await buildModelsList([LLM_KIND]);
    const ids = models.map((m) => m.id);

    // Valid custom models exposed (connected node uses its prefix `ok`)
    expect(ids).toContain("oc/mimo-v2.5-free");
    expect(ids).toContain("ok/glm-5.2");
    // Orphan pointing at a deleted node is NOT exposed
    expect(ids).not.toContain("openai-compatible-chat-deletednode-9999/qwen-3");
  });

  it("filters orphan custom models even when there are zero active connections", async () => {
    // Zero connections (healthy DB). The orphan custom-model branch runs and
    // must still drop entries whose alias references a deleted node.
    mocks.getProviderConnections.mockResolvedValue([]);
    mocks.getCustomModels.mockResolvedValue([
      { providerAlias: "oc", id: "mimo-v2.5-free", type: "llm", name: "mimo-v2.5-free" },
      { providerAlias: "openai-compatible-chat-deletednode-8888", id: "kimi-k3", type: "llm", name: "kimi-k3" },
    ]);

    const models = await buildModelsList([LLM_KIND]);
    const ids = models.map((m) => m.id);

    expect(ids).toContain("oc/mimo-v2.5-free");
    expect(ids).not.toContain("openai-compatible-chat-deletednode-8888/kimi-k3");
  });

  it("filters custom models of a node whose connection is disabled", async () => {
    // The node exists but its only connection is disabled (isActive=false), so
    // its customModels must not surface in /v1/models (dead node).
    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "conn-disabled",
        provider: "openai-compatible-chat-disablednode-1111",
        authType: "apikey",
        isActive: false, // disabled connection
        providerSpecificData: { baseUrl: "https://example.com/v1", prefix: "dd" },
      },
    ]);
    mocks.getProviderNodes.mockResolvedValue([
      { id: "openai-compatible-chat-disablednode-1111", type: "openai-compatible", name: "Dead" },
    ]);
    mocks.getCustomModels.mockResolvedValue([
      { providerAlias: "openai-compatible-chat-disablednode-1111", id: "claude-4.8-opus", type: "llm", name: "claude-4.8-opus" },
    ]);

    const models = await buildModelsList([LLM_KIND]);
    const ids = models.map((m) => m.id);

    expect(ids).not.toContain("openai-compatible-chat-disablednode-1111/claude-4.8-opus");
  });

  // Fetched/imported custom models are written with enabled:false so the user
  // enables on demand — /v1/models must honor that flag everywhere.
  it("does NOT expose a custom model whose own enabled flag is false (zero connections)", async () => {
    mocks.getProviderConnections.mockResolvedValue([]);
    mocks.getCustomModels.mockResolvedValue([
      { providerAlias: "oc", id: "mimo-v2.5-free", type: "llm", name: "mimo-v2.5-free", enabled: true },
      { providerAlias: "oc", id: "kimi-k3-free", type: "llm", name: "kimi-k3-free", enabled: false },
    ]);

    const models = await buildModelsList([LLM_KIND]);
    const ids = models.map((m) => m.id);

    expect(ids).toContain("oc/mimo-v2.5-free");
    expect(ids).not.toContain("oc/kimi-k3-free");
  });

  it("does NOT expose a disabled custom model tied to an active connection", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "conn-1",
        provider: "openai-compatible-chat-validnode-1234",
        authType: "apikey",
        isActive: true,
        providerSpecificData: { baseUrl: "https://example.com/v1", prefix: "ok" },
      },
    ]);
    mocks.getProviderNodes.mockResolvedValue([
      { id: "openai-compatible-chat-validnode-1234", type: "openai-compatible", name: "Valid" },
    ]);
    mocks.getCustomModels.mockResolvedValue([
      { providerAlias: "openai-compatible-chat-validnode-1234", id: "glm-5.2", type: "llm", name: "glm-5.2", enabled: true },
      { providerAlias: "openai-compatible-chat-validnode-1234", id: "glm-5.3", type: "llm", name: "glm-5.3", enabled: false },
    ]);
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 })
    );

    const models = await buildModelsList([LLM_KIND]);
    const ids = models.map((m) => m.id);

    expect(ids).toContain("ok/glm-5.2");
    expect(ids).not.toContain("ok/glm-5.3");
  });

  it("does NOT expose a disabled orphan custom model (alias without active connection)", async () => {
    mocks.getProviderConnections.mockResolvedValue([
      {
        id: "conn-1",
        provider: "openai-compatible-chat-validnode-1234",
        authType: "apikey",
        isActive: true,
        providerSpecificData: { baseUrl: "https://example.com/v1", prefix: "ok" },
      },
    ]);
    mocks.getProviderNodes.mockResolvedValue([
      { id: "openai-compatible-chat-validnode-1234", type: "openai-compatible", name: "Valid" },
    ]);
    mocks.getCustomModels.mockResolvedValue([
      { providerAlias: "oc", id: "mimo-v2.5-free", type: "llm", name: "mimo-v2.5-free", enabled: false },
    ]);
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 })
    );

    const models = await buildModelsList([LLM_KIND]);
    const ids = models.map((m) => m.id);

    expect(ids).not.toContain("oc/mimo-v2.5-free");
  });
});
