/**
 * #178 — Responses → Chat Completions must normalize image_url.detail.
 * Codex sends detail:"original" (valid on the Responses API), but Chat-only
 * upstreams (DuMate) validate auto/low/high and 400 before the model runs.
 * Both Responses→Chat paths must share one normalizer; the reverse
 * Chat→Responses direction keeps passthrough semantics untouched.
 */
import { describe, it, expect } from "vitest";
import { normalizeChatImageDetail } from "../../open-sse/translator/concerns/imageDetail.js";
import { convertResponsesApiFormat } from "../../open-sse/translator/formats/responsesApi.js";
import {
  openaiResponsesToOpenAIRequest,
  openaiToOpenAIResponsesRequest,
} from "../../open-sse/translator/request/openai-responses.js";
import { CHAT_IMAGE_DETAILS, DEFAULT_IMAGE_DETAIL } from "../../open-sse/translator/schema/index.js";

const IMG = "data:image/png;base64,AAAA";

function responsesBody(detail) {
  const image = { type: "input_image", image_url: IMG };
  if (detail !== undefined) image.detail = detail;
  return {
    model: "dumate/qwen38-flash",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "what is this?" }, image] }],
  };
}

function imageBlockOf(converted) {
  return converted.messages.at(-1).content.find((c) => c.type === "image_url");
}

describe("normalizeChatImageDetail", () => {
  it("keeps the three Chat-legal values", () => {
    expect(CHAT_IMAGE_DETAILS).toEqual(["auto", "low", "high"]);
    expect(normalizeChatImageDetail("auto")).toBe("auto");
    expect(normalizeChatImageDetail("low")).toBe("low");
    expect(normalizeChatImageDetail("high")).toBe("high");
  });

  it("maps the Responses-only 'original' to auto (#178 DuMate 400)", () => {
    expect(normalizeChatImageDetail("original")).toBe(DEFAULT_IMAGE_DETAIL);
  });

  it("maps missing or malformed values to auto", () => {
    for (const bad of [undefined, null, "", "AUTO", "High", "ultra", 42, {}, ["high"]]) {
      expect(normalizeChatImageDetail(bad)).toBe("auto");
    }
  });
});

describe("convertResponsesApiFormat (responsesHandler path)", () => {
  it("normalizes detail:'original' to auto", () => {
    const out = convertResponsesApiFormat(responsesBody("original"));
    expect(imageBlockOf(out).image_url).toEqual({ url: IMG, detail: "auto" });
  });

  it("keeps legal detail values and defaults missing ones", () => {
    expect(imageBlockOf(convertResponsesApiFormat(responsesBody("high"))).image_url.detail).toBe("high");
    expect(imageBlockOf(convertResponsesApiFormat(responsesBody("low"))).image_url.detail).toBe("low");
    expect(imageBlockOf(convertResponsesApiFormat(responsesBody(undefined))).image_url.detail).toBe("auto");
  });

  it("preserves the file_id fallback for the url while normalizing detail", () => {
    const body = {
      input: [{ type: "message", role: "user", content: [{ type: "input_image", file_id: "file-abc", detail: "original" }] }],
    };
    expect(imageBlockOf(convertResponsesApiFormat(body)).image_url).toEqual({ url: "file-abc", detail: "auto" });
  });
});

describe("openaiResponsesToOpenAIRequest (translator path)", () => {
  it("normalizes detail:'original' to auto", () => {
    const out = openaiResponsesToOpenAIRequest("dumate/qwen38-flash", responsesBody("original"), true, null);
    expect(imageBlockOf(out).image_url).toEqual({ url: IMG, detail: "auto" });
  });

  it("keeps legal detail values and defaults missing ones", () => {
    const hi = openaiResponsesToOpenAIRequest("m", responsesBody("high"), true, null);
    expect(imageBlockOf(hi).image_url.detail).toBe("high");
    const none = openaiResponsesToOpenAIRequest("m", responsesBody(undefined), true, null);
    expect(imageBlockOf(none).image_url.detail).toBe("auto");
  });

  it("normalizes every image across a multi-turn input", () => {
    const body = {
      input: [
        { type: "message", role: "user", content: [{ type: "input_image", image_url: IMG, detail: "original" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "a red square" }] },
        { type: "message", role: "user", content: [
          { type: "input_image", image_url: IMG, detail: "bogus" },
          { type: "input_image", image_url: IMG, detail: "low" },
        ] },
      ],
    };
    const out = openaiResponsesToOpenAIRequest("m", body, true, null);
    const details = out.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((c) => c.type === "image_url").map((c) => c.image_url.detail);
    expect(details).toEqual(["auto", "auto", "low"]);
  });
});

describe("Chat → Responses direction stays untouched", () => {
  it("keeps a legal chat detail when building input_image", () => {
    const out = openaiToOpenAIResponsesRequest("m", {
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: IMG, detail: "high" } }] }],
    }, true, null);
    const img = out.input[0].content.find((c) => c.type === "input_image");
    expect(img).toEqual({ type: "input_image", image_url: IMG, detail: "high" });
  });

  it("defaults missing chat detail to auto as before", () => {
    const out = openaiToOpenAIResponsesRequest("m", {
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: IMG } }] }],
    }, true, null);
    expect(out.input[0].content.find((c) => c.type === "input_image").detail).toBe("auto");
  });
});