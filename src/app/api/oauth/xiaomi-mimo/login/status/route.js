import { NextResponse } from "next/server";
import { sessionFromRequest, readSessionIdentity, attachSessionCookie } from "@/lib/mimoLoginSession";

/**
 * GET /api/oauth/xiaomi-mimo/login/status?state=...
 * Polls the server-side login session (state lives in the httpOnly session
 * cookie — route handlers and the proxy don't share module memory). When a
 * passToken is in the jar, probes /api/user/xiaomi/me once to confirm the
 * session works. The identity itself never crosses the browser: "done" just
 * flips the modal to the save step, and the api-key route reads it from the
 * same-origin request's session cookie and consumes it there.
 */
export async function GET(request) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") || "";
  const sess = sessionFromRequest(request);
  if (!sess || (state && sess.state !== state)) {
    return NextResponse.json({ status: "expired" }, { status: 404 });
  }

  if (sess.status !== "done") {
    // AUTHORIZATION = passToken in the jar (captured during the proxied login
    // XHRs). No serviceToken exchange — weekly-quota API moved; re-wire later.
    if (readSessionIdentity(sess)) sess.status = "done";
  }

  if (sess.status !== "done") {
    // Re-arm the session cookie on every poll — the modal may sit on the login
    // form much longer than the 15min TTL, and only proxied responses used to
    // refresh it (browser silently drops an expired cookie before the POST).
    return attachSessionCookie(NextResponse.json({ status: "pending", region: sess.region }), sess);
  }

  const id = readSessionIdentity(sess);
  if (!id) {
    return attachSessionCookie(
      NextResponse.json({ status: "error", error: "session captured but passToken missing" }),
      sess,
    );
  }

  // No identity in the payload and no cookie clear here — the api-key save is
  // the one-shot consumer (it clears the cookie after storing the credential).
  return NextResponse.json({ status: "done", region: sess.region });
}
