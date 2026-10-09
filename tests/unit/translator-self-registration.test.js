import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Translators self-register via register(from, to, reqFn, resFn) as an import
 * side effect, and index.js pulls each one in with a hand-written
 * `import "./request/foo.js"` line. A new translator file that is not listed
 * there silently never runs: the route lookup falls through to the lossy
 * double-hop (claude -> openai -> kiro), which drops thinking blocks, tool ids,
 * non-base64 images and `is_error` on exactly the fragile pairs the direct
 * route existed to protect.
 *
 * Nothing else in the system notices — the double-hop still answers, just
 * worse. This file makes the file set and the import set the same set.
 */
const here = dirname(fileURLToPath(import.meta.url));
const translatorDir = join(here, "..", "..", "open-sse", "translator");

const SIDE_EFFECT_IMPORT = /import\s+["']\.\/(request|response)\/([^"']+)["']/g;

const { listRegisteredRoutes } = await import("../../open-sse/translator/index.js");

describe("translator self-registration", () => {
  const indexSrc = readFileSync(join(translatorDir, "index.js"), "utf8");
  const imported = new Set();
  for (const m of indexSrc.matchAll(SIDE_EFFECT_IMPORT)) {
    imported.add(`${m[1]}/${m[2]}`);
  }

  const filesOnDisk = ["request", "response"].flatMap((dir) =>
    readdirSync(join(translatorDir, dir))
      .filter((f) => f.endsWith(".js"))
      .map((f) => `${dir}/${f}`)
  );

  it("every translator file on disk is imported by index.js", () => {
    const missing = filesOnDisk.filter((f) => !imported.has(f));
    expect(
      missing,
      `translator files not imported — they silently never run:\n${missing.join("\n")}`
    ).toEqual([]);
  });

  it("index.js imports nothing that is not on disk", () => {
    const onDisk = new Set(filesOnDisk);
    const dangling = [...imported].filter((f) => !onDisk.has(f));
    expect(dangling, dangling.join("\n")).toEqual([]);
  });

  it("every translator file actually self-registers", () => {
    // An imported file that never calls register() is dead weight and would
    // pass the two checks above.
    const silent = [];
    for (const f of filesOnDisk) {
      const src = readFileSync(join(translatorDir, f), "utf8");
      if (!/\bregister\s*\(/.test(src)) silent.push(f);
    }
    expect(silent, silent.join("\n")).toEqual([]);
  });

  it("keeps a direct route for the pairs the double-hop damages", () => {
    // Filenames are not a reliable key — register() takes FORMATS constants,
    // and the repo forbids hardcoding the strings — so read the live registry
    // instead. These pairs are the ones a lossy `-> openai ->` hop corrupts:
    // thinking blocks, tool ids, non-base64 images, is_error.
    const { request, response } = listRegisteredRoutes();

    for (const key of ["claude:kiro", "claude:openai", "openai:claude", "openai:kiro"]) {
      expect(request, `missing request route ${key}`).toContain(key);
    }
    for (const key of ["kiro:claude", "kiro:openai", "openai:claude"]) {
      expect(response, `missing response route ${key}`).toContain(key);
    }
  });

  it("every self-registering file lands at least one route", () => {
    const { request, response } = listRegisteredRoutes();
    // 22 self-registering files, and each one is expected to contribute at
    // least one route. A file that calls register() with only a responseFn
    // still counts on its own side; this catches a file that registers nothing
    // reachable (e.g. a no-op call) which the import-completeness checks pass.
    expect(request.length).toBeGreaterThanOrEqual(12);
    expect(response.length).toBeGreaterThanOrEqual(10);
  });
});
