/**
 * External quota push interface — the generic display-only counterpart of the
 * read-only `GET /api/usage/quotas` feed. An external companion app (e.g.
 * CreditDaddy) parses a provider's quota on its own side and POSTs the NUMBERS
 * here; 10Router renders them as cards on the unified quota page.
 *
 * Trust model: the push payload carries quota SCALARS and nothing else. There is
 * no code path here that touches credentials — normalization enforces it:
 * unknown fields are dropped (whitelist) and non-scalar values are rejected
 * outright, so cookie/token material can never ride in on a quota field or get
 * persisted into the snapshot. Snapshots live in `_meta` under
 * `externalQuota.<source>` and expire (TTL) so a pusher that goes silent stops
 * painting stale cards.
 *
 * Synthetic rows never enter the `providers` table — they are built at read time
 * and merged into /api/providers/client after eligibility filtering. Nothing in
 * the routing engine may consume them: `authType: "external"` rows have no
 * credential to route with, and combo/account selection only ever looks at real
 * connections.
 */

import { getMeta, setMeta, deleteMeta, listMetaByPrefix } from "./db/helpers/metaStore.js";

export const EXTERNAL_QUOTA_META_PREFIX = "externalQuota.";
// A source that stops pushing disappears from the quota page a week after its
// last snapshot. 7 days comfortably outlasts a laptop-asleep weekend while
// never showing "live" numbers older than a week.
export const EXTERNAL_QUOTA_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const EXTERNAL_QUOTA_MAX_SNAPSHOT_BYTES = 60_000;
export const EXTERNAL_QUOTA_MAX_ENTRIES = 20;

const SOURCE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
// provider is display-only on these cards (icon path + registry website lookup),
// but it feeds `/providers/${provider}.png` and className-ish uses, so keep it
// to a conservative slug grammar.
const PROVIDER_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const QUOTA_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9 ._@-]{0,63}$/;

// Whitelisted quota-row fields, with the coercion each one gets. Unknown keys
// are dropped; anything not scalar is rejected (see normalizeQuotaEntry).
const QUOTA_ROW_FIELDS = {
  used: "number",            // >= 0, defaults to 0
  total: "positiveNumber",   // > 0, optional
  resetAt: "shortString",    // <= 64 chars (renderer parses it as a date)
  remainingPercentage: "number",
  percentScale: "positiveNumber",
  unlimited: "boolean",
  recurring: "boolean",
  displayRemaining: "boolean",
  giftPack: "boolean",
  name: "shortString",       // explicit display name, <= 80 chars
};

const isScalar = (v) =>
  v === null || ["string", "number", "boolean"].includes(typeof v);

function coerceField(kind, value) {
  switch (kind) {
    case "number":
      return Number.isFinite(value) && value >= 0 ? value : undefined;
    case "positiveNumber":
      return Number.isFinite(value) && value > 0 ? value : undefined;
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
    case "shortString":
      if (typeof value !== "string") return undefined;
      const s = value.trim();
      return s && s.length <= 80 ? s : undefined;
    default:
      return undefined;
  }
}

function clipString(value, max) {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!s) return null;
  return s.length <= max ? s : s.slice(0, max);
}

export function isValidExternalQuotaSource(source) {
  return typeof source === "string" && SOURCE_RE.test(source);
}

/**
 * Validate + normalize a push body for `source`. Returns
 * `{ ok: true, snapshot }` or `{ ok: false, error }` (the error doubles as the
 * 400 body message, so keep it actionable for the pushing app).
 */
