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
const inventory = {};

for (const f of r.testResults) {
  const file = toKey(f.name);
  for (const a of f.assertionResults) {
    inventory[`${file} :: ${a.fullName}`] = a.status;
  }
  const hasFailedAssertion = (f.assertionResults || []).some((a) => a.status === "failed");
  if (f.status === "failed" && !hasFailedAssertion) {
    inventory[`${file} :: [suite-level failure]`] = "failed";
  }
}

const out = new URL("./known-inventory.json", import.meta.url);
writeFileSync(out, JSON.stringify(inventory, null, 2) + "\n");
console.log(`Snapshot inventory → ${out.pathname} (${Object.keys(inventory).length} tests)`);
