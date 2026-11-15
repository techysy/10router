import { takeImportToken, looksLikeLingxiCookie, normalizeCaptureCookie, lingxiUidFromCookie } from "open-sse/shared/lingxi/capture.js";
import { persistLingxiCredential, json } from "../lib.js";

/**
 * POST /api/oauth/lingxi/import
 * Paste-cookie / bookmarklet session capture for WPS 灵犀.
 *
 * Body: JSON {connectionId?, cookies} or text/plain cookie header string.
 * Auth: either the normal dashboard session (same-origin paste path) or
 * ?ot=<one-time token> for the cross-site bookmarklet (dashboardGuard passes
 * ot requests through; this route is the real authorization — it consumes the
 * single-use token).
 *
 * CORS: answers to lingxi.kdocs.cn / *.kdocs.cn origins so the bookmarklet
 * running on the lingxi web app can read the result.
 */

const CORS_OK = (o) =>
  /^https:\/\/([a-z0-9-]+\.)*kdocs\.cn$/i.test(String(o || "")) ||
  /^https:\/\/([a-z0-9-]+\.)*wps\.cn$/i.test(String(o || "")) ||
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

    const raw = await request.text();
    let body = {};
    try { body = JSON.parse(raw); } catch { /* text/plain cookie paste */ }
    const connectionId = body.connectionId || url.searchParams.get("connectionId") || null;

    // ot path (bookmarklet): token is single-use — consuming it here also
    // prevents replays once the import has run.
    const ot = url.searchParams.get("ot");
    if (ot && !takeImportToken(ot, connectionId)) {
      return json({ error: "Login token expired or invalid — reopen the dialog for a fresh link" }, 401, cors);
    }

    const rawIn = String(body.cookies ?? body.apiKey ?? (/^\s*\{/.test(raw) ? "" : raw));

    if (!looksLikeLingxiCookie(rawIn)) {
      return json(
        { ok: false, error: "没解析到灵犀会话 Cookie（需要 wps_sid）。请在已登录 lingxi.kdocs.cn 的页面里捕获，或确认粘贴的是完整 Cookie 头。" },
        400,
        cors,
      );
    }
    const cookieHeader = normalizeCaptureCookie(rawIn);
    if (!cookieHeader) {
      return json({ ok: false, error: "Cookie 解析失败——请粘贴 document.cookie 的完整输出或 Cookie-Editor 导出的 JSON" }, 400, cors);
    }

    const r = await persistLingxiCredential({ cookieHeader, connectionId });
    return json(
      {
        ok: true,
        connectionId: r.id,
        connectionName: r.name,
        uid: lingxiUidFromCookie(cookieHeader) || null,
      },
      200,
      cors,
    );
  } catch (e) {
    return json({ ok: false, error: String(e.message || e).slice(0, 240) }, 400, cors);
  }
}
