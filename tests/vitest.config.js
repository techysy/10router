import { defineConfig } from "vitest/config";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "..");

// Suites that can never pass on a given checkout are excluded instead of being
// left red in every run: the regression gate (tests/__baseline__) only treats
// pass→fail as a regression, so a file missing from the report is fine — but it
// must also be dropped from known-fails.txt / known-inventory.json when it stops
// running, or the gate flags it as pass→missing.
const conditionalExcludes = [];
// The cloud/ worker repo is not shipped here, so its handler suite cannot even
// import. If it ever lands locally the suite comes back on its own.
if (!existsSync(resolve(repoRoot, "cloud/src/handlers/embeddings.js"))) {
  conditionalExcludes.push("**/unit/embeddings.cloud.test.js");
}
// db-benchmark compares SQLite against the lowdb layer that the SQLite
// migration removed; it only makes sense while lowdb is a declared dependency.
const rootPkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
const declaredDeps = {
  ...rootPkg.dependencies,
  ...rootPkg.devDependencies,
  ...rootPkg.optionalDependencies,
};
if (!declaredDeps.lowdb) {
  conditionalExcludes.push("**/unit/db-benchmark.test.js");
}

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["**/*.test.js"],
    // Don't scan into git worktrees nested under .claude/ — they carry their
    // own copies of the test files but lack an installed node_modules (open-sse,
    // etc.), which makes provider imports fail during collection.
    exclude: ["**/node_modules/**", "**/.claude/**", "**/dist/**", ...conditionalExcludes],
    // Allow many it.concurrent cases (real provider smoke runs ~50 providers in parallel)
    maxConcurrency: 60,
    // Suppress noisy console output from handlers under test
    silent: false,
  },
  resolve: {
    // Use array form so subpath aliases (e.g. "@/lib/db/index.js") resolve correctly.
    alias: [
      { find: /^open-sse\//, replacement: resolve(__dirname, "../open-sse") + "/" },
      { find: "open-sse", replacement: resolve(__dirname, "../open-sse") },
      { find: /^@\//, replacement: resolve(__dirname, "../src") + "/" },
    ],
  },
});