export function normalizeExternalQuotaPayload(source, body) {
  if (!isValidExternalQuotaSource(source)) {
    return { ok: false, error: "invalid source: use ^[a-z0-9][a-z0-9-]{0,31}$" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "body must be a JSON object" };
  }

  const provider = body.provider === undefined ? source : body.provider;
  if (typeof provider !== "string" || !PROVIDER_RE.test(provider)) {
    return { ok: false, error: "provider must match ^[a-z0-9][a-z0-9._-]{0,63}$" };
  }

  const serialized = JSON.stringify(body);
  if (serialized.length > EXTERNAL_QUOTA_MAX_SNAPSHOT_BYTES) {
    return { ok: false, error: `payload exceeds ${EXTERNAL_QUOTA_MAX_SNAPSHOT_BYTES} bytes` };
  }

  const message = clipString(body.message, 500);

  let entries = [];
  if (body.quotas !== undefined && body.quotas !== null) {
    if (typeof body.quotas !== "object" || Array.isArray(body.quotas)) {
      return { ok: false, error: "quotas must be a map of {key: {fields}}" };
    }
    const keys = Object.keys(body.quotas);
    if (keys.length > EXTERNAL_QUOTA_MAX_ENTRIES) {
      return { ok: false, error: `quotas has more than ${EXTERNAL_QUOTA_MAX_ENTRIES} entries` };
    }
    for (const key of keys) {
      if (!QUOTA_KEY_RE.test(key)) {
        return { ok: false, error: `quota key "${key.slice(0, 24)}" is not a safe label` };
      }
      const raw = body.quotas[key];
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return { ok: false, error: `quota "${key}" must be an object of scalar fields` };
      }
      for (const [field, value] of Object.entries(raw)) {
        if (!isScalar(value)) {
          // The one hard rule of this endpoint: quota values are scalars. A
          // nested object/array is never quota data — refuse rather than
          // silently strip, so a mis-wired pusher fails loudly at the seam.
          // Checked BEFORE the whitelist: an unknown field carrying structured
          // material (a cookie jar tucked into `cookie:{…}`) must be rejected
          // outright, not quietly dropped — the drop path only ever sheds
          // scalar junk.
          return { ok: false, error: `quota "${key}.${field}" must be a scalar (this endpoint stores no structured data)` };
        }
        // Known fields are coerced below; unknown SCALAR fields are dropped.
      }
      const entry = { key };
      for (const [field, kind] of Object.entries(QUOTA_ROW_FIELDS)) {
        if (raw[field] === undefined) continue;
        const coerced = coerceField(kind, raw[field]);
        if (coerced !== undefined) entry[field] = coerced;
      }
      entry.name = entry.name || key;
      entries.push(entry);
    }
  }

  if (entries.length === 0 && !message) {
    return { ok: false, error: "payload needs a non-empty quotas map or a message" };
  }

  let pushedAt = new Date().toISOString();
  if (body.pushedAt !== undefined) {
    const t = typeof body.pushedAt === "number" ? body.pushedAt : Date.parse(String(body.pushedAt));
    if (Number.isFinite(t)) {
      // Clamp wild future timestamps (clock skew must not extend the TTL); a
      // stale pushedAt is the pusher's responsibility (push cadence < TTL).
      pushedAt = new Date(Math.min(t, Date.now() + 60 * 60 * 1000)).toISOString();
    }
  }

  return {
    ok: true,
    snapshot: {
      source,
      provider,
      label: clipString(body.label, 100),
      plan: clipString(body.plan, 100),
      message,
      pushedAt,
      entries,
    },
  };
}

export async function saveExternalQuotaSnapshot(snapshot) {
  // Carry firstSeenAt across re-pushes so the card keeps a stable created date.
  const existing = await getMeta(`${EXTERNAL_QUOTA_META_PREFIX}${snapshot.source}`).catch(() => null);
  let firstSeenAt = snapshot.pushedAt;
  if (existing) {
    try {
      const parsed = JSON.parse(existing);
      if (typeof parsed?.firstSeenAt === "string") firstSeenAt = parsed.firstSeenAt;
    } catch { /* corrupt prior value — start fresh */ }
  }
  await setMeta(
    `${EXTERNAL_QUOTA_META_PREFIX}${snapshot.source}`,
    JSON.stringify({ ...snapshot, firstSeenAt }),
  );
}

