/**
 * authHint i18n contract: AddApiKeyModal pipes authHint through translate(),
 * and every registry authHint that ships in a non-Chinese language carries an
 * entry in both Chinese dictionaries. Guards the #155 follow-up: the Nous
 * authHint rendered raw English in a Chinese UI because the field was never
 * wired through translate() and no dictionary entries existed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import REGISTRY from "open-sse/providers/registry/index.js";

const rootDir = resolve(__dirname, "../..");

function loadDict(locale) {
  return JSON.parse(readFileSync(resolve(rootDir, `public/i18n/literals/${locale}.json`), "utf8"));
}

// A hint starting with CJK is already localized for Chinese users; anything
// else (English, or mixed like qoder's Vietnamese tail) must have entries.
function needsDictionary(hint) {
  return typeof hint === "string" && hint.length > 0 && !/^[一-鿿]/.test(hint.trim());
}

describe("authHint i18n", () => {
  it("AddApiKeyModal pipes authHint through translate()", () => {
    const src = readFileSync(
      resolve(rootDir, "src/app/(dashboard)/dashboard/providers/[id]/AddApiKeyModal.js"),
      "utf8",
    );
    expect(src).toContain("{translate(authHint)}");
  });

  it("every non-Chinese authHint has entries in both Chinese dictionaries", () => {
    const zhCN = loadDict("zh-CN");
    const zhTW = loadDict("zh-TW");
    const missing = [];
    for (const r of REGISTRY) {
      if (!needsDictionary(r?.authHint)) continue;
      for (const [locale, dict] of [["zh-CN", zhCN], ["zh-TW", zhTW]]) {
        if (!dict[r.authHint]) missing.push(`${r.id} (${locale})`);
        else if (!/[一-鿿]/.test(dict[r.authHint])) {
          missing.push(`${r.id} (${locale}: not translated)`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
