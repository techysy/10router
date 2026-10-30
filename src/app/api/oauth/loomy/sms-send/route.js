import { NextResponse } from "next/server";
import { sendLoomySms } from "@/lib/oauth/providers/loomy";

export const dynamic = "force-dynamic";

// POST /api/oauth/loomy/sms-send — Loomy 手机直登第一步：下发验证码。
// 保护级别沿用 /api/oauth/*（PROTECTED_API_PATHS：JWT 会话或 requireLogin=false）。
export async function POST(request) {
  try {
    const { phone } = await request.json().catch(() => ({}));
    const r = await sendLoomySms(phone);
    return NextResponse.json({ success: true, ...r });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
