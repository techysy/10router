// OAuth-credentials account transfer (export shape + import with dedup/merge).
//
// Shared by the generic encrypted transfer routes (/api/oauth/transfer/*). The
// legacy /api/oauth/codebuddy-cn routes keep their wb-format behaviour and are
// intentionally NOT refactored onto this module (their issuer gate is part of
// the wb format's semantics).
//
// Generic identity matching for dedup, in priority order:
//   1. JWT `sub` (both tokens are JWTs signed by the same realm → same uid)
//   2. identical refreshToken (opaque tokens have no parseable identity)
//   3. identical connection name (weakest, last resort)
//
// Tokens are NEVER echoed back in import responses.

import {
  getProviderConnections,
  createProviderConnection,
  updateProviderConnection,
} from "../../models/index.js";

export function decodeJwt(jwt) {
  try {
    const seg = String(jwt).split(".")[1];
    const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(pad, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Extract the transferable account list from a provider's connections.
 * Generic fields only — provider-specific extras (cookies, passTokens) live
 * outside the connection row and are not transferred.
 */
export function buildExportAccounts(provider, connections, now = Date.now()) {
  const accounts = [];
  for (const c of connections || []) {
    if (!c.accessToken) continue;
    const claims = decodeJwt(c.accessToken) || {};
    let expiresAt = null;
    if (typeof claims.exp === "number" && claims.exp * 1000 > now) {
      expiresAt = new Date(claims.exp * 1000).toISOString();
    } else if (c.expiresAt) {
      expiresAt = c.expiresAt;
    }
    accounts.push({
      provider,
      name: c.name || claims.nickname || claims.preferred_username || null,
      email: c.email || claims.email || null,
      uid: claims.sub || null,
      accessToken: c.accessToken,
      refreshToken: c.refreshToken || null,
      expiresAt,
      expiresIn: typeof c.expiresIn === "number" ? c.expiresIn : null,
    });
  }
  return accounts;
}

/**
 * Import an accounts array into `provider`. Returns per-item results and the
 * { imported, updated, skipped, failed } summary. Serial on purpose — the
 * dedup list must stay fresh between items.
 */
export async function importAccounts(provider, accounts) {
  const existing = await getProviderConnections({ provider });

  const results = [];
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < accounts.length; i++) {
    const item = accounts[i];
    try {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error("Item is not an object");
      }
      const accessToken = item.accessToken || item.access_token;
      if (!accessToken || typeof accessToken !== "string") {
        throw new Error("Missing accessToken");
      }

      const claims = decodeJwt(accessToken);
      const nickname = item.name || item.nickname || claims?.nickname || claims?.preferred_username || null;
      const refreshToken = item.refreshToken || item.refresh_token || null;

      let expiresAt = null;
      if (claims && typeof claims.exp === "number" && claims.exp > 0) {
        expiresAt = new Date(claims.exp * 1000).toISOString();
      } else if (typeof item.expiresAt === "number") {
        expiresAt = new Date(item.expiresAt).toISOString();
      } else if (typeof item.expiresAt === "string" && !Number.isNaN(Date.parse(item.expiresAt))) {
        expiresAt = item.expiresAt;
      } else if (typeof item.expiresIn === "number" && item.expiresIn > 0 && item.expiresIn < 1e8) {
        expiresAt = new Date(Date.now() + item.expiresIn * 1000).toISOString();
      }

      // Dedup: JWT sub → refreshToken → name.
      const sub = claims?.sub || null;
      let match = null;
      if (sub) {
        match = existing.find((c) => decodeJwt(c.accessToken)?.sub === sub) || null;
      }
      if (!match && refreshToken) {
        match = existing.find((c) => c.refreshToken && c.refreshToken === refreshToken) || null;
      }
      if (!match && nickname) {
        match = existing.find((c) => c.name === nickname) || null;
      }

      const payload = {
        provider,
        authType: "oauth",
        accessToken,
        refreshToken,
        name: nickname || undefined,
        email: item.email || undefined,
        expiresAt: expiresAt || undefined,
        testStatus: "active",
      };

      if (match) {
        await updateProviderConnection(match.id, payload);
        updated++;
        results.push({ index: i, ok: true, updated: true, id: match.id });
      } else {
        const created = await createProviderConnection(payload);
        existing.push(created);
        imported++;
        results.push({ index: i, ok: true, created: true, id: created.id });
      }
    } catch (e) {
      results.push({ index: i, ok: false, error: e.message || "Unknown error" });
      failed++;
    }
  }

  return { imported, updated, skipped, failed, results };
}
