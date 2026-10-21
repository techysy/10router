/**
 * AtomCode registry: the catalogue must be the union of two pools.
 *
 * `/v1/models` only lists the AI Hub pool; the CodingPlan ids answer on the
 * same gateway without being advertised there. A registry seeded from either
 * source alone gives users an incomplete picker.
 */
import { describe, expect, it } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import {
  ATOMCODE_AI_HUB_MODELS,
  ATOMCODE_CODING_PLAN_MODELS,
  mergeAtomcodeModels,
  resolveAtomcodeModelId,
} from "../../open-sse/providers/registry/atomcode.js";

const atomcode = REGISTRY.find((entry) => entry.id === "atomcode");

describe("atomcode registry entry", () => {
  it("is an oauth provider with both auth modes on the unsigned gateway", () => {
    expect(atomcode).toBeDefined();
    expect(atomcode.category).toBe("oauth");
    expect(atomcode.authModes).toEqual(["oauth", "apikey"]);
    expect(atomcode.transport.baseUrl).toBe("https://api-ai.gitcode.com/v1/chat/completions");
    expect(atomcode.transport.format).toBe("openai");
    expect(atomcode.oauth.refreshUrl).toBe("https://acs.atomgit.com/oauth/refresh");
    expect(atomcode.transport.baseUrl).not.toContain("llm-api.atomgit.com");
  });

  it("seeds both pools and no duplicates", () => {
    const ids = atomcode.models.map((model) => model.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const model of [...ATOMCODE_CODING_PLAN_MODELS, ...ATOMCODE_AI_HUB_MODELS]) {
      expect(ids).toContain(model.id);
    }
    // The A-pool ids are the ones `/v1/models` does not list.
    expect(ids).toContain("glm5.3-flash");
    expect(ids).toContain("deepseek-ai/DeepSeek-V4-Flash");
  });

  it("keeps every model displayable and vision claims conservative", () => {
    for (const model of atomcode.models) {
      expect(typeof model.name).toBe("string");
      expect(model.name.length).toBeGreaterThan(0);
    }
    const plain = atomcode.models.find((model) => model.id === "Qwen/Qwen3-32B");
    expect(plain?.vision).toBeUndefined();
  });
});

describe("mergeAtomcodeModels", () => {
  it("unions a models-v2 response with an OpenAI /v1/models envelope", () => {
    const codingPlan = [
      { id: "glm5.3-flash", name: "GLM-5.3-Flash", contextWindow: 512000 },
      { id: "qwen3.8-27b", name: "Qwen3.8-27B" },
    ];
    const aiHub = {
      object: "list",
      data: [
        { id: "deepseek-ai/DeepSeek-V4-Flash", object: "model" },
        { id: "glm5.3-flash", object: "model", name: "duplicate from hub" },
      ],
    };

    const merged = mergeAtomcodeModels({ codingPlan, aiHub });
    expect(merged.map((model) => model.id)).toEqual([
      "glm5.3-flash",
      "qwen3.8-27b",
      "deepseek-ai/DeepSeek-V4-Flash",
    ]);
    // CodingPlan metadata wins over the duplicate hub row.
    expect(merged[0].name).toBe("GLM-5.3-Flash");
    expect(merged[0].pool).toBe("codingplan");
    expect(merged[2].pool).toBe("ai-hub");
  });

  it("tolerates a bare array and drops malformed entries", () => {
    const merged = mergeAtomcodeModels({
      aiHub: [{ id: "Qwen/Qwen3-32B" }, { id: "" }, null, { name: "no id" }],
    });
    expect(merged.map((model) => model.id)).toEqual(["Qwen/Qwen3-32B"]);
  });
});

describe("resolveAtomcodeModelId", () => {
  it("maps display names, prefixes and leaves B-pool slashes intact", () => {
    expect(resolveAtomcodeModelId("GLM-5.3-Flash")).toBe("glm5.3-flash");
    expect(resolveAtomcodeModelId("deepseek-v4.1-flash")).toBe("deepseek-flash");
    expect(resolveAtomcodeModelId("atomcode/qwen3.8-27b")).toBe("qwen3.8-27b");
    expect(resolveAtomcodeModelId("acct-1/glm5.3-flash")).toBe("glm5.3-flash");
    expect(resolveAtomcodeModelId("Qwen/Qwen3-32B")).toBe("Qwen/Qwen3-32B");
    expect(resolveAtomcodeModelId("Qwen/Qwen3-30B-A3B-Thinking-2507")).toBe(
      "Qwen/Qwen3-30B-A3B-Thinking-2507"
    );
  });

  it("returns unknown names unchanged instead of guessing", () => {
    expect(resolveAtomcodeModelId("no-such-model-xyz")).toBe("no-such-model-xyz");
    expect(resolveAtomcodeModelId("")).toBe("");
  });
});
