import { describe, it, expect } from "vitest";
import { getImageAdapter, isImageProvider } from "../../open-sse/handlers/imageProviders/index.js";
import { getProviderIconSrc } from "../../src/shared/utils/providerIcon.js";

const NEW_IMAGE_PROVIDERS = [
  "veoaifree-web",
  "uc-web",
  "gemini-web",
  "muse-web",
  "chatgpt-web",
];

describe("Web Image Providers adapter and icon registration", () => {
  for (const pid of NEW_IMAGE_PROVIDERS) {
    it(`${pid} is registered as image provider with executor-delegating adapter`, () => {
      expect(isImageProvider(pid)).toBe(true);
      const adapter = getImageAdapter(pid);
      expect(adapter).toBeDefined();
      expect(adapter.useExecutor).toBe(true);
      expect(typeof adapter.executeViaExecutor).toBe("function");
    });

    it(`${pid} resolves to an icon asset`, () => {
      const src = getProviderIconSrc(pid);
      expect(src).toBeDefined();
      expect(typeof src).toBe("string");
      expect(src.length).toBeGreaterThan(0);
    });
  }
});
