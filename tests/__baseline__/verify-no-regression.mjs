// Gate: so sánh kết quả test hiện tại với baseline known-fails + known-inventory.
// PASS nếu KHÔNG có test nào pass(baseline) → fail/missing/skipped(now).
// Test mới được phép.
// Usage: node tests/__baseline__/verify-no-regression.mjs <current-results.json>
import { readFileSync, existsSync } from "fs";

const knownFails = new Set(
  readFileSync(new URL("./known-fails.txt", import.meta.url), "utf8")
    .split("\n").map(s => s.trim()).filter(Boolean)
);

const inventoryPath = new URL("./known-inventory.json", import.meta.url);
// Optional for a one-file checkout: without it we can still catch pass→fail,
// just not pass→missing / pass→skip / suite-level. Say so rather than pretend.
const hasInventory = existsSync(inventoryPath);
const inventory = hasInventory
  ? JSON.parse(readFileSync(inventoryPath, "utf8"))
  : null;

const resultsPath = process.argv[2];
if (!resultsPath) { console.error("Missing results.json path"); process.exit(2); }

// Keys in known-fails.txt start at `tests/`. Derive that from the absolute path
// vitest reports, rather than assuming the checkout sits under a directory named
// `app/` — it doesn't here, and splitting on "/app/" yielded undefined, so every
// failure looked like a regression and the gate could never pass.
function toKey(absPath) {
  const p = absPath.replace(/\\/g, "/");
  const i = p.lastIndexOf("/tests/");
  return i < 0 ? p : p.slice(i + 1);
}

const r = JSON.parse(readFileSync(resultsPath, "utf8"));

const nowFails = [];
const nowStatus = new Map(); // key -> status, including suite-level rows

for (const f of r.testResults) {
  const file = toKey(f.name);
  for (const a of f.assertionResults) {
    const key = `${file} :: ${a.fullName}`;
    nowStatus.set(key, a.status);
    if (a.status === "failed") nowFails.push(key);
  }
  // A file whose cases all pass can still fail on import or teardown. That is
  // not an assertion failure, so the old filter never saw it — the suite went
  // red and the gate stayed green. Give it a key so it is visible.
  const hasFailedAssertion = (f.assertionResults || []).some((a) => a.status === "failed");
  if (f.status === "failed" && !hasFailedAssertion) {
    const key = `${file} :: [suite-level failure]`;
    nowStatus.set(key, "failed");
    nowFails.push(key);
  }
}

const problems = [];

// 1. Regression = fail bây giờ NHƯNG không có trong baseline known-fails
const regressions = nowFails.filter(f => !knownFails.has(f));
if (regressions.length) {
  problems.push([`REGRESSION: ${regressions.length} test pass→fail`, regressions]);
}

if (hasInventory) {
  // 2. A test that was passing and now SKIPS is not a failure, so nothing else
  //    would notice it had stopped testing anything.
  const skipped = [];
  for (const [key, was] of Object.entries(inventory)) {
    if (was !== "passed") continue;
    const now = nowStatus.get(key);
    if (now === "skipped" || now === "todo") skipped.push(`${key} (now ${now})`);
  }
  if (skipped.length) problems.push([`STALE: ${skipped.length} test pass→skip`, skipped]);

  // 3. A test that vanishes from the run entirely (file deleted, `describe`
  //    commented out, import now throwing before it registers) leaves no
  //    failure row at all. The only trace is that it used to exist.
  const missing = [];
  for (const [key, was] of Object.entries(inventory)) {
    if (was !== "passed" && was !== "failed") continue;
    if (nowStatus.has(key)) continue;
    missing.push(key);
  }
  if (missing.length) problems.push([`MISSING: ${missing.length} test no longer runs`, missing]);
}

if (problems.length) {
  for (const [title, items] of problems) {
    console.error(`\n❌ ${title}:\n`);
    items.forEach(f => console.error("  - " + f));
  }
  process.exit(1);
}

const note = hasInventory
  ? `inventory=${Object.keys(inventory).length}`
  : "no known-inventory.json — pass→missing/skip not checked";
console.log(`✅ No regression. (now fails=${nowFails.length}, baseline known=${knownFails.size}, ${note}, all known)`);
