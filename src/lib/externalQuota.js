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
// Quota keys double as display labels when the pusher sends no `name`, so
// CJK must ride too — LongCat's official pack names ARE the keys ("赠送资源包"
// 资源包文案原样推送, 2026-10). Grammar: letter/number/CJK first char, then
// those plus separator punctuation; no slashes, quotes or control chars.
const QUOTA_KEY_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._@·（）()\-]{0,63}$/u;

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
  detailOnly: "boolean",     // collapsed into 逐包明细, kept off the headline pool
  summarizesDetail: "boolean", // summary row (headline restatement) — charted, never listed in 逐包明细
  isCreditBalance: "boolean", // stored-value balance (钱/币余额) — single value + unit, never "X / Y"
  // Read-only daily check-in state carried on the row (CreditDaddy#33 方案 B):
  // the push says "this account signed in today"; 10Router only ever displays
  // it. Absent = unknown (the pusher's query failed) — no badge, never an error.
  checkinToday: "boolean",
  streakDays: "positiveInteger", // consecutive-day streak, rendered beside the badge when present
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
    case "positiveInteger":
      // A streak of "7.5" is malformed, not rounded — drop it rather than
      // inventing a number the pusher never sent.
      return Number.isInteger(value) && value > 0 ? value : undefined;
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

// Patterns a pusher may embed in `name` when its numeric fields didn't survive:
//   "317.57 万 / 500 万 · 赠送 · 至 10-25 · 36%已消耗"   (LongCat, CreditDaddy)
//   "55 / 100 · 45% consumed"                            (generic fallback)
// PREFERRED first: a remaining/total pair IS the numbers themselves, so it
// beats a percent (which would just re-derive the same pair). All patterns
// accept 万/亿 multipliers because CJK pushers compose magnitudes into labels.
const REMAINING_PATTERNS = [
  // "剩余 317.57 万 / 500 万" — explicit remaining marker
  /剩余\s*([\d.]+)\s*(万|亿)?\s*\/\s*([\d.]+)\s*(万|亿)?/,
  // "317.57 万 / 500 万" — bare remaining/total, anywhere in the name
  /([\d.]+)\s*(万|亿)?\s*\/\s*([\d.]+)\s*(万|亿)?/,
];
const PERCENT_PATTERNS = [
  // "36%已消耗" / "36% consumed"
  /(\d+(?:\.\d+)?)\s*%\s*(?:已消耗|consumed)/i,
  // "已消耗 36%" / "consumed: 36%"
  /(?:已消耗|consumed)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*%/i,
];

const CJK_MAGNITUDE = { 万: 10_000, 亿: 100_000_000 };

/**
 * Defensive repair for pushers that stash the usage numbers inside `name`
 * while pushing `used: 0` / a wrong `remainingPercentage` (LongCat via
 * CreditDaddy, 2026-10: name said "317.57 万 / 500 万 · … · 36%已消耗" but
 * used=0 and remainingPercentage=100 — the card then read as a full pack).
 * Recover `used` from the name ONLY when the numeric fields are missing or
 * zero — an explicit used always wins, and the name itself is never modified.
 */
function recoverUsedFromName(entry) {
  if (typeof entry.name !== "string" || !entry.name) return;
  if (Number.isFinite(entry.used) && entry.used > 0) return;

  // A remaining/total pair in the name is the authoritative shape: scale both
  // sides by their own 万/亿 unit, derive used, and trust the name's total when
  // the pushed total disagrees (LongCat pushed total = the REMAINING figure).
  for (const re of REMAINING_PATTERNS) {
    const m = re.exec(entry.name);
    if (!m) continue;
    const remaining = applyMagnitude(Number(m[1]), m[2]);
    const parsedTotal = applyMagnitude(Number(m[3]), m[4]);
    if (
      Number.isFinite(remaining) && remaining >= 0 &&
      Number.isFinite(parsedTotal) && parsedTotal > 0 &&
      remaining <= parsedTotal
    ) {
      const used = parsedTotal - remaining;
      if (used > 0) {
        entry.used = Math.round(used * 100) / 100;
        if (Math.abs(parsedTotal - entry.total) / parsedTotal > 0.01) entry.total = parsedTotal;
        // remainingPercentage, when pushed, described the broken shape — drop
        // it so the renderer derives from the now-correct used/total.
        delete entry.remainingPercentage;
      }
      return; // a remaining pair settles it — percent adds nothing
    }
  }

  // Percent-of-total fallback — base on whatever total we ended up with.
  const total = Number.isFinite(entry.total) && entry.total > 0 ? entry.total : null;
  if (total === null) return;
  for (const re of PERCENT_PATTERNS) {
    const m = re.exec(entry.name);
    if (!m) continue;
    const pct = Number(m[1]);
    if (Number.isFinite(pct) && pct > 0 && pct <= 100) {
      entry.used = Math.round(((total * pct) / 100) * 100) / 100;
      delete entry.remainingPercentage;
    }
    break;
  }
}

