import { getSession, pub } from "open-sse/shared/dumate/qr.js";
import { ownerOf, json, persistQrSession } from "../lib.js";

/**
 * GET /api/oauth/dumate/qr-status?sid=<sid>
 * Poll the QR session. Once it reaches "authorized" the credential is in
 * s.creds — the first poll that sees it persists + tests the connection
 * (persistQrSession), later polls observe saving -> success.
 */
export async function GET(request) {
  try {
    const s = getSession(new URL(request.url).searchParams.get("sid"), ownerOf(request));
    if (!s) return json({ error: "QR session not found or expired — generate a new code" }, 404);
    if (s.status === "authorized") return json(await persistQrSession(s));
    return json(pub(s));
  } catch (e) {
    return json({ error: String(e.message || e).slice(0, 200) }, 500);
  }
}
