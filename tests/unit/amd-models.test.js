import { describe, expect, it } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { resolveStep } from "../../scripts/audit-capabilities.mjs";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";

const amd = REGISTRY.find((p) => p.id === "amd");
const IDS = (amd?.models || []).map((m) => (typeof m === "string" ? m : m.id));

// Both ids were verified against the live endpoint (2026-09-10): the model read a
// two-colour test image correctly and the response carried
// usage.prompt_tokens_details.image_tokens > 0 (228 for Qwen3.8-Flash-Next).
const VISION = ["DeepSeek-V4-Flash-Vision-Exp", "Qwen3.8-Flash-Next"];
// AMD's own model page for Qwen3.8-Flash-Next says 输入模态「文本 + 图像」and its
// reasoning_effort list includes `none`; the provider row used to deny both, which
// silently stripped images and hid the off switch.
const EXPECTED = [
  "DeepSeek-V4-Flash",
  "DeepSeek-V4-Flash-Vision-Exp",
  "Qwen3.8-Flash-Next",
  "MiniCPM5-2B",
];

describe("AMD Token Factory catalog", () => {
  it("matches the live GET /v1/models chat entries", () => {
    expect(IDS).toEqual(EXPECTED);
  });

  it("leaves the OCR-only entry out of the chat catalog", () => {
    // GET /v1/models also returns MinerU2.5-Pro, but it advertises
    // output_modalities ["ocr"] and is billed per page — it takes no chat request,
    // so offering it here would only produce broken model cards.
    expect(IDS).not.toContain("MinerU2.5-Pro");
  });
});

describe("AMD capability rows", () => {
  it("declares vision on exactly the two models that take images", () => {
    for (const id of EXPECTED) {
      expect(getCapabilitiesForModel("amd", id).vision, id).toBe(VISION.includes(id));
    }
  });

  it("resolves Vision-Exp through the provider row, not the lowercase pattern", () => {
    // Capability lookup is case-sensitive. AMD publishes TitleCase ids, so without
    // this row the id lands on `*deepseek-v4*` — 1M/384000 but vision:false — and
    // every image is dropped at the modality gate before dispatch.
    const step = resolveStep("amd", "DeepSeek-V4-Flash-Vision-Exp");
    expect(`${step.step}:${step.key}`).toBe("provider:DeepSeek-V4-Flash-Vision-Exp");
    expect(getCapabilitiesForModel("amd", "DeepSeek-V4-Flash-Vision-Exp")).toMatchObject({
      vision: true,
      reasoning: true,
      thinkingFormat: "openai",
      contextWindow: 1048576,
    });
  });

  it("keeps Qwen3.8-Flash-Next switchable: images in, thinking off on request", () => {
    // The endpoint thinks by default, but accepts reasoning_effort `none`, so the
    // off switch has to stay visible in the UI.
    expect(getCapabilitiesForModel("amd", "Qwen3.8-Flash-Next")).toMatchObject({
      vision: true,
      reasoning: true,
      thinkingFormat: "openai",
      thinkingCanDisable: true,
      contextWindow: 262144,
    });
  });

  it("describes MiniCPM5-2B as text-only with no separate reasoning", () => {
    // Smallest window on the endpoint, and the only model that returns no
    // reasoning channel at all — reasoning_effort does not apply to it.
    expect(getCapabilitiesForModel("amd", "MiniCPM5-2B")).toMatchObject({
      vision: false,
      reasoning: false,
      contextWindow: 131072,
    });
  });

  it("routes thinking through reasoning_effort for every model that has one", () => {
    // The endpoint 400s on the native `thinking` field, so nothing here may claim
    // an anthropic-style thinking format.
    for (const id of ["DeepSeek-V4-Flash", "DeepSeek-V4-Flash-Vision-Exp", "Qwen3.8-Flash-Next"]) {
      expect(getCapabilitiesForModel("amd", id).thinkingFormat, id).toBe("openai");
    }
  });
});

describe("AMD reasoning_effort picker", () => {
  const SEVEN = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

  it("gives both DeepSeek ids the full seven-value set", () => {
    // The glob has to carry a `*`: pristine `DeepSeek-V4-Flash` is anchored, so the
    // Vision-Exp sibling would silently fall back to the openai default and lose
    // the `max` step.
    expect(getThinkingLevels("amd", "DeepSeek-V4-Flash")).toEqual(SEVEN);
    expect(getThinkingLevels("amd", "DeepSeek-V4-Flash-Vision-Exp")).toEqual(SEVEN);
  });

  it("keeps `none` selectable on Qwen3.8-Flash-Next so thinking can be turned off", () => {
    // AMD accepts none|low|medium|xhigh here. `none` disappears automatically if
    // the capability row claims thinkingCanDisable:false, which is why the two
    // have to agree.
    expect(getThinkingLevels("amd", "Qwen3.8-Flash-Next")).toEqual(["none", "low", "medium", "xhigh"]);
  });

  it("offers no picker at all for MiniCPM5-2B", () => {
    expect(getThinkingLevels("amd", "MiniCPM5-2B")).toBeNull();
  });
});
