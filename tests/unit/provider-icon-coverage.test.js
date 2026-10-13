import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { getProviderIconSrc } from "../../src/shared/utils/providerIcon.js";

const rootDir = path.resolve(__dirname, "../..");

// Providers that are virtual/self-hosted endpoints without official static image assets
const ICON_EXEMPT_PROVIDERS = new Set([
  "selfhosted-embedding",
  "selfhosted-stt",
  "selfhosted-tts",
  "alims-intl",
  "alitp-intl",
]);

describe("Provider Icon Coverage", () => {
  it("verifies that all active registry providers resolve to an existing public icon", () => {
    const missing = [];
    for (const r of REGISTRY) {
      if (!r?.id || ICON_EXEMPT_PROVIDERS.has(r.id)) continue;
      const iconSrc = getProviderIconSrc(r.id);
      if (!iconSrc) {
        missing.push(`${r.id} (no iconSrc resolved)`);
        continue;
      }
      const localPath = path.join(rootDir, "public", iconSrc.replace(/^\//, ""));
      if (!fs.existsSync(localPath)) {
        missing.push(`${r.id} (file not found: ${iconSrc})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("confirms minimax-code and minimax-code-global icons exist", () => {
    expect(fs.existsSync(path.join(rootDir, "public/providers/minimax-code.png"))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, "public/providers/minimax-code-global.png"))).toBe(true);
  });
});
