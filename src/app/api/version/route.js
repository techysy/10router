import https from "https";
import fs from "node:fs";
import path from "node:path";
import pkg from "../../../../package.json" with { type: "json" };
import { UPDATER_CONFIG, GITHUB_CONFIG } from "@/shared/constants/config.js";
import { getDataDir } from "@/lib/dataDir.js";
import { getSettings } from "@/lib/localDb";
import { isAutoUpdateCheckEnabled } from "@/lib/updateCheck";
import { compareSemver } from "@/shared/utils/semver.js";

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

// Compare versions with full SemVer and prerelease support (e.g. 1.6.5 > 1.6.2-test.45, 1.6.2 > 1.6.2-test.45)
const compareVersions = compareSemver;

// The version marker the CLI writes into the data dir (hooks/postinstall.js on
// install, cli.js on every launcher start). When it differs from the build that
// is serving THIS request, this process is a leftover from a previous release —
// the "white screen after upgrade" case — and the dashboard should tell the
// user to restart. null when unknown (install without the CLI, or first run).
function readDiskVersion() {
  try {
    const v = fs.readFileSync(path.join(getDataDir(), ".disk-version"), "utf8").trim();
    return v || null;
  } catch {
    return null;
  }
}

// Non-blocking read for the GET handler: NEVER await the npm registry. doctor /
// staleServer probe this endpoint with a ~2s timeout, but a cold getLatestVersion
// Cached() awaits a 4s registry fetch — on a slow / firewalled network the probe
// timed out and doctor flipped to RED (and staleServer failed to spot a leftover
// server). Serve whatever "latest" we already cached (possibly stale, possibly
// null on a cold start) and refresh once in the background; the fields the probes
// actually read (currentVersion / diskVersion) are always instant.
let bgLatestRefreshInFlight = false;
function getLatestVersionNonBlocking() {
  const fresh = versionCache.value && Date.now() - versionCache.fetchedAt < VERSION_CACHE_TTL_MS;
  if (!fresh && !bgLatestRefreshInFlight) {
    bgLatestRefreshInFlight = true;
    fetchLatestVersion()
      .then((latest) => {
        if (latest) {
          versionCache.value = latest;
          versionCache.fetchedAt = Date.now();
        }
      })
      .catch(() => {})
      .finally(() => {
        bgLatestRefreshInFlight = false;
      });
  }
  return versionCache.value || null;
}

// Explicit check (?check=1 — the "Check now" button, the tray's "Check for
// updates"): the user is waiting for an answer, so await the registry, bypass
// the cache, and do it even when automatic checks are off.
async function getLatestVersionNow() {
  const latest = await fetchLatestVersion();
  if (latest) {
    versionCache.value = latest;
    versionCache.fetchedAt = Date.now();
  }
  return latest;
}

export async function GET(request) {
  const explicitCheck = request ? new URL(request.url).searchParams.get("check") === "1" : false;
  let autoCheck = true;
  try {
    autoCheck = isAutoUpdateCheckEnabled(await getSettings());
  } catch { /* unreadable settings: keep the default */ }

  // Automatic checks off: no registry call at all, and no stale cached answer
  // either — nothing may surface an update the operator opted out of hearing
  // about. Otherwise non-blocking: see getLatestVersionNonBlocking — the version
  // probe must not hang on the npm registry.
  const latestVersion = explicitCheck
    ? await getLatestVersionNow()
    : autoCheck ? getLatestVersionNonBlocking() : null;
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

  return Response.json({
    currentVersion, latestVersion, hasUpdate, installChannel, releaseUrl, diskVersion: readDiskVersion(),
    updateCheck: autoCheck,
  });
}
