import { NextResponse } from "next/server";
import { smsRateLimit } from "@/lib/auth/smsRateLimiter";
import { loadQuworkAccountConnection, bindQuworkWechat, quworkAccountErrorResponse } from "@/sse/services/quworkAccount.js";

export const dynamic = "force-dynamic";

// POST /api/oauth/quwork/wechat-bind {connectionId, callback} — callback = 扫码后跳转的
// 完整地址（或裸 code）。code → /api/oauth/wechat（need_bind 才有 wechat_token）→
// /api/user/wechat/bind。该微信已归属其他账号时报错，不绑定。限流 10 次/10 分钟/连接。
export async function POST(request) {
  try {
    const { connectionId, callback } = await request.json().catch(() => ({}));
    const conn = await loadQuworkAccountConnection(connectionId);
    const rl = smsRateLimit(`quwork-wechat-bind:${conn.id}`, 10, 10 * 60 * 1000);
    if (!rl.ok) return NextResponse.json({ error: "尝试过于频繁，请稍后再试", retryAfter: rl.retryAfterSeconds }, { status: 429 });
    return NextResponse.json({ success: true, ...(await bindQuworkWechat(conn, callback)) });
  } catch (e) {
    const r = quworkAccountErrorResponse(e);
    return NextResponse.json(r.body, { status: r.status });
  }
}
