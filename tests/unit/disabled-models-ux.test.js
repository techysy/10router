/**
 * Issue #14 — disabled-state visibility + disabled-row testability.
 *
 * Repo convention: component behavior is guarded by source-text assertions
 * (no rendering test infra). Locks:
 * A. both "new connection" paths refresh the disabled list too (the FIRST
 *    connection server-side default-disables every built-in LLM model —
 *    refreshing connections only left the UI claiming "all enabled");
 * B. the Disabled section renders full ModelRow rows with onEnable + onTest,
 *    not bare restore chips.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const page = readFileSync(join(ROOT, "src/app/(dashboard)/dashboard/providers/[id]/page.js"), "utf8");
const modelRow = readFileSync(join(ROOT, "src/app/(dashboard)/dashboard/providers/[id]/ModelRow.js"), "utf8");

describe("issue 14: disabled models UX", () => {
  it("A: single-add path refreshes connections AND disabled models", () => {
    expect(page).toContain("const refreshAfterConnectionChange = useCallback");
    expect(page).toContain("await refreshAfterConnectionChange();");
    // The old partial refresh must be gone.
    expect(page).not.toMatch(/if \(res\.ok\) \{\s*\n\s*await fetchConnections\(\);\s*\n\s*setShowAddApiKeyModal/);
  });

  it("A: bulk-add path uses the combined refresh, not fetchConnections alone", () => {
    expect(page).toContain("onBulkDone={refreshAfterConnectionChange}");
    expect(page).not.toContain("onBulkDone={fetchConnections}");
  });

  it("B: disabled section renders ModelRow with enable + test wiring", () => {
    // Both disabled maps go through ModelRow with an onEnable action…
    const disabledSection = page.slice(page.indexOf("Disabled models ("));
    expect(disabledSection).toContain("<ModelRow");
    expect(disabledSection).toContain("onEnable={() => handleEnableModel(model.id)}");
    expect(disabledSection).toContain("onEnable={() => handleToggleCustomModel(model.id, true)}");
    // …and Test is wired for disabled rows just like active ones…
    expect(disabledSection).toContain("onTest={connections.length > 0 || isFreeNoAuth ? () => handleTestModel(model.id) : undefined}");
    // …whereas the bare restore chips are gone.
    expect(disabledSection).not.toContain('title="Restore model"');
  });

  it("B: ModelRow supports the onEnable (+ add) primary action", () => {
    expect(modelRow).toContain("onEnable");
    expect(modelRow).toContain('title={translate("Enable this model")}');
  });
});
