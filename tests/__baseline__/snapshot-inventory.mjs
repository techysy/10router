// Rebuild known-inventory.json from a vitest JSON report (same extraction
// logic as verify-no-regression.mjs — assertion-level rows plus the
// "[suite-level failure]" synthetic row for import/teardown-only failures).
// Usage: node tests/__baseline__/snapshot-inventory.mjs <results.json>
import { readFileSync, writeFileSync } from "fs";

const resultsPath = process.argv[2];
if (!resultsPath) { console.error("Usage: node snapshot-inventory.mjs <results.json>"); process.exit(2); }

function toKey(absPath) {
  const p = absPath.replace(/\\/g, "/");
  const i = p.lastIndexOf("/tests/");
  return i < 0 ? p : p.slice(i + 1);
}

const r = JSON.parse(readFileSync(resultsPath, "utf8"));
const statuses = {};

for (const f of r.testResults) {
  const file = toKey(f.name);
  for (const a of f.assertionResults) {
    statuses[`${file} :: ${a.fullName}`] = a.status;
  }
  const hasFailedAssertion = (f.assertionResults || []).some((a) => a.status === "failed");
  if (f.status === "failed" && !hasFailedAssertion) {
    statuses[`${file} :: [suite-level failure]`] = "failed";
  }
}

// Sort by key. vitest's report order depends on file discovery and worker
// scheduling, so the unsorted snapshot rewrote the whole file on every
// re-baseline: the one commit in this repo that touched it came out as
// 6500 changed lines for 25 added tests, burying the actual delta.
const inventory = Object.fromEntries(Object.entries(statuses).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

const out = new URL("./known-inventory.json", import.meta.url);
writeFileSync(out, JSON.stringify(inventory, null, 2) + "\n");
console.log(`Snapshot inventory → ${out.pathname} (${Object.keys(inventory).length} tests)`);
