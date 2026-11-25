/**
 * ModelSelectModal — topology-hidden noAuth providers stay out of the combo
 * picker (2026-11-23 user report: OpenCode Free / MiMo Code Free / MiniMax
 * Code Free kept appearing in the combo model selector even after being
 * hidden from the topology canvas on the providers page).
 *
 * The picker must share the topology-visibility semantics of the two existing
 * implementations — providers/page.js topologyVisibleFor and UsageStats
 * isTopologyVisible: setting false → hidden, true → shown, unset →
!topologyHiddenByDefault. The community toggle (公益站) applies here too,
 * as it does on the topology canvas. Source guards pin the settings fetch,
 * the shared-semantics filter on noAuthIds, and the unconnected-branch guard
 * that stops a hidden noAuth provider resurfacing as an unconnected group.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const abs = (rel) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const src = readFileSync(abs("src/shared/components/ModelSelectModal.js"), "utf8");

describe("ModelSelectModal topology-hidden noAuth filter", () => {
  it("fetches settings when opened (topologyVisibility + showCommunityProviders)", () => {
    expect(src).toContain('fetch("/api/settings"');
    expect(src).toContain("s?.topologyVisibility || {}");
    expect(src).toMatch(/setShowCommunityProviders\(s\?\.showCommunityProviders !== false\)/);
    expect(src).toMatch(/if \(isOpen\) fetchSettings\(\)/);
  });

  it("filters noAuth ids with the shared topology-visibility semantics", () => {
    // Same ternary shape as providers/page.js topologyVisibleFor and
    // UsageStats isTopologyVisible — the three must change together.
    expect(src).toMatch(/setting === false\s*\?\s*false\s*:\s*setting === true\s*\?\s*true\s*:\s*!info\.topologyHiddenByDefault/);
    expect(src).toMatch(/if \(!isTopologyVisibleFor\(info, id\)\) return false/);
    // Community toggle hides 公益站 noAuth channels, same as the topology canvas.
    expect(src).toMatch(/!showCommunityProviders && info\?\.community === true/);
  });

  it("guards the unconnected branch so hidden noAuth providers cannot resurface", () => {
    expect(src).toMatch(/if \(p\.noAuth && !isTopologyVisibleFor\(p, id\)\) return false;/);
    expect(src).toMatch(/if \(p\.noAuth && !showCommunityProviders && p\.community === true\) return false;/);
  });

  it("re-runs the grouping when topology settings arrive", () => {
    expect(src).toMatch(/liveCatalogModels, topologyVisibility, showCommunityProviders\]/);
  });
});
