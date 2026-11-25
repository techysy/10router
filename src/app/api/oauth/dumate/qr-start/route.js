import { getProviderConnectionById } from "@/models";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { startSession, pub } from "open-sse/shared/dumate/qr.js";
import { ownerOf, json } from "../lib.js";

/**
 * POST /api/oauth/dumate/qr-start?connectionId=<id>
 * Begin a Baidu QR login session. Returns {sid, status}; the QR image itself is
 * delivered through qr-status as a data URI once Baidu has issued it.
 */
export async function POST(request) {
  try {
    const connectionId = new URL(request.url).searchParams.get("connectionId") || null;
    let proxyOptions = null;
    if (connectionId) {
      const conn = await getProviderConnectionById(connectionId);
      if (!conn) return json({ error: "Connection not found" }, 404);
      if (conn.provider !== "dumate") return json({ error: "Not a DuMate connection" }, 400);
      const p = await resolveConnectionProxyConfig(conn.providerSpecificData || {});
      proxyOptions = {
        connectionProxyEnabled: p.connectionProxyEnabled === true,
        connectionProxyUrl: p.connectionProxyUrl || "",
        connectionNoProxy: p.connectionNoProxy || "",
        vercelRelayUrl: p.vercelRelayUrl || "",
        strictProxy: p.strictProxy === true,
      };
    }
    const s = startSession({ connectionId, owner: ownerOf(request), proxyOptions });
    return json(pub(s));
  } catch (e) {
    return json({ error: String(e.message || e).slice(0, 200) }, 500);
  }
}
