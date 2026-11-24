import { NextResponse } from "next/server";
import { createProviderConnection, getProviderConnections, updateProviderConnection } from "@/lib/db/index.js";
import {
  createOrcaTermLoginSession,
  completeOrcaTermLoginSession,
  cancelOrcaTermLoginSession,
} from "@/lib/oauth/orcatermSessions.js";
import { ORCATERM_CONFIG } from "open-sse/config/orcaterm.js";
import { OrcaTermError } from "open-sse/shared/orcaterm/auth.js";

export const dynamic = "force-dynamic";

function json(body, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request, { params }) {
  try {
    const { action } = await params;
    if (!["authorize", "exchange", "cancel"].includes(action)) return json({ error: "Unknown action" }, 400);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return json({ error: "JSON request required" }, 415);
    }
    if (request.headers.get("sec-fetch-site") === "cross-site") {
      return json({ error: "Cross-site sign-in requests are not allowed" }, 403);
    }
    const contentLength = request.headers.get("content-length");
    if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > ORCATERM_CONFIG.loginBodyMaxBytes)) {
      return json({ error: "Request too large" }, 413);
    }
    const reader = request.body?.getReader();
    const chunks = [];
    let byteLength = 0;
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          byteLength += value.byteLength;
          if (byteLength > ORCATERM_CONFIG.loginBodyMaxBytes) {
            await reader.cancel();
            return json({ error: "Request too large" }, 413);
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const text = new TextDecoder().decode(bytes);
    let body;
    try { body = JSON.parse(text); } catch { return json({ error: "Invalid JSON" }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Invalid request" }, 400);

    if (action === "authorize") return json(await createOrcaTermLoginSession(request));
    if (typeof body.sessionId !== "string") return json({ error: "Missing sign-in session" }, 400);
    if (action === "cancel") {
      cancelOrcaTermLoginSession(body.sessionId);
      return json({ success: true });
    }

    const tokens = await completeOrcaTermLoginSession(body);
    const existing = (await getProviderConnections({ provider: "orcaterm" })).find(
      (connection) => connection.authType === "oauth" && connection.providerSpecificData?.userId === tokens.userId,
    );
    const data = {
      authType: "oauth",
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: new Date(Date.now() + tokens.expiresIn * 1000).toISOString(),
      displayName: tokens.displayName || `OrcaTerm ${tokens.userId}`,
      providerSpecificData: { ...existing?.providerSpecificData, userId: tokens.userId, loginMethod: "wechat" },
      isActive: true,
      testStatus: "unknown",
      lastError: null,
    };
    const connection = existing
      ? await updateProviderConnection(existing.id, { ...data, resetErrorState: true })
      : await createProviderConnection({ provider: "orcaterm", name: data.displayName, ...data });
    // Credentials never travel back to the dashboard.
    return json({ success: true, connection: { id: connection.id, provider: "orcaterm", name: connection.name } });
  } catch (error) {
    return json({
      error: error instanceof OrcaTermError ? error.message : "OrcaTerm sign-in could not be completed",
    }, error instanceof OrcaTermError ? error.status : 502);
  }
}
