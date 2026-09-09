// Default posture: all provider models start disabled, user enables on demand.
// Two halves:
//  1. /v1/models — a JSON-catalog provider (modelsJsonUrl + global toggle ON)
//     never falls back to the full static list: unfetched (null catalog) and
//     all-disabled (empty enabled list) both expose nothing. The old fallback
//     leaked every static model with no way to disable them (dashboard is in
//     JSON mode and renders no static rows).
//  2. createProviderConnection — a provider's FIRST connection default-disables
//     every built-in LLM model (JSON-catalog "new models default disabled"
//     philosophy applied to static catalogs).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi, beforeAll, afterAll } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getProviderNodes: vi.fn(),
  getCombos: vi.fn(),
  getCustomModels: vi.fn(),
  getModelAliases: vi.fn(),
  getDisabledModels: vi.fn(),
  getProviderJsonModels: vi.fn(),
  getSettings: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getProviderNodes: mocks.getProviderNodes,
  getCombos: mocks.getCombos,
  getCustomModels: mocks.getCustomModels,
  getModelAliases: mocks.getModelAliases,
  getProviderJsonModels: mocks.getProviderJsonModels,
  getSettings: mocks.getSettings,
}));

vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: mocks.getDisabledModels,
}));

const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");

const LLM_KIND = "llm";
// codebuddy-cn declares modelsJsonUrl in the registry and has static models.
const JSON_PROVIDER = "codebuddy-cn";

function connectJsonProvider() {
  mocks.getProviderConnections.mockResolvedValue([
    { id: "c1", provider: JSON_PROVIDER, isActive: true, authType: "oauth" },
  ]);
}

describe("/v1/models — JSON catalog is authoritative (no static fallback)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderNodes.mockResolvedValue([]);
    mocks.getCombos.mockResolvedValue([]);
    mocks.getCustomModels.mockResolvedValue([]);
    mocks.getModelAliases.mockResolvedValue({});
    mocks.getDisabledModels.mockResolvedValue({});
    mocks.getSettings.mockResolvedValue({ modelJsonImport: true });
  });

  it("toggle ON + catalog never fetched (null) → exposes NO static models", async () => {
    connectJsonProvider();
    mocks.getProviderJsonModels.mockResolvedValue(null);

    const models = await buildModelsList([LLM_KIND], { skipDynamicFetch: true });
    // owned_by uses the output alias (cbcn), not the provider id
    const providerRows = models.filter((m) => m.owned_by === "cbcn" || m.owned_by === JSON_PROVIDER);
    expect(providerRows).toEqual([]);
  });

  it("toggle ON + every catalog model disabled → exposes nothing (Disable All works)", async () => {
    connectJsonProvider();
    mocks.getProviderJsonModels.mockResolvedValue([
      { id: "glm-5.3", enabled: false },
      { id: "kimi-k3", enabled: false },
    ]);

    const models = await buildModelsList([LLM_KIND], { skipDynamicFetch: true });
    // owned_by uses the output alias (cbcn), not the provider id
    const providerRows = models.filter((m) => m.owned_by === "cbcn" || m.owned_by === JSON_PROVIDER);
    expect(providerRows).toEqual([]);
  });

  it("toggle ON + one model enabled → exposes exactly that model", async () => {
    connectJsonProvider();
    mocks.getProviderJsonModels.mockResolvedValue([
      { id: "glm-5.3", enabled: true },
      { id: "kimi-k3", enabled: false },
    ]);

    const models = await buildModelsList([LLM_KIND], { skipDynamicFetch: true });
    const ids = models.filter((m) => m.owned_by === "cbcn" || m.owned_by === JSON_PROVIDER).map((m) => m.id);
    expect(ids).toEqual(["cbcn/glm-5.3"]);
  });

  it("toggle OFF → static list still served (legacy behavior preserved)", async () => {
    connectJsonProvider();
    mocks.getSettings.mockResolvedValue({ modelJsonImport: false });
    mocks.getProviderJsonModels.mockResolvedValue(null);

    const models = await buildModelsList([LLM_KIND], { skipDynamicFetch: true });
    // owned_by uses the output alias (cbcn), not the provider id
    const providerRows = models.filter((m) => m.owned_by === "cbcn" || m.owned_by === JSON_PROVIDER);
    expect(providerRows.length).toBeGreaterThan(0);
  });
});
