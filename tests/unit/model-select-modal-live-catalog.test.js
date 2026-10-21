/**
 * ModelSelectModal live catalog — zed joins cursor.
 *
 * Only cursor used to fetch its per-account catalog via
 * /api/providers/[connection]/models. zed's backend registry resolves its
 * catalog live (modelsUrl; the static list is intentionally empty +
 * passthroughModels), but the Combo picker never fetched it, so zed had no
 * selectable models. Source guards pin the provider-general wiring: the
 * constant, the per-provider connection-id map, and the group-builder lookup.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const abs = (rel) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const src = readFileSync(abs("src/shared/components/ModelSelectModal.js"), "utf8");

describe("ModelSelectModal LIVE_CATALOG_PROVIDERS", () => {
  it("includes every credential-backed live catalogue next to cursor/zed", () => {
    const match = src.match(/const LIVE_CATALOG_PROVIDERS\s*=\s*\[([\s\S]*?)\];/);
    expect(match).toBeTruthy();
    for (const provider of [
      "cursor", "zed", "loomy", "lobsterai", "atomcode",
      "raccoon", "codearts", "officeace", "trae-solo",
    ]) {
      expect(match[1]).toContain(`"${provider}"`);
    }
  });

  it("collects per-provider connection ids for every live catalog provider", () => {
    expect(src).toContain("liveConnectionIdsByProvider");
    expect(src).toMatch(/LIVE_CATALOG_PROVIDERS\.map\(async \(providerId\)|LIVE_CATALOG_PROVIDERS\.map\(/);
  });

  it("feeds live models into the group builder with static catalog as fallback", () => {
    expect(src).toContain("liveCatalogModels[providerId]");
    expect(src).toContain("getModelsByProviderId(providerId)");
  });

  it("strips the API's <provider>/ prefix before the group builder adds the alias", () => {
    // /api/providers/[id]/models returns prefixed ids (they are the request
    // model Basic Chat uses); this modal builds `${alias}/${id}` itself, so a
    // retained prefix would become `loomy/loomy/...`.
    expect(src).toContain("raw.startsWith(prefix)");
    expect(src).toContain("raw.slice(prefix.length)");
  });

  it("no longer keys the live path on a cursor-only state", () => {
    expect(src).not.toContain("cursorModels");
  });
});
