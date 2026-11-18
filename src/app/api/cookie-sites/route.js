// 会话池 API（#150）：站点列表 + 槽位账号行。
//
// GET /api/cookie-sites —— 每站点 9 槽的账号行（面板会话池/选择器数据源）
//
// capture/clear 在子路由 [id]/route.js（壳 harvest 上报 / 面板清槽）。
// 鉴权：走 LOCAL_OR_AUTH（本机 CLI token / 会话），与 /api/version 同级。
import { NextResponse } from "next/server";
import { getProviderConnections } from "@/lib/db/index.js";
import { COOKIE_SITES, SESSION_POOL_SLOTS } from "./cookieSiteRegistry.js";

function slotOf(conn) {
  const n = Number(conn?.providerSpecificData?.cookieSlot);
  if (Number.isInteger(n) && n >= 1 && n <= SESSION_POOL_SLOTS) return n;
  // 老行（无 cookieSlot）= 槽 1
  return 1;
}

export async function GET() {
  const all = await getProviderConnections();
  const sites = COOKIE_SITES.map((site) => {
    const rows = all
      .filter((c) => c.provider === site.provider)
      .map((c) => ({
        id: c.id,
        name: c.name || site.name,
        email: c.email || null,
        slot: slotOf(c),
        capturedAt: c.updatedAt || c.createdAt || null,
        testStatus: c.testStatus || null,
        isActive: c.isActive !== false,
        psd: {
          accountKey: c.providerSpecificData?.[site.accountKey] || null,
        },
      }))
      .sort((a, b) => a.slot - b.slot);
    const latest = rows.reduce((t, r) => (r.capturedAt && (!t || r.capturedAt > t) ? r.capturedAt : t), null);
    return {
      id: site.id,
      name: site.name,
      loginUrl: site.loginUrl,
      provider: site.provider,
      slots: SESSION_POOL_SLOTS,
      accountId: rows[0]?.id || null,
      capturedAt: latest,
      accounts: rows,
    };
  });
  return NextResponse.json({ sites });
}