export async function deleteExternalQuotaSnapshot(source) {
  if (!isValidExternalQuotaSource(source)) return false;
  const key = `${EXTERNAL_QUOTA_META_PREFIX}${source}`;
  const existed = await getMeta(key);
  if (existed === null || existed === undefined) return false;
  await deleteMeta(key);
  return true;
}

export function isExternalQuotaId(id) {
  return typeof id === "string" && id.startsWith("ext:");
}

export function externalQuotaSourceFromId(id) {
  if (!isExternalQuotaId(id)) return null;
  const source = id.slice(4);
  return isValidExternalQuotaSource(source) ? source : null;
}

function snapshotToRow(snap) {
  const quotas = (snap.entries || []).map((e) => ({
    name: e.name || e.key,
    used: e.used || 0,
    total: e.total || 0,
    resetAt: e.resetAt || null,
    ...(e.unlimited !== undefined ? { unlimited: e.unlimited } : {}),
    ...(e.recurring !== undefined ? { recurring: e.recurring } : {}),
    ...(e.remainingPercentage !== undefined ? { remainingPercentage: e.remainingPercentage } : {}),
    ...(e.percentScale !== undefined ? { percentScale: e.percentScale } : {}),
    ...(e.displayRemaining !== undefined ? { displayRemaining: e.displayRemaining } : {}),
    ...(e.giftPack !== undefined ? { giftPack: e.giftPack } : {}),
  }));
  return {
    id: `ext:${snap.source}`,
    provider: snap.provider || snap.source,
    authType: "external",
    external: true,
    source: snap.source,
    name: snap.label || snap.source,
    isActive: true,
    // Ranks the pushed cards ahead of every DB connection (user-set priorities
    // start at 1; the priority sort is ascending) — the point of the push is
    // "show me what CD measured", so it leads the wall.
    priority: 0,
    createdAt: snap.firstSeenAt || snap.pushedAt,
    updatedAt: snap.pushedAt,
    // Same entry shape fetchQuota writes into quotaData ({quotas, plan,
    // message, raw, cachedAt}) — the client seeds from it verbatim, so rows
    // render through the existing pack bar / table / depletion code paths.
    quota: {
      quotas,
      plan: snap.plan || null,
      // The card body renders `quota.message` INSTEAD of the quota rows
      // (ProviderLimits render chain), so only surface it when there is
      // nothing numeric to show.
      message: quotas.length === 0 ? snap.message || null : null,
      raw: { source: snap.source, pushedAt: snap.pushedAt },
      cachedAt: snap.pushedAt,
    },
  };
}

/**
 * All live (non-expired) snapshots as synthetic connection rows. Fail-soft by
 * design: a corrupt or unreadable snapshot is skipped (and lazily dropped when
 * it is past TTL), never a thrown error — the quota page must still render the
 * real connections.
 */
export async function buildExternalConnectionRows() {
  try {
    const rows = await listMetaByPrefix(EXTERNAL_QUOTA_META_PREFIX);
    const out = [];
    const now = Date.now();
    for (const row of rows || []) {
      let snap;
      try {
        snap = JSON.parse(row.value);
      } catch {
        continue;
      }
      if (!snap || typeof snap !== "object" || !isValidExternalQuotaSource(snap.source)) continue;
      const pushed = Date.parse(snap.pushedAt);
      if (!Number.isFinite(pushed) || now - pushed > EXTERNAL_QUOTA_TTL_MS) {
        // Expired — remove it so the wall stops re-parsing dead snapshots.
        deleteMeta(row.key).catch(() => {});
        continue;
      }
      out.push(snapshotToRow(snap));
    }
    return out;
  } catch (error) {
    console.warn("[externalQuota] failed to build rows:", error?.message || error);
    return [];
  }
}
