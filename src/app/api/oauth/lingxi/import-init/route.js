import { issueImportToken } from "open-sse/shared/lingxi/capture.js";
import { ownerOf, json } from "../lib.js";

/**
 * POST /api/oauth/lingxi/import-init
 * Mint a one-time import token (ot, 10 min TTL) for the bookmarklet flow:
 * the dashboard session cookie is SameSite=Lax + httpOnly, so the cross-site
 * POST the bookmarklet fires from lingxi.kdocs.cn cannot carry it — the ot
 * proves an authenticated user opened the import dialog instead.
 */
export async function POST(request) {
  try {
    const dashboardCredential = request.cookies.get("auth_token")?.value || request.headers.get("authorization");
    if (!dashboardCredential) return json({ error: "Dashboard login required for bookmark import" }, 401);
    const connectionId = new URL(request.url).searchParams.get("connectionId") || null;
    const ot = issueImportToken(ownerOf(request), connectionId);
    return json({ ok: true, ot });
  } catch (e) {
    return json({ error: String(e.message || e).slice(0, 200) }, 500);
  }
}
