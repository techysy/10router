// Rewrite known-fails.txt AND known-inventory.json from a vitest JSON report,
// so the regression gate can be re-baselined without hand-editing lists.
//
// Usage: node tests/__baseline__/snapshot-known-fails.mjs <results.json>
//
// Only do this deliberately — every failure in the report becomes "expected",
// so re-baselining on a run that contains a genuine regression bakes that
// regression in. Run verify-no-regression.mjs first and read what it reports.
//
// Two files, always written together so they cannot drift:
//   known-fails.txt      — tests that failed in this run (the "expected red")
//   known-inventory.json — EVERY test key -> status. The gate needs the passing
//                          entries too: a test that disappears entirely or
//                          silently downgrades to `skipped` is not a "failure"
//                          and would otherwise be invisible.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const resultsPath = process.argv[2];
if (!resultsPath) {
  console.error("Usage: node tests/__baseline__/snapshot-known-fails.mjs <results.json>");
  process.exit(2);
}

// Keys are `tests/`-relative — same derivation as verify-no-regression.mjs.
function toKey(absPath) {
  const p = absPath.replace(/\\/g, "/");
  const i = p.lastIndexOf("/tests/");
  return i < 0 ? p : p.slice(i + 1);
}

const report = JSON.parse(readFileSync(resultsPath, "utf8"));
const inventory = {};
const fails = [];

for (const f of report.testResults || []) {
  const file = toKey(f.name);
  for (const a of f.assertionResults || []) {
    const key = `${file} :: ${a.fullName}`;
    inventory[key] = a.status;
    if (a.status === "failed") fails.push(key);
  }
  // A suite that died on import/teardown has no failed assertion to key on, so
  // give it a synthetic entry. Otherwise the gate cannot see it at all — which
  // is exactly how suite-level failures stayed invisible.
  const hasFailedAssertion = (f.assertionResults || []).some((a) => a.status === "failed");
  if (f.status === "failed" && !hasFailedAssertion) {
    const key = `${file} :: [suite-level failure]`;
    inventory[key] = "failed";
    fails.push(key);
  }
}

const sorted = [...new Set(fails)].sort();
const here = dirname(fileURLToPath(import.meta.url));

const failsPath = join(here, "known-fails.txt");
writeFileSync(failsPath, sorted.length ? `${sorted.join("\n")}\n` : "");

const inventoryPath = join(here, "known-inventory.json");
const ordered = Object.fromEntries(Object.keys(inventory).sort().map((k) => [k, inventory[k]]));
writeFileSync(inventoryPath, `${JSON.stringify(ordered, null, 2)}\n`);

console.log(`Wrote ${sorted.length} known failures → ${failsPath}`);
console.log(`Wrote ${Object.keys(ordered).length} inventory entries → ${inventoryPath}`);