function applyMagnitude(num, unit) {
  const n = Number(num);
  if (!Number.isFinite(n)) return NaN;
  return unit && CJK_MAGNITUDE[unit] ? n * CJK_MAGNITUDE[unit] : n;
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

  // Optional refresh callback for the card's "Refresh quota" button: an
  // expiring capability URL the pusher (CreditDaddy) answers by measuring
  // again and re-pushing. Scalar-only like everything else here, and
  // validated as an http(s) URL so nothing structured can ride it. External
  // pushed cards carry it, and a same-name claim mirrors it onto the claiming
  // connection row (attachClaimRefreshUrls) so that card's button can call
  // back too. The usage API itself never reads the field — the BROWSER posts
  // it, so no server-side fetch of a pushed URL (SSRF) is introduced.
  let refreshUrl = null;
  if (body.refreshUrl !== undefined && body.refreshUrl !== null) {
    if (typeof body.refreshUrl !== "string") {
      return { ok: false, error: "refreshUrl must be a scalar http(s) URL string" };
    }
    const u = body.refreshUrl.trim();
    if (u && !/^https?:\/\//i.test(u)) {
      return { ok: false, error: "refreshUrl must start with http:// or https://" };
    }
    refreshUrl = u ? clipString(u, 500) : null;
  }

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
      recoverUsedFromName(entry);
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
      refreshUrl,
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
    ...(e.detailOnly !== undefined ? { detailOnly: e.detailOnly } : {}),
    ...(e.summarizesDetail !== undefined ? { summarizesDetail: e.summarizesDetail } : {}),
    ...(e.isCreditBalance !== undefined ? { isCreditBalance: e.isCreditBalance } : {}),
    ...(e.checkinToday !== undefined ? { checkinToday: e.checkinToday } : {}),
    ...(e.streakDays !== undefined ? { streakDays: e.streakDays } : {}),
  }));
  return {
    id: `ext:${snap.source}`,
    provider: snap.provider || snap.source,
    authType: "external",
    external: true,
    source: snap.source,
    name: snap.label || snap.source,
    // Pusher-supplied refresh callback (absent on older pushes and for
    // connection cards) — the external-card refresh button calls it to make
    // the pusher measure again; guarded at the call site, never assumed.
    refreshUrl: snap.refreshUrl || null,
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

/**
 * 同名认领（2026-10-14 定版）：外部推送卡与真实连接同 provider 且同名（去首尾空格、
 * 忽略大小写；CD 账号别名与 10R 连接名两侧都可改）时，数字归连接卡展示，推送卡让位
 * ——同一数值不印两遍（卡面纪律）。
 */
function rowMatchKey(provider, name) {
  return `${provider}|${String(name || "").trim().toLowerCase()}`;
}

/** 过滤掉已被真实连接认领的推送卡（在 providers/client 合并处调用） */
export function filterClaimedExternalRows(connections, externalRows) {
  const claimed = new Set((connections || []).map((c) => rowMatchKey(c.provider, c.name)));
  return (externalRows || []).filter((r) => !claimed.has(rowMatchKey(r.provider, r.name)));
}

/** 反向：连接 → 认领到的推送快照行（river 用量卡读本地数字用） */
export function findClaimedExternalRow(connection, externalRows) {
  const want = rowMatchKey(connection?.provider, connection?.name);
  return (externalRows || []).find((r) => rowMatchKey(r.provider, r.name) === want) || null;
}

/**
 * 认领镜像：把被认领推送卡上的 `refreshUrl` 抄到连接行上（在让位过滤之前调用）。
 * 没有这一步，连接卡（如改名对齐后的 River）的刷新按钮只会重读本地快照——
 * 从不 POST 回推送方，CD 侧收不到现拉请求、数字也不会变（2026-10-15 用户实测
 * 「刷新无日志、按钮不转」的根因）。POST 仍由浏览器发起，服务端不碰推送 URL。
 */
export function attachClaimRefreshUrls(connections, externalRows) {
  const byKey = new Map();
  for (const r of externalRows || []) {
    if (r.refreshUrl) byKey.set(rowMatchKey(r.provider, r.name), r.refreshUrl);
  }
  for (const c of connections || []) {
    const url = byKey.get(rowMatchKey(c.provider, c.name));
    if (url) c.refreshUrl = url;
  }
  return connections;
}
