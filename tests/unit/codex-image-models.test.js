// The GPT Image 2.5 family is tool-backed on Codex: it is declared `kind: "image"` with
// multi-image support so the dashboard can offer generate/edit, and mirrored in the OpenAI
// catalog for direct API use. The handler routes those ids to the responses model and passes
// the picked model through the image_generation tool, so the registry declaration and the
// handler's tool-model set must stay in sync — this file guards both directions.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { getModelsByProviderId } from "../../open-sse/config/providerModels.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HANDLER = "open-sse/handlers/imageProviders/codex.js";
const read = (rel) => readFileSync(resolve(REPO_ROOT, rel), "utf8");

const find = (providerId, modelId) => getModelsByProviderId(providerId).find((m) => m.id === modelId);

const HANDLER_TOOL_MODELS = (() => {
  const block = read(HANDLER).match(/const CODEX_TOOL_IMAGE_MODELS = new Set\(\[([\s\S]*?)\]\)/);
  if (!block) throw new Error("CODEX_TOOL_IMAGE_MODELS literal not found in the codex image handler");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
})();

const MULTI_IMAGE_CODEX_MODELS = getModelsByProviderId("codex")
  .filter((m) => m.kind === "image" && (m.capabilities || []).includes("multiImage"))
  .map((m) => m.id);

const OPENAI_IMAGE_MODELS = ["gpt-image-2.5", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"];

describe("Codex GPT Image 2.5 family", () => {
  it("declares the handler's tool models as multi-image image models", () => {
    expect(HANDLER_TOOL_MODELS.length).toBeGreaterThan(0);

    for (const id of HANDLER_TOOL_MODELS) {
      const model = find("codex", id);

      expect(model, id).toBeDefined();
      expect(model.kind, id).toBe("image");
      expect(model.capabilities, id).toEqual(["text2img", "edit", "multiImage"]);
      expect(model.params, id).toContain("image_detail");
    }
  });

  it("keeps the registry's multiImage declaration and the handler set identical", () => {
    // Either side drifting means a model is offered with the wrong routing, or routed without
    // being offered.
    expect([...MULTI_IMAGE_CODEX_MODELS].sort()).toEqual([...HANDLER_TOOL_MODELS].sort());
  });

  it("matches tool models by exact id, never through the -image suffix", () => {
    // stripImageSuffix() handles the legacy gpt-5.x-image models; a tool-backed id carrying the
    // suffix would silently fall back to the legacy shape and lose the tool model.
    for (const id of HANDLER_TOOL_MODELS) expect(id.endsWith("-image")).toBe(false);
  });

  it.each(OPENAI_IMAGE_MODELS)("mirrors %s in the OpenAI catalog", (id) => {
    const model = find("openai", id);

    expect(model, id).toBeDefined();
    expect(model.kind, id).toBe("image");
    expect(model.params, id).toEqual(["n", "size", "quality", "response_format"]);
  });

  it("leaves the pre-existing codex image models on the legacy declaration", () => {
    for (const id of ["gpt-5.6-sol-image", "gpt-5.5-image", "gpt-5.3-image"]) {
      expect(find("codex", id)?.capabilities, id).toEqual(["text2img", "edit"]);
    }
  });
});
