import { NextResponse } from "next/server";

// POST /api/oauth/meoo/refresh-ak — re-resolve the project service AK for
// Meoo connections (all of them, or one via { connectionId }).
//
// This is the manual counterpart to the automatic re-resolution wired
// into token refresh and the model catalog: it covers the first-run
// states where login succeeded but no AK could be issued yet (no project,
// or cloud services not enabled for the project). Once the user creates a
// project / enables cloud services in Meoo, this picks the AK up without
// a re-login. The AK itself is never returned — only its status.
export async function POST(request) {
  try {
    let body = {};
    try {
      body = await request.json();
    } catch {
      // Zero-body call = re-resolve for every Meoo connection.
    }

    const { getProviderConnections, getProviderConnectionById } = await import("@/models");
    const { refreshMeooToken } = await import("open-sse/services/tokenRefresh.js");
    const { updateProviderCredentials } = await import("@/sse/services/tokenRefresh");

    let connections;
    if (body?.connectionId) {
      const conn = await getProviderConnectionById(body.connectionId);
      if (!conn || conn.provider !== "meoo") {
        return NextResponse.json({ error: "Meoo connection not found" }, { status: 404 });
      }
      connections = [conn];
    } else {
      connections = await getProviderConnections({ provider: "meoo" });
    }

    const results = [];
    for (const conn of connections) {
      // Paste-key connections have no OAuth pair — their AK re-resolution
      // runs on the stored control key instead (refreshMeooToken handles
      // both credential shapes).
      if (!conn.refreshToken && !conn.accessToken && !conn.providerSpecificData?.meooControlKey) {
        results.push({ id: conn.id, ok: false, error: "Connection has no refresh token or control API key; re-connect required" });
        continue;
      }
      const refreshed = await refreshMeooToken(conn.refreshToken || "", conn, console);
      if (!refreshed || refreshed.error) {
        results.push({ id: conn.id, ok: false, error: refreshed?.error || "refresh_failed" });
        continue;
      }
      await updateProviderCredentials(conn.id, {
        ...refreshed,
        existingProviderSpecificData: conn.providerSpecificData || {},
        ...(refreshed.apiKey ? { testStatus: "active" } : {}),
      });
      const psd = refreshed.providerSpecificData || {};
      results.push({
        id: conn.id,
        ok: !!refreshed.apiKey,
        projectUrlId: psd.projectUrlId || conn.providerSpecificData?.projectUrlId || "",
        akStatus: psd.akStatus || (refreshed.apiKey ? "ok" : "unknown"),
        ...(psd.akError ? { error: psd.akError } : {}),
      });
    }

    return NextResponse.json({ success: true, results });
  } catch (error) {
    console.log("Meoo refresh-ak error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
