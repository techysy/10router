/*
 * Shared helpers for the DuMate QR-login / cookie-import routes.
 * Lives next to the routes (not in open-sse) because it touches the DB layer
 * and the dashboard test path — the open-sse side stays provider-runtime only.
 */

import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import {
  getProviderConnections,
  getProviderConnectionById,
  createProviderConnection,
  updateProviderConnection,
} from "@/models";
import { testSingleConnection } from "@/app/api/providers/[id]/test/testUtils.js";
import { finish, pub } from "open-sse/shared/dumate/qr.js";

/** Owner key for QR/import session scoping — hash of the dashboard credential. */
export function ownerOf(request) {
  const token = request.cookies.get("auth_token")?.value || request.headers.get("authorization") || "";
  return createHash("sha256").update(token).digest("hex");
}

export const json = (obj, status = 200, headers) =>
  NextResponse.json(obj, { status, headers: { "Cache-Control": "no-store", ...(headers || {}) } });

/**
 * Persist a fresh DuMate credential and prove it works end to end:
 *   dedup by generated name -> create or update -> testSingleConnection.
 * Returns {id, name, tokenExpiresAt}; throws with a user-facing message.
 */
export async function persistDumateCredential({ creds, connectionId, connName }) {
  let id = connectionId;
  if (!id && connName) {
    const list = await getProviderConnections({ provider: "dumate" });
    const hit = (list || []).find((c) => c.name === connName);
    if (hit) id = hit.id;
  }

  if (id) {
    const conn = await getProviderConnectionById(id);
    if (!conn || conn.provider !== "dumate") throw new Error("Target connection is not a DuMate connection");
    await updateProviderConnection(id, { apiKey: creds });
  } else {
    const conn = await createProviderConnection({
      provider: "dumate",
      authType: "cookie",
      name: connName || "DuMate 百度搭子（扫码）",
      apiKey: creds,
      priority: 1,
      testStatus: "unknown",
      isActive: true,
    });
    id = conn?.id;
    if (!id) throw new Error("Failed to create the provider connection");
  }

  const test = await testSingleConnection(id, {});
  if (!test.valid) throw new Error("Saved, but the connection test failed: " + (test.error || "unknown error"));

  const conn = await getProviderConnectionById(id);
  return {
    id,
    name: conn?.name || connName || null,
    tokenExpiresAt: conn?.expiresAt || conn?.earliestPackageExpiry || null,
  };
}

/**
 * After a QR session reaches "authorized" (s.creds holds the serialized
 * cookies), persist + test it, then finish the session. Idempotent — only the
 * first caller runs the save; later polls just observe the status.
 */
export async function persistQrSession(s) {
  if (!s.saving) {
    s.saving = (async () => {
      s.status = "saving";
      try {
        const r = await persistDumateCredential({ creds: s.creds, connectionId: s.connectionId, connName: s.connName });
        s.connectionId = r.id;
        s.connectionName = r.name;
        s.tokenExpiresAt = r.tokenExpiresAt;
        s.creds = null;
        finish(s, "success");
      } catch (e) {
        s.creds = null;
        finish(s, "error", String(e.message || e).slice(0, 240));
      }
    })();
  }
  await s.saving;
  return pub(s);
}
