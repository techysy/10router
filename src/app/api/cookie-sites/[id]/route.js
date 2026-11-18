// 会话池站点 API（#150）：单站点的 capture（壳收割上报）与 clear（面板清槽）。
//
// POST /api/cookie-sites/:id       —— 壳收割上报：body {slot, cookie}；cookie 落连接 apiKey + psd.cookieSlot
// DELETE /api/cookie-sites/:id?slot=N —— 面板清除某槽（删该槽连接行）
//
// 鉴权：走 LOCAL_OR_AUTH（本机 CLI token / 会话）；capture 额外接受
// x-10r-cli-token（壳上报，本机同 DATA_DIR 派生 token，guard 已验真伪）。
import { NextResponse } from "next/server";
import { getProviderConnections, updateProviderConnection, deleteProviderConnection } from "@/lib/db/index.js";
import { getCookieSite, SESSION_POOL_SLOTS } from "../cookieSiteRegistry.js";

// capture 的授权 = 本机 CLI token（壳上报）。guard 已验过 token 真伪，此处只判存在。
function authorized(request) {
  const token = request.headers.get("x-10r-cli-token") || request.headers.get("x-9r-cli-token") || "";
  return Boolean(token);
}

function slotOf(conn) {
  const n = Number(conn?.providerSpecificData?.cookieSlot);
  if (Number.isInteger(n) && n >= 1 && n <= SESSION_POOL_SLOTS) return n;
  // 老行（无 cookieSlot）= 槽 1
  return 1;
}

export async function POST(request, { params }) {
  const { id } = await params;
  const site = getCookieSite(id);
  if (!site) return NextResponse.json({ error: `未知站点 ${id}` }, { status: 404 });
  const body = await request.json().catch(() => ({}));
  const slot = Math.min(Math.max(Number(body?.slot) || 1, 1), SESSION_POOL_SLOTS);
  const cookie = String(body?.cookie || "").trim();
  if (!cookie) return NextResponse.json({ error: "cookie 不能为空" }, { status: 400 });
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const all = await getProviderConnections({ provider: site.provider });
  // 归户：同站点 + 同槽 + 同账号键 → 更新；否则新建一行（异槽 = 分行）。
  let accountKeyValue = null;
  if (site.provider === "lingxi") {
    try {
      const { lingxiAccountKey } = await import("open-sse/shared/lingxi/capture.js");
      accountKeyValue = lingxiAccountKey(cookie);
    } catch { /* 归户键可选 */ }
  }

  const sameSlot = all.filter((c) => slotOf(c) === slot);
  const match = sameSlot.find((c) => {
    if (accountKeyValue && c.providerSpecificData?.[site.accountKey] === accountKeyValue) return true;
    // 无归户键可用时：同槽内 apiKey 相同视为同一账号
    return c.apiKey && c.apiKey === cookie;
  }) || sameSlot[0] || null;

  const basePsd = match?.providerSpecificData || {};
  const nextPsd = { ...basePsd, cookieSlot: slot };
  if (accountKeyValue) nextPsd[site.accountKey] = accountKeyValue;

  if (match) {
    await updateProviderConnection(match.id, { apiKey: cookie, providerSpecificData: nextPsd, testStatus: "unknown" });
    return NextResponse.json({ ok: true, updated: true, id: match.id, slot });
  }
  const { createProviderConnection } = await import("@/lib/db/index.js");
  const conn = await createProviderConnection({
    provider: site.provider,
    authType: "cookie",
    name: `${site.name} ${slot}`,
    apiKey: cookie,
    priority: 1,
    isActive: true,
    testStatus: "unknown",
    providerSpecificData: nextPsd,
  });
  return NextResponse.json({ ok: true, created: true, id: conn.id, slot }, { status: 201 });
}

export async function DELETE(request, { params }) {
  const { id } = await params;
  const site = getCookieSite(id);
  if (!site) return NextResponse.json({ error: `未知站点 ${id}` }, { status: 404 });
  const slot = Math.min(Math.max(Number(new URL(request.url).searchParams.get("slot")) || 1, 1), SESSION_POOL_SLOTS);
  const all = await getProviderConnections({ provider: site.provider });
  const row = all.find((c) => slotOf(c) === slot);
  if (!row) return NextResponse.json({ ok: true, deleted: false, slot });
  await deleteProviderConnection(row.id);
  return NextResponse.json({ ok: true, deleted: true, id: row.id, slot });
}
