/**
 * #179 — Loomy's public Bearer endpoint is a text channel in practice.
 * live /models labels the four resold models text+image, but standard
 * image_url requests get 400 (or 200 with the model reading raw base64 as
 * text). The Web attachment path (/api/chat/files + file_ref) is out of the
 * current transport's reach. vision:false keeps combos from preferring Loomy
 * for image requests — the generic vision tiering hands them to a member that
 * can actually read them. If a Web attachment executor ever lands, restore
 * vision and update these pins deliberately.
 */
import { describe, it, expect } from "vitest";
import { getCapabilitiesForModel, PROVIDER_CAPABILITIES } from "../../open-sse/providers/capabilities.js";
import { detectRequiredCapabilities, reorderByCapabilities } from "../../open-sse/services/combo.js";
import { stripUnsupportedModalities } from "../../open-sse/translator/concerns/modality.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const LOOMY_CHAT_IDS = ["qwen3.8-flash", "DeepSeek-V4.1-Flash", "deepseek-v4-flash-1017", "GLM-5.3-Flash"];

describe("Loomy capability rows are text-channel honest", () => {
  it("declares vision:false on all four resold chat models", () => {
    for (const id of LOOMY_CHAT_IDS) {
      const caps = getCapabilitiesForModel("loomy", id);
      expect(`${id} vision=${caps.vision}`).toBe(`${id} vision=false`);
    }
  });

  it("keeps the family window/output/reasoning profile (only vision changed)", () => {
    expect(getCapabilitiesForModel("loomy", "qwen3.8-flash")).toMatchObject({
      reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 131072,
    });
    for (const id of ["DeepSeek-V4.1-Flash", "deepseek-v4-flash-1017"]) {
      expect(getCapabilitiesForModel("loomy", id)).toMatchObject({
        reasoning: true, thinkingFormat: "deepseek", contextWindow: 1000000, maxOutput: 384000,
      });
    }
    expect(getCapabilitiesForModel("loomy", "GLM-5.3-Flash")).toMatchObject({
      reasoning: true, thinkingFormat: "zai", contextWindow: 1000000, maxOutput: 131072,
    });
  });

  it("does not leak into other providers serving the same ids", () => {
    // The canonical rows are the model's own spec — Loomy's channel limitation
    // is a provider-row concern only.
    expect(getCapabilitiesForModel("qwenwork-cn", "qwen3.8-flash").vision).toBe(true);
    expect(getCapabilitiesForModel("deepseek", "deepseek-v4.1-flash").vision).toBe(true);
    expect(getCapabilitiesForModel("opencode-go", "glm-5.3-flash").vision).toBe(true);
  });

  it("pins every shipped loomy chat row, so a new model can't silently claim vision", () => {
    // spark-x2.6 resolves from the floor (vision:false by default) — the whole
    // provider table must stay vision-free until a real image channel exists.
    for (const [id, caps] of Object.entries(PROVIDER_CAPABILITIES.loomy)) {
      expect(`${id} vision=${caps.vision === true}`).toBe(`${id} vision=false`);
    }
  });
});

describe("combo vision tiering hands images away from Loomy", () => {
  const imageBody = { messages: [{ role: "user", content: [
    { type: "text", text: "what is in this image?" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
  ] }] };

  it("detects the image request as requiring vision", () => {
    expect(detectRequiredCapabilities(imageBody).has("vision")).toBe(true);
  });

  it("reorders a loomy-first combo so a real vision member takes the image", () => {
    const models = ["loomy/DeepSeek-V4.1-Flash", "anthropic/claude-sonnet-4.6"];
    const out = reorderByCapabilities(models, detectRequiredCapabilities(imageBody));
    expect(out[0]).toBe("anthropic/claude-sonnet-4.6");
    expect(out).toContain("loomy/DeepSeek-V4.1-Flash"); // demoted, never dropped
    expect(out).toHaveLength(2);
  });

  it("keeps loomy first for text-only requests", () => {
    const models = ["loomy/qwen3.8-flash", "anthropic/claude-sonnet-4.6"];
    const textBody = { messages: [{ role: "user", content: "hi" }] };
    expect(reorderByCapabilities(models, detectRequiredCapabilities(textBody))).toBe(models);
  });

  it("an all-loomy combo keeps order (fallback intact) and strips the image with a placeholder", () => {
    const models = ["loomy/qwen3.8-flash", "loomy/GLM-5.3-Flash"];
    const out = reorderByCapabilities(models, new Set(["vision"]));
    expect(out).toEqual(models); // nobody matches — order unchanged, not emptied

    const body = JSON.parse(JSON.stringify(imageBody));
    stripUnsupportedModalities(body, FORMATS.OPENAI, getCapabilitiesForModel("loomy", "qwen3.8-flash"));
    const content = body.messages[0].content;
    expect(content.some((b) => b.type === "image_url")).toBe(false);
    expect(content.some((b) => b.type === "text" && /image omitted/.test(b.text))).toBe(true);
  });
});