import { NextResponse } from "next/server";
import { verifyDashboardPassword } from "@/lib/auth/dashboardSession";

/**
 * POST /api/auth/verify-password
 * Lightweight dashboard-password check for UI flows that gate on it BEFORE
 * the real action (e.g. the OAuth transfer export confirm step) — so a wrong
 * password errors in the dialog where it was typed, not two steps later.
 * Same exposure class as /api/auth/login; the response leaks nothing but ok.
 */
export async function POST(request) {
  try {
    const { password } = await request.json();
    const ok = await verifyDashboardPassword(typeof password === "string" ? password : null);
    if (!ok) {
      return NextResponse.json({ ok: false, error: "Invalid password" }, { status: 401 });
    }
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request" }, { status: 400 });
  }
}
