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
  getProviderConnectionById,
  createProviderConnection,
  updateProviderConnection,
} from "../../models/index.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { QODER_WEB_BASE, QODER_CN_WEB_BASE } from "open-sse/shared/qoder/constants.js";

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
 *
 * Generic fields (tokens/identity) plus `providerSpecificData` — the latter is
 * what carries platform-bound extras like Xiaomi MiMo's `mimoPassToken`
 * (Desktop session for Preview models) or provider-specific baseUrl overrides.
 * Without it, a cross-machine transfer (e.g. Windows → NAS) would silently lose
 * the session and Preview models would 403 on the target.
 */
export function buildExportAccounts(provider, connections, now = Date.now()) {
  const accounts = [];
  for (const c of connections || []) {
    // API-key compatible nodes (opencode-go etc.) hold the credential in
    // `apiKey`, OAuth rows in `accessToken` — export whichever holds the key,
    // tagged with authType so the import side lands it back in the right field.
    const token = c.accessToken || c.apiKey || null;
    if (!token) continue;
    const claims = decodeJwt(token) || {};
    let expiresAt = null;
    if (typeof claims.exp === "number" && claims.exp * 1000 > now) {
      expiresAt = new Date(claims.exp * 1000).toISOString();
    } else if (c.expiresAt) {
      expiresAt = c.expiresAt;
    }
    const psd = c.providerSpecificData && typeof c.providerSpecificData === "object"
      ? c.providerSpecificData
      : null;
    accounts.push({
      provider,
      authType: c.authType || null,
      name: c.name || claims.nickname || claims.preferred_username || null,
      email: c.email || claims.email || null,
      uid: claims.sub || null,
      accessToken: token,
      refreshToken: c.refreshToken || null,
      expiresAt,
      expiresIn: typeof c.expiresIn === "number" ? c.expiresIn : null,
      // Carried verbatim; the import side merges it into the connection row.
      ...(psd ? { providerSpecificData: psd } : {}),
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
      // Meoo control-key lines (CreditDaddy sync): the credential is the
      // account-level API key riding in providerSpecificData.meooControlKey —
      // there is no OAuth token to demand. Same shape the paste-key import
      // writes (authType "oauth" + psd.meooControlKey), so a CD-pushed row and
      // a pasted row are identical to every consumer (provider-routed test,
      // refresh-by-control-key, usage).
      const meooControlKey =
        provider === "meoo" && !accessToken
          ? String(item.providerSpecificData?.meooControlKey || "").trim()
          : "";
      if (!accessToken && !meooControlKey) {
        throw new Error("Missing accessToken");
      }

      const claims = accessToken ? decodeJwt(accessToken) : null;
      const nickname = item.name || item.nickname || claims?.nickname || claims?.preferred_username || null;
      const refreshToken = item.refreshToken || item.refresh_token || null;

      // A cloud-card row must not carry the Desktop account session (see
      // migration 005 and the card-gated writes in the oauth routes) — but a
      // transfer file exported from a pre-005 machine still has it folded into
      // its xiaomi-mimo psd. Drop it on import so re-importing an old file
      // cannot re-contaminate the card. The Desktop card keeps it: there the
      // session IS the credential.
      let itemPsd = item.providerSpecificData;
      if (provider === "xiaomi-mimo" && itemPsd && typeof itemPsd === "object") {
        itemPsd = { ...itemPsd };
        delete itemPsd.mimoPassToken;
        delete itemPsd.mimoUserId;
        delete itemPsd.mimoCUserId;
        if (itemPsd.authMethod === "desktop-session") delete itemPsd.authMethod;
      }

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

      // Dedup (issue #9 sibling: re-imports must never duplicate accounts).
      // Priority: JWT sub (strongest identity) → exact accessToken (same file
      // re-imported) → apiKey (api-key compatible nodes hold the credential
      // there, not in accessToken) → refreshToken → email → name.
      const sub = claims?.sub || null;
      let match = null;
      if (meooControlKey) {
        // Control-key identity: a row holding the same meoo_ak_ key IS the
        // same account — before any token/email fallback, which a key-less
        // row could otherwise satisfy via its name.
        match = existing.find((c) => c.providerSpecificData?.meooControlKey === meooControlKey) || null;
      } else if (sub) {
        match = existing.find((c) => decodeJwt(c.accessToken)?.sub === sub) || null;
      }
      if (!match) {
        match = existing.find((c) => c.accessToken === accessToken) || null;
      }
      if (!match) {
        match = existing.find((c) => c.apiKey && c.apiKey === accessToken) || null;
      }
      if (!match && refreshToken) {
        match = existing.find((c) => c.refreshToken && c.refreshToken === refreshToken) || null;
      }
      if (!match && item.email) {
        match = existing.find((c) => c.email && c.email === item.email) || null;
      }
      if (!match && nickname) {
        match = existing.find((c) => c.name === nickname) || null;
      }

      // API-key compatible nodes (opencode-go etc.) keep the credential in the
      // `apiKey` field — that is what the runtime reads for them. Write it
      // there IN ADDITION to accessToken (which stays for the identity/dedup
      // paths); OAuth rows keep the accessToken-only shape.
      const isApiKeyType = String(item.authType || "").toLowerCase() === "apikey";
      const payload = {
        provider,
        authType: item.authType || "oauth",
        ...(accessToken ? { accessToken } : {}),
        ...(isApiKeyType && accessToken ? { apiKey: accessToken } : {}),
        refreshToken,
        name: nickname || undefined,
        email: item.email || undefined,
        expiresAt: expiresAt || undefined,
        testStatus: "active",
        // Platform-bound extras (e.g. Xiaomi MiMo `mimoPassToken` for Preview
        // models). Merged over the existing row on update — never dropped.
        ...(itemPsd && typeof itemPsd === "object" ? { providerSpecificData: itemPsd } : {}),
      };

      if (match) {
        // updateProviderConnection replaces the whole providerSpecificData blob,
        // so merge it here or a re-import would wipe fields the file omitted.
        const merged = {
          ...payload,
          ...(payload.providerSpecificData || match.providerSpecificData
            ? {
                providerSpecificData: {
                  ...(match.providerSpecificData || {}),
                  ...(payload.providerSpecificData || {}),
                },
              }
            : {}),
        };
        await updateProviderConnection(match.id, merged);
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

  // Issue #44: on accounts whose openapi userQuota zeroes out, the synced
  // CreditDaddy web session is the ONLY source of the plan-credits row. A dead
  // session therefore means "订阅积分 disappears with no explanation" — surface
  // it in the import response instead of leaving it for the quota poll to fail
  // silently.
  const webSessionCheck = await checkQoderWebSessions(provider, results);

  return { imported, updated, skipped, failed, results, webSessions: webSessionCheck };
}

/**
 * Probe each freshly imported/updated Qoder connection's synced web session
 * against the console usage endpoint. Returns null when nothing was checked
 * (non-Qoder provider / no synced sessions) so the response stays clean.
 * Never throws: a probe failure downgrades the check to a warning, it must
 * not turn a successful import into an error.
 */
const WEB_SESSION_PROBE_TIMEOUT_MS = 10_000;
const WEB_SESSION_PROBE_CONCURRENCY = 6;

export async function checkQoderWebSessions(provider, results) {
  if (provider !== "qoder" && provider !== "qoder-cn") return null;
  const targets = [];
  for (const r of results) {
    if (!r?.ok || !r.id) continue;
    const conn = await getProviderConnectionById(r.id).catch(() => null);
    const session = conn?.providerSpecificData?.creditDaddyWebSession;
    if (!session || typeof session.cookie !== "string" || !session.cookie) continue;
    targets.push({
      id: r.id,
      name: conn.name || conn.email || r.id,
      provider: conn.provider || provider,
      cookie: session.cookie,
      // Same owner source the quota poll cross-checks against (psd.userId), so
      // the probe verdict matches what the dashboard will later decide.
      owner: conn.providerSpecificData?.userId || null,
    });
  }
  if (targets.length === 0) return null;

  const probe = async (t) => {
    try {
      const webBase = t.provider === "qoder-cn" ? QODER_CN_WEB_BASE : QODER_WEB_BASE;
      const res = await proxyAwareFetch(
        `${webBase}/api/v2/me/usages/big_model_credits`,
        {
          method: "GET",
          headers: {
            Cookie: t.cookie,
            Accept: "application/json",
            Referer: `${webBase}/account/usage`,
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          },
          signal: AbortSignal.timeout(WEB_SESSION_PROBE_TIMEOUT_MS),
        },
        null,
      );
      if (!res.ok) return { ...t, ok: false, reason: `HTTP ${res.status}` };
      const body = await res.json().catch(() => null);
      if (!body?.user_id) return { ...t, ok: false, reason: "bad response" };
      // Same owner cross-check the quota poll applies — a session that answers
      // for someone else is unusable here, not "ok".
      if (t.owner && String(body.user_id) !== String(t.owner)) {
        return { ...t, ok: false, reason: "session belongs to a different Qoder user" };
      }
      return { ...t, ok: true };
    } catch (e) {
      return { ...t, ok: false, reason: e?.message || "probe failed" };
    }
  };

  // Bounded concurrency: an import of many accounts must not fan out into an
  // unbounded burst against the web console.
  const checked = [];
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(WEB_SESSION_PROBE_CONCURRENCY, targets.length) },
    async () => {
      while (cursor < targets.length) {
        const t = targets[cursor++];
        checked.push(await probe(t));
      }
    },
  );
  await Promise.all(workers);

  const failures = checked.filter((c) => !c.ok);
  return {
    checked: checked.length,
    ok: checked.length - failures.length,
    failed: failures.length,
    failures: failures.map((f) => ({ id: f.id, name: f.name, reason: f.reason })),
  };
}
