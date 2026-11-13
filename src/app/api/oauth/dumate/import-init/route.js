import { issueImportToken } from "open-sse/shared/dumate/qr.js";
import { ownerOf, json } from "../lib.js";

/**
 * POST /api/oauth/dumate/import-init
 * Mint a one-time import token (ot, 10 min TTL) for the bookmarklet flow:
 * the dashboard session cookie is SameSite=Lax + httpOnly, so the cross-site
 * POST the bookmarklet fires from *.baidu.com cannot carry it — the ot proves
 * an authenticated user opened the import dialog instead.
 */
export async function POST(request) {
  try {
    const ot = issueImportToken(ownerOf(request));
    return json({ ok: true, ot });
  } catch (e) {
    return json({ error: String(e.message || e).slice(0, 200) }, 500);
  }
}
