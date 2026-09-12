import { cpSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export function copyStandaloneAssets({ projectRoot = process.cwd(), distDir = process.env.NEXT_DIST_DIR || ".next" } = {}) {
  if (process.env.NEXT_TRACING_ROOT_MODE === "workspace") {
    console.log("[standalone-assets] Skipping workspace-traced CLI build; CLI packaging handles assets");
    return;
  }

  const buildDir = resolve(projectRoot, distDir);
  const standaloneDir = resolve(buildDir, "standalone");

  if (!existsSync(standaloneDir)) {
    console.log(`[standalone-assets] No standalone build found at ${standaloneDir}`);
    return;
  }

  const staticSource = resolve(buildDir, "static");
  const staticDestination = resolve(standaloneDir, distDir, "static");
  if (existsSync(staticSource)) {
    cpSync(staticSource, staticDestination, { recursive: true, force: true });
    console.log(`[standalone-assets] Copied static assets to ${staticDestination}`);
  }

  const publicSource = resolve(projectRoot, "public");
  const publicDestination = resolve(standaloneDir, "public");
  if (existsSync(publicSource)) {
    cpSync(publicSource, publicDestination, { recursive: true, force: true });
    console.log(`[standalone-assets] Copied public assets to ${publicDestination}`);
  }

  // Without it beside server.js the standalone build serves requests unsanitized.
  const serverWrapperSource = resolve(projectRoot, "custom-server.js");
  const serverWrapperDestination = resolve(standaloneDir, "custom-server.js");
  if (existsSync(serverWrapperSource)) {
    cpSync(serverWrapperSource, serverWrapperDestination, { force: true });
    console.log(`[standalone-assets] Copied custom-server.js to ${serverWrapperDestination}`);
  }

  // Standalone-safe outbound-proxy initializer used by custom-server.js at boot.
  // Kept as source (not bundled) so the Node entry can import it without the
  // `@/` alias or Next tree-shaking dropping the side effect.
  const proxyInitSource = resolve(projectRoot, "src", "lib", "network", "outboundProxyStandalone.js");
  const proxyInitDestination = resolve(standaloneDir, "src", "lib", "network", "outboundProxyStandalone.js");
  if (existsSync(proxyInitSource)) {
    cpSync(proxyInitSource, proxyInitDestination, { force: true });
    console.log(`[standalone-assets] Copied outboundProxyStandalone.js to ${proxyInitDestination}`);
  }

  // Standalone-safe console archive tee used by custom-server.js at boot (per-day
  // files under the data dir). Same kept-as-source rationale as the initializer:
  // the Node entry must load it without the `@/` alias or Next tree-shaking.
  const consoleArchiveSource = resolve(projectRoot, "src", "lib", "consoleArchiveStandalone.js");
  const consoleArchiveDestination = resolve(standaloneDir, "src", "lib", "consoleArchiveStandalone.js");
  if (existsSync(consoleArchiveSource)) {
    cpSync(consoleArchiveSource, consoleArchiveDestination, { force: true });
    console.log(`[standalone-assets] Copied consoleArchiveStandalone.js to ${consoleArchiveDestination}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(dirname(fileURLToPath(import.meta.url)), "copy-standalone-assets.mjs")) {
  copyStandaloneAssets();
}
