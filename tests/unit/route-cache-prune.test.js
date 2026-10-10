// custom-server.js boot guard: over-install upgrades (NSIS / fpk / npm -g /
// untar) leave the PREVIOUS build's Full Route Cache under
// <distDir>/server/route-cache — prerendered HTML/RSC referencing old hashed
// static chunks. The new server serves those stale entries, so the dashboard
// keeps rendering the old bundle (sidebar version pill stuck at the previous
// version) while /api/version already reports the new release — that is exactly
// what users saw after upgrading 1.3.5 → 1.4.0. The guard must wipe that cache
// whenever BUILD_ID moves, without ever blocking boot.
import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
let pruneStaleRouteCache;

beforeAll(() => {
  // Requiring custom-server.js patches http.createServer (existing tests rely
  // on that) and runs the guard once against the repo root — harmless.
  ({ pruneStaleRouteCache } = require("../../custom-server.js"));
});

function makeTree(buildId, { marker = undefined, cache = true, distDir = ".next-cli-build" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "route-cache-"));
  const serverDir = path.join(root, distDir, "server");
  fs.mkdirSync(serverDir, { recursive: true });
  if (buildId !== null) fs.writeFileSync(path.join(root, distDir, "BUILD_ID"), buildId + "\n");
  if (marker !== undefined) fs.writeFileSync(path.join(serverDir, ".route-cache-build-id"), marker + "\n");
  if (cache) {
    const pageDir = path.join(serverDir, "route-cache", "APP_PAGE", "abc");
    fs.mkdirSync(pageDir, { recursive: true });
    fs.writeFileSync(path.join(pageDir, "dashboard.html"), "<html>old</html>");
  }
  return root;
}

const markerPath = (root, distDir = ".next-cli-build") =>
  path.join(root, distDir, "server", ".route-cache-build-id");
const cacheDir = (root) => path.join(root, ".next-cli-build", "server", "route-cache");

describe("pruneStaleRouteCache", () => {
  it("keeps the cache when the marker matches BUILD_ID", () => {
    const root = makeTree("build-B", { marker: "build-B" });
    pruneStaleRouteCache(root);
    expect(fs.existsSync(cacheDir(root))).toBe(true);
  });

  it("wipes the cache and refreshes the marker when BUILD_ID moved", () => {
    const root = makeTree("build-B", { marker: "build-A" });
    pruneStaleRouteCache(root);
    expect(fs.existsSync(cacheDir(root))).toBe(false);
    expect(fs.readFileSync(markerPath(root), "utf8").trim()).toBe("build-B");
  });

  it("wipes on first guarded boot (upgrade from a pre-guard build)", () => {
    const root = makeTree("build-B", { marker: undefined });
    pruneStaleRouteCache(root);
    expect(fs.existsSync(cacheDir(root))).toBe(false);
    expect(fs.readFileSync(markerPath(root), "utf8").trim()).toBe("build-B");
  });

  it("writes the marker even when there is no cache yet", () => {
    const root = makeTree("build-B", { marker: undefined, cache: false });
    pruneStaleRouteCache(root);
    expect(fs.readFileSync(markerPath(root), "utf8").trim()).toBe("build-B");
  });

  it("is a no-op for a bare checkout without BUILD_ID", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "route-cache-"));
    expect(() => pruneStaleRouteCache(root)).not.toThrow();
  });

  it("covers the plain .next distDir too", () => {
    const root = makeTree("build-B", { marker: "build-A", distDir: ".next" });
    pruneStaleRouteCache(root);
    expect(fs.existsSync(path.join(root, ".next", "server", "route-cache"))).toBe(false);
    expect(fs.readFileSync(markerPath(root, ".next"), "utf8").trim()).toBe("build-B");
  });
});
