/**
 * Streaming-default resolution (open-sse/utils/streamDefault.js) — issue #4.
 *
 * Legacy behavior (toggle off): omitted `stream` means streaming
 * (`body.stream !== false` — the upstream-inherited default). The
 * `strictStreamDefault` toggle restores the OpenAI spec: omitted = non-streaming.
 * `forceStream` providers stream in both modes.
 */

import { describe, it, expect } from "vitest";

import { resolveStreamDefault } from "../../open-sse/utils/streamDefault.js";

describe("resolveStreamDefault (issue #4)", () => {
  describe("legacy mode (strictStreamDefault: false) — upstream-compatible", () => {
    const legacy = { providerRequiresStreaming: false, strictStreamDefault: false };

    it("streams when stream is omitted", () => {
      expect(resolveStreamDefault({ ...legacy, bodyStream: undefined })).toBe(true);
    });

    it("streams when stream is explicitly true", () => {
      expect(resolveStreamDefault({ ...legacy, bodyStream: true })).toBe(true);
    });

    it("does not stream when stream is explicitly false", () => {
      expect(resolveStreamDefault({ ...legacy, bodyStream: false })).toBe(false);
    });
  });

  describe("strict mode (strictStreamDefault: true) — OpenAI spec", () => {
    const strict = { providerRequiresStreaming: false, strictStreamDefault: true };

    it("does NOT stream when stream is omitted (spec default)", () => {
      expect(resolveStreamDefault({ ...strict, bodyStream: undefined })).toBe(false);
    });

    it("streams when stream is explicitly true", () => {
      expect(resolveStreamDefault({ ...strict, bodyStream: true })).toBe(true);
    });

    it("does not stream when stream is explicitly false", () => {
      expect(resolveStreamDefault({ ...strict, bodyStream: false })).toBe(false);
    });
  });

  it("forceStream providers stream regardless of mode and request", () => {
    for (const strictStreamDefault of [false, true]) {
      for (const bodyStream of [undefined, false, true]) {
        expect(
          resolveStreamDefault({ bodyStream, providerRequiresStreaming: true, strictStreamDefault })
        ).toBe(true);
      }
    }
  });
});
