import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FORMATS } from "../../open-sse/translator/formats.js";

/**
 * `FORMATS.CODEX` and `FORMATS.OPENAI_RESPONSE` (the singular — not the same as
 * OPENAI_RESPONSES) exist in the enum and are read by a handful of defensive
 * `case` arms and pivot-table entries, but nothing ever produces them as a
 * targetFormat. That makes those branches unreachable, which is fine as
 * insurance and dangerous as a lie: the enum reads like codex and
 * openai-response are supported targets, so code gets written against them.
 *
 * This asserts the claim in the formats.js header is still true — if a provider
 * row, an executor or a provider config ever starts producing one, the comment
 * has to be rewritten rather than quietly becoming wrong.
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

const TARGET_FORMAT_LITERALS = /targetFormat:\s*["']([a-z-]+)["']/g;
const RESPONSE_FORMAT_LITERALS = /responseFormat:\s*["']([a-z-]+)["']/g;
const CONFIG_FORMAT_LITERALS = /^\s*format:\s*["']([a-z-]+)["']/gm;

function scan(dir, re, acc, ext = ".js") {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) scan(p, re, acc, ext);
    else if (entry.name.endsWith(ext)) {
      for (const m of readFileSync(p, "utf8").matchAll(re)) acc.push({ file: p, value: m[1] });
    }
  }
}

describe("no producer can yield the dead target formats", () => {
  const produced = new Set();

  it("collects every target/response/config format literal in the tree", () => {
    const hits = [];
    for (const dir of ["open-sse", "src"]) scan(join(root, dir), TARGET_FORMAT_LITERALS, hits);
    for (const dir of ["open-sse", "src"]) scan(join(root, dir), RESPONSE_FORMAT_LITERALS, hits);
    for (const dir of ["open-sse", "src"]) scan(join(root, dir), CONFIG_FORMAT_LITERALS, hits);
    for (const h of hits) produced.add(h.value);
    // Sanity: the scan must actually find the live formats, or the assertions
    // below would pass against an empty set.
    expect(produced.has(FORMATS.OPENAI)).toBe(true);
    expect(produced.has(FORMATS.CLAUDE)).toBe(true);
    expect(produced.has(FORMATS.OPENAI_RESPONSES)).toBe(true);
  });

  it("never produces FORMATS.CODEX as a target", () => {
    expect(produced.has(FORMATS.CODEX)).toBe(false);
  });

  it("never produces FORMATS.OPENAI_RESPONSE (the singular) as a target", () => {
    // Easy to mistake for OPENAI_RESPONSES. If this ever trips, the formats.js
    // header is out of date and the defensive arms have become live — rewrite
    // the comment and add real handling rather than deleting this test.
    expect(produced.has(FORMATS.OPENAI_RESPONSE)).toBe(false);
  });
});
