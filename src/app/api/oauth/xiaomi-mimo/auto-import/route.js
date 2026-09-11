import { NextResponse } from "next/server";
import { readFile, access, constants } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

/**
 * GET /api/oauth/xiaomi-mimo/auto-import
 * Auto-detect Xiaomi MiMo credentials from the local MiMoCode / Desktop auth.json.
 *
 * Sources (in priority order):
 *   1. ~/.local/share/mimocode/auth.json  → xiaomi field
 *   2. %APPDATA%/Xiaomi MiMo/auth.json    → (Windows)
 *   3. ~/Library/Application Support/mimocode/auth.json (macOS)
 *
 * auth.json shape:
 * {
 *   "xiaomi": {
 *     "type": "api",
 *     "key": "sk-xxxx",
 *     "metadata": { "uid": "...", "base_url": "https://api.xiaomimimo.com/v1" }
 *   }
 * }
 *
 * NOTE (privacy): the Desktop account-session passToken lives in MiMo Desktop's own
 * cookie store and is deliberately NOT returned here — the key-import route reads it
 * server-side. This endpoint only reports whether such a session was found, so the
 * credential never round-trips through the browser.
 */

function getCandidatePaths() {
  const home = homedir();
  const paths = [];

  // MiMoCode / MiMo Desktop shared data dir (cross-platform XDG)
  paths.push(join(home, ".local", "share", "mimocode", "auth.json"));

  // Windows: also check USERPROFILE-based XDG
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
    // Desktop's own storage (may have separate credentials in the future)
    paths.push(join(appData, "Xiaomi MiMo", "auth.json"));
  }

  // macOS
  if (process.platform === "darwin") {
    paths.push(join(home, "Library", "Application Support", "mimocode", "auth.json"));
  }

  return paths;
}

/**
 * GET /api/oauth/xiaomi-mimo/auto-import
 */
export async function GET() {
  try {
    const candidates = getCandidatePaths();

    let authPath = null;
    for (const candidate of candidates) {
      try {
        await access(candidate, constants.R_OK);
        authPath = candidate;
        break;
      } catch {
        // Try next candidate
      }
    }

    // Whether Desktop's account session is readable — this is what unlocks the
    // Desktop-exclusive Preview models. The token itself stays on the server.
    let hasDesktopSession = false;
    // A running Desktop holds an exclusive lock on its cookie store. Import can
    // still succeed (the sk- key alone covers the cloud models) — but Preview
    // models need that session, so tell the user why it is missing.
    let desktopLocked = false;
    try {
      const { readDesktopPassToken } = await import("open-sse/shared/mimoAccount.js");
      hasDesktopSession = Boolean(await readDesktopPassToken());
    } catch (e) {
      desktopLocked = e?.code === "DESKTOP_LOCKED";
      console.log("[xiaomi-mimo] passToken read failed (non-fatal):", e.message);
    }

    if (!authPath) {
      return NextResponse.json({
        found: false,
        hasDesktopSession,
        desktopLocked,
        error: desktopLocked
          ? "Xiaomi MiMo Desktop is running and is holding its credential store, so no local credentials could be read. Quit the desktop app completely (including the tray icon) and retry."
          : `Xiaomi MiMo Desktop auth file not found. Checked:\n${candidates.join("\n")}\n\nMake sure Xiaomi MiMo Desktop is installed and you are signed in.`,
      });
    }

    const raw = await readFile(authPath, "utf-8");
    let auth;
    try {
      auth = JSON.parse(raw);
    } catch {
      return NextResponse.json({
        found: false,
        hasDesktopSession,
        desktopLocked,
        error: "auth.json is not valid JSON. Please sign in to Xiaomi MiMo Desktop again.",
      });
    }

    const xiaomi = auth?.xiaomi;
    if (!xiaomi || !xiaomi.key) {
      return NextResponse.json({
        found: false,
        hasDesktopSession,
        desktopLocked,
        error: "No Xiaomi credentials found in auth.json. Please sign in to Xiaomi MiMo Desktop.",
      });
    }

    // Validate key format
    const key = String(xiaomi.key).trim();
    if (!key.startsWith("sk-")) {
      return NextResponse.json({
        found: false,
        hasDesktopSession,
        desktopLocked,
        error: "Xiaomi key does not appear to be a valid API key (expected sk- prefix).",
      });
    }

    const metadata = xiaomi.metadata || {};

    return NextResponse.json({
      found: true,
      apiKey: key,
      uid: metadata.uid || null,
      baseUrl: metadata.base_url || "https://api.xiaomimimo.com/v1",
      source: authPath,
      hasDesktopSession,
      desktopLocked,
    });
  } catch (error) {
    console.log("Xiaomi MiMo auto-import error:", error);
    return NextResponse.json({ found: false, error: error.message }, { status: 500 });
  }
}
