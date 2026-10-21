// The Experimental page is the only place the new daily check-in controls live.
// Its labels/descriptions were shipped as English literals while the rest of the
// page was localized, so a zh-CN user saw a half-English card. This guard reads
// the strings straight out of the component (including the GENERIC_CHECKINS
// table that is rendered through translate(variable)) and requires both Chinese
// dictionaries to carry them.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const rootDir = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const componentPath = resolve(
  rootDir,
  "src/app/(dashboard)/dashboard/experimental/ExperimentalClient.js"
);

function readJson(rel) {
  return JSON.parse(readFileSync(resolve(rootDir, rel), "utf8"));
}

function experimentalKeys() {
  const src = readFileSync(componentPath, "utf8");
  const keys = new Set();

  // Literal translate("…") calls (time picker, card headings, legacy toggles).
  for (const match of src.matchAll(/translate\("((?:[^"\\]|\\.)*)"\)/g)) {
    keys.add(match[1]);
  }

  // GENERIC_CHECKINS rows are rendered as translate(label)/translate(desc);
  // their strings are properties, not translate("…") literals.
  const block = src.slice(
    src.indexOf("const GENERIC_CHECKINS = ["),
    src.indexOf("];", src.indexOf("const GENERIC_CHECKINS = ["))
  );
  for (const match of block.matchAll(/\b(?:label|desc):\s*"((?:[^"\\]|\\.)*)"/g)) {
    keys.add(match[1]);
  }

  return [...keys];
}

describe("Experimental check-in controls are localized", () => {
  for (const locale of ["zh-CN", "zh-TW"]) {
    it(`${locale} carries every label and description`, () => {
      const dict = readJson(`public/i18n/literals/${locale}.json`);
      const missing = experimentalKeys().filter((key) => !dict[key]);
      expect(missing, `untranslated: ${missing.join(" | ")}`).toEqual([]);
    });
  }

  it("covers the new daily-time and provider rows (sanity)", () => {
    const keys = experimentalKeys();
    for (const required of [
      "Daily check-in time",
      "Trae CN auto daily check-in",
      "CodeArts daily check-in",
      "OfficeAce daily check-in",
      "Loomy daily check-in",
      "AtomCode plan claim",
      "Raccoon daily check-in",
      "LobsterAI daily check-in",
    ]) {
      expect(keys).toContain(required);
    }
  });
});
