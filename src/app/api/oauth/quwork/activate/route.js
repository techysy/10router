import { NextResponse } from "next/server";
import { smsRateLimit } from "@/lib/auth/smsRateLimiter";
import { loadQuworkAccountConnection, activateQuworkCode, quworkAccountErrorResponse } from "@/sse/services/quworkAccount.js";

export const dynamic = "force-dynamic";

// POST /api/oauth/quwork/activate {connectionId, code} — 填写邀请码/兑换码
// （/api/user/activate，device_identifier 与登录时一致）。需先绑定微信
// （QuWork 返回 wechat_bind_required）。限流 10 次/10 分钟/连接。
export async function POST(request) {
  try {
    const { connectionId, code } = await request.json().catch(() => ({}));
    const conn = await loadQuworkAccountConnection(connectionId);
    const rl = smsRateLimit(`quwork-activate:${conn.id}`, 10, 10 * 60 * 1000);
    if (!rl.ok) return NextResponse.json({ error: "尝试过于频繁，请稍后再试", retryAfter: rl.retryAfterSeconds }, { status: 429 });
    return NextResponse.json({ success: true, ...(await activateQuworkCode(conn, code)) });
  } catch (e) {
    const r = quworkAccountErrorResponse(e);
    return NextResponse.json(r.body, { status: r.status });
  }
}
