// Ensure proxyFetch is loaded to patch globalThis.fetch
import "open-sse/index.js";

import { getProviderConnectionById } from "@/lib/localDb";
import { lingxiDailyCheckin } from "open-sse/services/lingxiCheckin.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";

/**
 * POST /api/usage/[connectionId]/lingxi-checkin
 *
 * Manual daily check-in for a Lingxi connection (每日灵点领取). Same protocol
 * as the auto scheduler (open-sse/services/lingxiCheckin.js): tasks-state gate
 * first, claim only when not yet checked in — never a blind POST.
 * Cookie priority = apiKey (capture/transfer-new) || accessToken (CD legacy).
 */
export async function POST(request, { params }) {
  try {
    const { connectionId } = await params;

    const connection = await getProviderConnectionById(connectionId);
    if (!connection) return Response.json({ error: "Connection not found" }, { status: 404 });
    if (connection.provider !== "lingxi") {
      return Response.json({ error: "Daily check-in is only available for Lingxi connections." }, { status: 400 });
    }

    const cookie = connection.apiKey || connection.accessToken;
    if (typeof cookie !== "string" || !cookie.trim()) {
      return Response.json({
        claimed: false,
        status: "failed",
        message: "当前连接没有 WPS 会话 Cookie —— 供应商页 → Capture Session 重新捕获。",
      });
    }

    const proxyConfig = await resolveConnectionProxyConfig(connection.providerSpecificData);
    const proxyOptions = {
      connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
      connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
      connectionNoProxy: proxyConfig.connectionNoProxy || "",
      vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
      strictProxy: false,
    };

    const result = await lingxiDailyCheckin({ cookie: cookie.trim(), proxyOptions });
    return Response.json({ claimed: result.status === "checked-in", ...result });
  } catch (error) {
    console.warn(`[Lingxi Checkin] ${error.message}`);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
