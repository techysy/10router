import { takeImportToken, importCookies } from "open-sse/shared/dumate/qr.js";
import { portrait } from "open-sse/shared/dumate/session.js";
import { passportCookies, accountFrom } from "open-sse/shared/dumate/cookies.js";
import { persistDumateCredential, json } from "../lib.js";

/**
 * POST /api/oauth/dumate/import
 * Paste-cookie / bookmarklet login import.
 *
 * Body: JSON {connectionId?, cookies} or text/plain cookie header string.
 * Auth: either the normal dashboard session (same-origin paste path — the
 * guard verified it) or ?ot=<one-time token> for the cross-site bookmarklet
 * (dashboardGuard passes ot requests through; this route is the authorization).
 *
 * CORS: answers to *.baidu.com origins so the bookmarklet running on
 * passport.baidu.com can read the result.
 */

const CORS_OK = (o) =>
  /^https:\/\/([a-z0-9-]+\.)*baidu\.com$/i.test(String(o || "")) ||
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(String(o || ""));

const corsHeaders = (request) => {
  const origin = request.headers.get("origin");
  if (!CORS_OK(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
};

export async function OPTIONS(request) {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(request),
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}

export async function POST(request) {
  const cors = corsHeaders(request);
  try {
    const url = new URL(request.url);

    // ot path (bookmarklet): token is single-use — consuming it here also
    // prevents replays once the import below has run.
    const ot = url.searchParams.get("ot");
    if (ot && !takeImportToken(ot)) {
      return json({ error: "Login token expired or invalid — reopen the dialog for a fresh link" }, 401, cors);
    }

    const raw = await request.text();
    let body = {};
    try { body = JSON.parse(raw); } catch { /* text/plain cookie paste */ }
    const connectionId = body.connectionId || url.searchParams.get("connectionId") || null;
    const rawIn = String(body.cookies ?? body.apiKey ?? (/^\s*\{/.test(raw) ? "" : raw));

    const { creds, account } = await importCookies(rawIn);

    // Account name for the connection label / same-account dedup: path 2
    // returns it from quick-login; path 1 resolves it via portrait.
    let acct = account;
    if (!acct) {
      try { acct = (await portrait(passportCookies(rawIn)))?.username || accountFrom(creds); } catch { /* cosmetic */ }
    }

    const r = await persistDumateCredential({
      creds,
      connectionId,
      connName: connectionId ? undefined : `DuMate 百度搭子（${acct || "导入"}）`,
    });
    return json({ ok: true, connectionId: r.id, connectionName: r.name, tokenExpiresAt: r.tokenExpiresAt }, 200, cors);
  } catch (e) {
    return json({ ok: false, error: String(e.message || e).slice(0, 240) }, 400, cors);
  }
}
