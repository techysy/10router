import { NextResponse } from "next/server";
import { loadQuworkAccountConnection, createQuworkWechatQr, quworkAccountErrorResponse } from "@/sse/services/quworkAccount.js";

export const dynamic = "force-dynamic";

// POST /api/oauth/quwork/wechat-qr {connectionId} — 生成微信扫码链接（不访问 QuWork）。
// 扫码后浏览器落在 llm.rrzu.com/oauth/wechat?code=..，由用户把该地址粘到 wechat-bind。
export async function POST(request) {
  try {
    const { connectionId } = await request.json().catch(() => ({}));
    const conn = await loadQuworkAccountConnection(connectionId);
    return NextResponse.json({ success: true, ...(await createQuworkWechatQr(conn)) });
  } catch (e) {
    const r = quworkAccountErrorResponse(e);
    return NextResponse.json(r.body, { status: r.status });
  }
}
