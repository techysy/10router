import { NextResponse } from "next/server";
import { loadQuworkAccountConnection, getQuworkAccountInfo, quworkAccountErrorResponse } from "@/sse/services/quworkAccount.js";

export const dynamic = "force-dynamic";

// GET /api/oauth/quwork/account?connectionId= — 微信绑定状态 / 我的邀请码 / 邀请人
// （/api/user/self，只读；经连接代理）。
export async function GET(request) {
  try {
    const connectionId = new URL(request.url).searchParams.get("connectionId");
    const conn = await loadQuworkAccountConnection(connectionId);
    return NextResponse.json({ success: true, account: await getQuworkAccountInfo(conn) });
  } catch (e) {
    const r = quworkAccountErrorResponse(e);
    return NextResponse.json(r.body, { status: r.status });
  }
}
