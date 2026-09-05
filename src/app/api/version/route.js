import https from "https";
import pkg from "../../../../package.json" with { type: "json" };
import { UPDATER_CONFIG, GITHUB_CONFIG } from "@/shared/constants/config.js";

// Single source of truth with the updater and the Sidebar's install command —
// a second copy here silently drifted to the wrong package once already.
const NPM_PACKAGE_NAME = UPDATER_CONFIG.npmPackageName;
const VERSION_CACHE_TTL_MS = 3600000; // cache npm latest lookup for 1h

// Survive hot reload; one cache per process
const versionCache = (global.__npmVersionCache ??= { value: null, fetchedAt: 0 });

// Fetch latest version from npm registry
function fetchLatestVersion() {
  return new Promise((resolve) => {
    const req = https.get(
      `https://registry.npmjs.org/${NPM_PACKAGE_NAME}/latest`,
      { timeout: 4000 },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data).version || null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

async function getLatestVersionCached() {
  if (versionCache.value && Date.now() - versionCache.fetchedAt < VERSION_CACHE_TTL_MS) {
    return versionCache.value;
  }
  const latest = await fetchLatestVersion();
  if (latest) {
    versionCache.value = latest;
    versionCache.fetchedAt = Date.now();
  }
  return latest;
}

export async function GET() {
  const latestVersion = await getLatestVersionCached();
  const currentVersion = pkg.version;
  const hasUpdate = latestVersion ? compareVersions(latestVersion, currentVersion) > 0 : false;

  // Install-source marker: fnOS fpk launches the server with INSTALL_CHANNEL=fpk
  // (fnos-packaging/cmd/main); the desktop tray shell sets INSTALL_CHANNEL=desktop
  // (desktop/main.js sidecar env); npm/Docker/standalone leave it unset. For both
  // non-npm channels the npm install command is wrong — updates ship as fpk /
  // desktop installers attached to the matching GitHub release, so hand the UI
  // that URL.
  const installChannel = process.env.INSTALL_CHANNEL || "";
  const releaseUrl = installChannel === "fpk" || installChannel === "desktop"
    ? `${GITHUB_CONFIG.repoUrl}/releases/tag/v${latestVersion || currentVersion}`
    : null;

  return Response.json({ currentVersion, latestVersion, hasUpdate, installChannel, releaseUrl });
}
