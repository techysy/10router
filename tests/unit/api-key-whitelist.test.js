import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkApiKeyModelAccess } from "../../src/sse/services/auth.js";

const mockKeyRecord = {
  id: "test-key-id",
  key: "sk-test-whitelist",
  name: "Test Whitelist Key",
  allowedModels: null,
  allowedCombos: null,
};

vi.mock("@/lib/localDb", () => ({
  getApiKeyByKey: vi.fn(async (k) => {
    if (k === "sk-test-whitelist") return mockKeyRecord;
    return null;
  }),
}));

vi.mock("../../src/sse/services/model.js", () => ({
  getComboModels: vi.fn(async (m) => {
    if (m === "smart-combo" || m === "dev-combo") return ["claude-3-5-sonnet", "gpt-4o"];
    return null;
  }),
}));

describe("API Key Model & Combo Whitelist Access Control", () => {
  beforeEach(() => {
    mockKeyRecord.allowedModels = null;
    mockKeyRecord.allowedCombos = null;
  });

  it("allows all models and combos when whitelist is null or empty", async () => {
    expect(await checkApiKeyModelAccess("sk-test-whitelist", "gpt-4o")).toBeNull();
    expect(await checkApiKeyModelAccess("sk-test-whitelist", "smart-combo")).toBeNull();
  });

  it("restricts model access when allowedModels is configured", async () => {
    mockKeyRecord.allowedModels = ["gpt-4o", "claude-3-5-sonnet"];

    expect(await checkApiKeyModelAccess("sk-test-whitelist", "gpt-4o")).toBeNull();
    expect(await checkApiKeyModelAccess("sk-test-whitelist", "openai/gpt-4o")).toBeNull();
    expect(await checkApiKeyModelAccess("sk-test-whitelist", "claude-3-5-sonnet")).toBeNull();

    const blocked = await checkApiKeyModelAccess("sk-test-whitelist", "gemini-2.5-flash");
    expect(blocked).not.toBeNull();
    expect(blocked.status).toBe(403);
    const body = await blocked.json();
    expect(body.error.message).toMatch(/not allowed/);
  });

  it("supports wildcard patterns in allowedModels", async () => {
    mockKeyRecord.allowedModels = ["anthropic/*", "*qwen*"];

    expect(await checkApiKeyModelAccess("sk-test-whitelist", "anthropic/claude-3-haiku")).toBeNull();
    expect(await checkApiKeyModelAccess("sk-test-whitelist", "qwen3.8-max")).toBeNull();

    const blocked = await checkApiKeyModelAccess("sk-test-whitelist", "openai/gpt-4o");
    expect(blocked).not.toBeNull();
    expect(blocked.status).toBe(403);
  });

  it("restricts combo access when allowedCombos is configured", async () => {
    mockKeyRecord.allowedCombos = ["smart-combo"];

    expect(await checkApiKeyModelAccess("sk-test-whitelist", "smart-combo")).toBeNull();

    const blocked = await checkApiKeyModelAccess("sk-test-whitelist", "dev-combo");
    expect(blocked).not.toBeNull();
    expect(blocked.status).toBe(403);
  });
});
