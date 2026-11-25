import { NextResponse } from "next/server";
import { getProviderConnectionById, updateSettings } from "@/lib/localDb";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy.js";
import {
  generateCroliInvite,
  readCroliCredits,
  runCroliCheckinTick,
  startCroliCheckin,
  stopCroliCheckin,
} from "@/sse/services/croliCheckin.js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function isCrossSite(request) {
  if (request.headers.get("sec-fetch-site") === "cross-site") return true;
  const origin = request.headers.get("origin");
  if (!origin) return false; // Non-browser callers are still gated by dashboard auth.
  try {
    const target = new URL(request.url);
    const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || target.host;
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

function errorResponse(error) {
  const status = Number(error?.status) || 502;
  return NextResponse.json(
    { error: String(error?.message || "Croli action failed"), code: error?.code || "croli_error" },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

async function croliConnection(connectionId) {
  const connection = connectionId ? await getProviderConnectionById(connectionId) : null;
  if (!connection || connection.provider !== "croli") {
    throw Object.assign(new Error("Croli account not found."), { status: 404, code: "connection_not_found" });
  }
  return connection;
}

export async function GET(request, { params }) {
  const { action } = await params;
  if (action !== "tasks") return NextResponse.json({ error: "Unknown Croli action" }, { status: 404 });
  try {
    const connectionId = new URL(request.url).searchParams.get("connectionId") || undefined;
    const data = await readCroliCredits({ connectionId });
    if (connectionId) {
      const row = (data.results || []).find((entry) => entry?.connectionId === connectionId);
      if (!row) throw Object.assign(new Error("Croli account not found."), { status: 404, code: "connection_not_found" });
      return NextResponse.json({ ...row, autoCheckin: data.autoCheckin }, { headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request, { params }) {
  if (isCrossSite(request)) return NextResponse.json({ error: "Cross-origin request rejected." }, { status: 403 });
  const { action } = await params;
  const body = await request.json().catch(() => ({}));
  try {
    if (action === "checkin") {
      const connection = await croliConnection(body?.connectionId);
      const proxyOptions = await resolveConnectionProxyConfig(connection.providerSpecificData || {});
      const results = await runCroliCheckinTick({
        skipIfCheckedToday: false,
        connectionId: connection.id,
        trigger: "manual",
        proxyOptions,
      });
      return NextResponse.json({ success: true, results }, { headers: { "Cache-Control": "no-store" } });
    }
    if (action === "invite-code") {
      const invite = await generateCroliInvite(body?.connectionId);
      return NextResponse.json(invite, { headers: { "Cache-Control": "no-store" } });
    }
    if (action === "auto-checkin") {
      if (typeof body?.enabled !== "boolean") {
        return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
      }
      await updateSettings({ croliCheckin: body.enabled });
      if (body.enabled) startCroliCheckin(); else stopCroliCheckin();
      return NextResponse.json({ success: true, enabled: body.enabled }, { headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ error: "Unknown Croli action" }, { status: 404 });
  } catch (error) {
    return errorResponse(error);
  }
}
