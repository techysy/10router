// 会话池 API（#150）：站点列表 + 槽位账号行。
//
// GET  /api/cookie-sites            —— 每站点 9 槽的账号行（面板会话池/选择器数据源）
// POST /api/cookie-sites/:id/capture —— 壳收割上报：cookie 落连接 apiKey + psd.cookieSlot
// POST /api/cookie-sites/:id/clear   —— 面板清除某槽（删该槽连接行）
//
// 鉴权：走 LOCAL_OR_AUTH（本机 CLI token / 会话），与 /api/version 同级；
// capture 额外接受 x-10r-cli-token（壳上报，本机同 DATA_DIR 派生）。
import { NextResponse } from "next/server";
import { getProviderConnections, updateProviderConnection, deleteProviderConnection } from "@/lib/db/index.js";
import { COOKIE_SITES, getCookieSite, SESSION_POOL_SLOTS } from "./cookieSiteRegistry.js";

// capture 的授权 = 本机 CLI token（壳上报，与 /api/version 同级信任）。
// 面板/书签签路径带仪表盘会话，由 guard 的 LOCAL_OR_AUTH 分支放行；两者之外 401。
function authorized(request) {
  const token = request.headers.get("x-10r-cli-token") || request.headers.get("x-9r-cli-token") || "";
  return Boolean(token); // guard 已验过 CLI token 真伪（LOCAL_OR_AUTH 分支），此处只判存在
}

function slotOf(conn, site) {
  const psd = conn?.providerSpecificData || {};
  const raw = psd.cookieSlot;
  const n = Number(raw);
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
        slot: slotOf(c, site),
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

export async function POST(request, { params }) {
  const { id } = await params;
  const site = getCookieSite(id);
  if (!site) return NextResponse.json({ error: `未知站点 ${id}` }, { status: 404 });
  const body = await request.json().catch(() => ({}));
  const slot = Math.min(Math.max(Number(body?.slot) || 1, 1), SESSION_POOL_SLOTS);
  const cookie = String(body?.cookie || '').trim();
  if (!cookie) return NextResponse.json({ error: 'cookie 不能为空' }, { status: 400 });
  if (!authorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const all = await getProviderConnections({ provider: site.provider });
  // 归户：同站点 + 同槽 + 同账号键 → 更新；否则新建一行（异槽 = 分行）。
  let accountKeyValue = null;
  if (site.provider === 'lingxi') {
    try {
      const { lingxiAccountKey } = await import('open-sse/shared/lingxi/capture.js');
      accountKeyValue = lingxiAccountKey(cookie);
    } catch { /* 归户键可选 */ }
  }

  const sameSlot = all.filter((c) => slotOf(c, site) === slot);
  const match = sameSlot.find((c) => {
    if (accountKeyValue && c.providerSpecificData?.[site.accountKey] === accountKeyValue) return true;
    // 无归户键可用时：同槽内 apiKey 相同视为同一账号
    return c.apiKey && c.apiKey === cookie;
  }) || sameSlot[0] || null;

  const basePsd = match?.providerSpecificData || {};
  const nextPsd = { ...basePsd, cookieSlot: slot };
  if (accountKeyValue) nextPsd[site.accountKey] = accountKeyValue;

  if (match) {
    await updateProviderConnection(match.id, { apiKey: cookie, providerSpecificData: nextPsd, testStatus: 'unknown' });
    return NextResponse.json({ ok: true, updated: true, id: match.id, slot });
  }
  const { createProviderConnection } = await import('@/lib/db/index.js');
  const conn = await createProviderConnection({
    provider: site.provider,
    authType: 'cookie',
    name: `${site.name} ${slot}`,
    apiKey: cookie,
    priority: 1,
    isActive: true,
    testStatus: 'unknown',
    providerSpecificData: nextPsd,
  });
  return NextResponse.json({ ok: true, created: true, id: conn.id, slot }, { status: 201 });
}

export async function DELETE(request, { params }) {
  const { id } = await params;
  const site = getCookieSite(id);
  if (!site) return NextResponse.json({ error: `未知站点 ${id}` }, { status: 404 });
  const slot = Math.min(Math.max(Number(new URL(request.url).searchParams.get('slot')) || 1, 1), SESSION_POOL_SLOTS);
  const all = await getProviderConnections({ provider: site.provider });
  const row = all.find((c) => slotOf(c, site) === slot);
  if (!row) return NextResponse.json({ ok: true, deleted: false, slot });
  await deleteProviderConnection(row.id);
  return NextResponse.json({ ok: true, deleted: true, id: row.id, slot });
}
