/**
 * Guard for the combos page model chip lists (dashboard/combos/page.js).
 *
 * Two chip lists look alike but must behave differently:
 *   - ComboCard is a read-only summary → deliberately caps at 3 chips with a
 *     "+N more" tail; every model is editable in the edit modal.
 *   - CapacityAdapterCap's chip list *is* the adapter's only editor (hover
 *     reveals move up/down + remove), so it must render every model — capping
 *     it leaves the 4th onward impossible to reorder or delete, with no way to
 *     reach them (the "+N more" tail was plain text, not a control).
 *
 * Asserted against the source text: the page is a client component pulling in
 * dnd-kit and the whole dashboard component kit, so it cannot be rendered in
 * this node test environment (no jsdom / testing-library here).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(
  path.join(__dirname, "..", "..", "src", "app", "(dashboard)", "dashboard", "combos", "page.js"),
  "utf8"
);

/** Source text of one top-level component, from its `function` to the next one. */
function body(name, nextName) {
  const start = SRC.indexOf(`function ${name}(`);
  const end = SRC.indexOf(`function ${nextName}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  expect(end, `${nextName} not found`).toBeGreaterThan(start);
  return SRC.slice(start, end);
}

describe("combos page model lists", () => {
  const comboCard = body("ComboCard", "CapacityAdapterSection");
  const adapterCap = body("CapacityAdapterCap", "ModelItem");

  it("renders every capacity-adapter model (its chip list is the only editor)", () => {
    expect(adapterCap).toContain("models.map((model, index) => (");
    expect(adapterCap).not.toContain(".slice(0, 3)");
    expect(adapterCap).not.toMatch(/\+\{models\.length - 3\}/);
  });

  it("keeps the combo card a 3-chip summary with a localized tail", () => {
    expect(comboCard).toContain("combo.models.slice(0, 3).map(");
    // Both the tail and the empty state must go through the translator — they
    // were hardcoded English while the adapter row already used translate().
    expect(comboCard).toContain('{translate("more")}');
    expect(comboCard).toContain('{translate("No models")}');
  });

  it("leaves exactly one truncating chip list in the file", () => {
    expect(SRC.match(/\.slice\(0, 3\)/g)).toHaveLength(1);
  });
});
