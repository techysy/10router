import { NextResponse } from "next/server";
import { setDashboardAuthCookie, verifyDashboardPassword } from "@/lib/auth/dashboardSession";
import { checkLock, recordFail, recordSuccess, getClientIp } from "@/lib/auth/loginLimiter";
import { cookies } from "next/headers";

// Progressive lockout lives in loginLimiter (in-memory, resets on restart) —
// the same limiter the SAML acs route uses. getClientIp trusts x-9r-real-ip
// only when custom-server.js stamped it, so remote clients cannot rotate
// their own bucket.
export async function POST(request) {
  const ip = getClientIp(request);

  const lock = checkLock(ip);
  if (lock.locked) {
    return NextResponse.json(
      { error: `Too many failed attempts. Try again in ${lock.retryAfter}s.` },
      { status: 429, headers: { "Retry-After": String(lock.retryAfter) } },
    );
  }

  try {
    const { password } = await request.json();
    const isValid = await verifyDashboardPassword(password);

    if (isValid) {
      recordSuccess(ip);
      const cookieStore = await cookies();
      await setDashboardAuthCookie(cookieStore, request);
      return NextResponse.json({ success: true });
    }

    recordFail(ip);
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  } catch (error) {
    recordFail(ip);
    // Never echo internal error details to the client — log server-side only.
    console.error("[auth] login failed:", error);
    return NextResponse.json({ error: "Login failed. Check server logs." }, { status: 500 });
  }
}
