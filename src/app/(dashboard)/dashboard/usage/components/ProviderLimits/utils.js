import { getModelsByProviderId } from "open-sse/config/providerModels.js";
import { shortDuration } from "@/shared/utils/quotaRows";

// ─── Constants ───────────────────────────────────────────────────────────────
export const QUOTA_CACHE_KEY = "quotaCacheData";
export const REFRESH_INTERVAL_MS = 60000;
// Claude usage/quota endpoint rate-limits; poll it less often than other providers
export const CLAUDE_REFRESH_INTERVAL_MS = 600000;
export const DEPLETED_QUOTA_THRESHOLD = 5;
export const AUTO_REFRESH_STORAGE_KEY = "quotaAutoRefresh";
export const CONNECTIONS_PAGE_SIZE = 20;
export const ACCOUNT_PAGE_SIZE_OPTIONS = [10, 20, 50, 100];
export const ACCOUNT_PAGE_SIZE_MAX = 500;
export const ACCOUNT_FILTER_OPTIONS = [
  { value: "all", label: "All accounts" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Turned off" },
];
export const QUOTA_SORT_OPTIONS = [
  { value: "default", label: "Default quota order" },
  { value: "remaining-asc", label: "% quota: low to high" },
  { value: "remaining-desc", label: "% quota: high to low" },
];

// ─── Pure helpers ─────────────────────────────────────────────────────────────
// provider 过滤器的初始值：URL ?provider= 深链优先（可书签化分享），无参时
// 回落 localStorage 里持久化的上次选择，再兜底 "all"。
export function getInitialProviderFilter(urlProvider, storedProvider) {
  return urlProvider || storedProvider || "all";
}

// 切换过滤器时回写的 URL：选中具体 provider 写 ?provider=xxx；回到 "all" 时
// 移除该参数保持地址栏干净；其余 query 参数原样保留。
export function buildProviderFilterUrl(pathname, searchString, provider) {
  const params = new URLSearchParams(searchString || "");
  if (provider && provider !== "all") {
    params.set("provider", provider);
  } else {
    params.delete("provider");
  }
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function getConnectionLabel(connection) {
  const name = connection.name?.trim();
  const email = connection.email?.trim();
  const displayName = connection.displayName?.trim();

  // If user explicitly configured a custom name that is distinct from the login email,
  // honor that custom name across all providers (including Qoder).
  if (name && name !== email) {
    return name;
  }

  // Qoder Intl stores the login email as the connection name (CN stores the
  // username). If no custom name was specified (i.e. name equals email or is empty),
  // prefer the human-readable profile display name when available.
  if (connection.provider === "qoder" || connection.provider === "qoder-cn") {
    return displayName || name || email || null;
  }

  return name || email || displayName || null;
}

// A connection is empty (depleted) only when EVERY quota row has an absolute
// zero balance — 0/0 (no allowance, e.g. Qoder) or used >= total. Any single
// row with remaining credit (e.g. a fresh Bonus Pack) keeps the account
// "available". Genuinely unlimited rows opt out via unlimited:true and don't
// count either way; accounts with only unlimited rows stay available.
// A card with NO quota rows is "no quota to show", not "depleted" — that case
// belongs to the hide-no-quota toggle, so it returns false here.
//
// Lives in utils (not the component closure it grew from) so the bulk
// disable/enable actions and the "hide zero-balance cards" view filter judge a
// card with exactly the same predicate — two meanings for "depleted" would
// make the toolbar lie about what it disables.
export function isConnectionDepleted(connection, quotaData) {
  const quotas = quotaData?.[connection.id]?.quotas;
  if (!quotas?.length) return false;
  const judged = quotas.filter((q) => q.unlimited !== true);
  if (judged.length === 0) return false;
  return judged.every((q) => {
    const total = q.total || 0;
    return total <= 0 || (q.used || 0) >= total;
  });
}

export function getConnectionQuotaRemaining(connection, quotaData) {
  const quota = quotaData[connection.id]?.quotas?.[0];
  if (!quota) return Number.POSITIVE_INFINITY;
  if (typeof quota.remaining === "number") return quota.remaining;
  return Number.POSITIVE_INFINITY;
}

// Stable group-by-provider: first-seen provider order, original order within group.
function groupByProviderStable(connections) {
  const seen = new Map();
  for (const conn of connections) {
    const key = conn.provider || "";
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(conn);
  }
  return Array.from(seen.values()).flat();
}

export function sortVisibleConnections(
  connections,
  quotaData,
  expiringFirst,
  providerFilter,
  quotaSortMode,
) {
  if (providerFilter === "codex" && quotaSortMode !== "default") {
    return [...connections].sort((a, b) => {
      const remainingA = getConnectionQuotaRemaining(a, quotaData);
      const remainingB = getConnectionQuotaRemaining(b, quotaData);
      const remainingDiff =
        quotaSortMode === "remaining-asc"
          ? remainingA - remainingB
          : remainingB - remainingA;
      if (remainingDiff !== 0) return remainingDiff;
      return (getConnectionLabel(a) || "").localeCompare(
        getConnectionLabel(b) || "",
      );
    });
  }

  if (!expiringFirst) return groupByProviderStable(connections);

  const getEarliestResetTime = (connection) => {
    const resetTimes = (quotaData[connection.id]?.quotas || [])
      .map((quota) =>
        quota.resetAt
          ? new Date(quota.resetAt).getTime()
          : Number.POSITIVE_INFINITY,
      )
      .filter((time) => Number.isFinite(time));
    return resetTimes.length > 0
      ? Math.min(...resetTimes)
      : Number.POSITIVE_INFINITY;
  };

  return [...connections].sort((a, b) => {
    const expiryDiff = getEarliestResetTime(a) - getEarliestResetTime(b);
    if (expiryDiff !== 0) return expiryDiff;
    return (
      (a.provider || "").localeCompare(b.provider || "") ||
      (getConnectionLabel(a) || "").localeCompare(getConnectionLabel(b) || "")
    );
  });
}

export function buildLoadingState(connections) {
  const nextLoadingState = {};
  connections.forEach((connection) => {
    nextLoadingState[connection.id] = true;
  });
  return nextLoadingState;
}

export function filterQuotaStateByConnections(state, connections) {
  const visibleIds = new Set(connections.map((connection) => connection.id));
  return Object.fromEntries(
    Object.entries(state).filter(([id]) => visibleIds.has(id)),
  );
}

export function getConnectionsPageRange(pagination) {
  if (!pagination.total) {
    return { start: 0, end: 0 };
  }
  const start = (pagination.page - 1) * pagination.pageSize + 1;
  const end = Math.min(pagination.page * pagination.pageSize, pagination.total);
  return { start, end };
}

export function getConnectionsEmptyMessage(totals, providerFilter, accountFilter) {
  if (!totals.eligibleConnections) {
    return {
      icon: "cloud_off",
      title: "No Providers Connected",
      description:
        "Connect to providers with OAuth to track your API quota limits and usage.",
    };
  }
  if (!totals.providerFilteredConnections) {
    return {
      icon: "filter_alt_off",
      title: "No Accounts Match Current Filters",
      description:
        providerFilter === "all"
          ? "Try changing the account status filter to see more quota trackers."
          : `No ${accountFilter === "inactive" ? "turned off" : accountFilter === "active" ? "active" : "matching"} accounts found for ${providerFilter}.`,
    };
  }
  return {
    icon: "filter_alt_off",
    title: "No Accounts On This Page",
    description:
      "Try moving to another page or refreshing the current filters.",
  };
}

export function sortRequestFromExpiringFirst(expiringFirst) {
  return expiringFirst ? "expiring" : "priority";
}

export function getPageSizeLabel(pageSize, isCustomPageSize) {
  return isCustomPageSize ? `Custom: ${pageSize} / page` : `${pageSize} / page`;
}

// English default; the dashboard passes a translated formatter (the strings are
// built from numbers, so the page's text-node translator cannot match them).
export function formatShowingRange({ start, end, total }) {
  return total > 0 ? `Showing ${start}-${end} of ${total}` : "Showing 0 of 0";
}

export function getConnectionsPaginationSummary(pagination, format = formatShowingRange) {
  const { start, end } = getConnectionsPageRange(pagination);
  return format({ start, end, total: pagination.total });
}

/**
 * Page summary for when a CLIENT-SIDE view filter is on ("Hide no-quota" cards,
 * "Only with balance" rows).
 *
 * The backend summary (`getConnectionsPaginationSummary`) counts the server's
 * page: 46 connections, 10 per page. The view filters run afterwards, on this
 * page's cards only, so they can leave fewer cards on screen than the server
 * counted — and the untouched summary then read "Showing 1-10 of 46" above a
 * grid of 12 cards, which looks like the controls are broken rather than like
 * a filter is on. This variant counts what is actually rendered.
 *
 * `total` stays honest about scope: it is the number of cards surviving the
 * filter on THIS page, not a global count the client cannot compute (the filter
 * is applied to the current page only, and paging still follows the backend).
 *
 * @param {number} visibleCount - cards rendered after the view filters
 * @param {number} pageSize - accounts per backend page
 * @returns {string} e.g. "Showing 1-12 of 12"
 */
export function getVisiblePageSummary(visibleCount, pageSize, format = formatShowingRange) {
  const count = Math.max(0, Number(visibleCount) || 0);
  if (count === 0) return format({ start: 0, end: 0, total: 0 });
  const size = Math.max(1, Number(pageSize) || count);
  const start = 1;
  const end = Math.min(count, size);
  return format({ start, end, total: count });
}

export function getSafePagination(pagination, fallbackPageSize) {
  return (
    pagination || {
      page: 1,
      pageSize: fallbackPageSize,
      total: 0,
      totalPages: 1,
    }
  );
}

export function getSafeTotals(totals, fallbackTotal = 0) {
  return (
    totals || {
      eligibleConnections: fallbackTotal,
      providerFilteredConnections: fallbackTotal,
    }
  );
}

export function shouldResetPage(previousValue, nextValue) {
  return previousValue !== nextValue;
}

export function getPaginationPageValue(dataPagination, fallbackPage) {
  return dataPagination?.page || fallbackPage;
}

export function getProviderOptions(dataProviderOptions) {
  return dataProviderOptions || [];
}

export async function reconcileConnectionsPage(fetchConnections, targetPage) {
  return await fetchConnections(targetPage);
}

export function getQuotaCache() {
  if (typeof window === "undefined") return {};
  try {
    const cached = window.localStorage.getItem(QUOTA_CACHE_KEY);
    return cached ? JSON.parse(cached) : {};
  } catch (error) {
    console.error("Error reading quota cache:", error);
    return {};
  }
}

export function setQuotaCache(connectionId, quotaEntry) {
  if (typeof window === "undefined") return;
  try {
    const cache = getQuotaCache();
    cache[connectionId] = {
      ...quotaEntry,
      cachedAt: new Date().toISOString(),
    };
    window.localStorage.setItem(QUOTA_CACHE_KEY, JSON.stringify(cache));
  } catch (error) {
    console.error("Error writing quota cache:", error);
  }
}

/**
 * Format ISO date string to countdown format (inspired by vscode-antigravity-cockpit).
 * Two units, precision following magnitude ("2d 5h", "4h 40m", "15m 30s") — the
 * same rule as every other quota surface (shortDuration in shared/quotaRows).
 * @param {string|Date} date - ISO date string or Date object
 * @returns {string} Formatted countdown or "-"
 */
export function formatResetTime(date) {
  if (!date) return "-";

  try {
    const resetDate = typeof date === "string" ? new Date(date) : date;
    if (Number.isNaN(resetDate?.getTime?.()) || resetDate.getFullYear() > 2099) return "-";
    if (resetDate - new Date() <= 0) return "-";
    return shortDuration(resetDate) || "-";
  } catch (error) {
    return "-";
  }
}

/**
 * Get Tailwind color class based on percentage
 * @param {number} percentage - Remaining percentage (0-100)
 * @returns {string} Color name: "green" | "yellow" | "red"
 */
export function getStatusColor(percentage) {
  if (percentage > 70) return "green";
  if (percentage >= 30) return "yellow";
  return "red"; // 0-29% including 0% (out of quota) - show red
}

/**
 * Get status emoji based on percentage
 * @param {number} percentage - Remaining percentage (0-100)
 * @returns {string} Emoji: "🟢" | "🟡" | "🔴"
 */
export function getStatusEmoji(percentage) {
  if (percentage > 70) return "🟢";
  if (percentage >= 30) return "🟡";
  return "🔴"; // 0-29% including 0% (out of quota) - show red
}

/**
 * Calculate remaining percentage
 * @param {number} used - Used amount
 * @param {number} total - Total amount
 * @returns {number} Remaining percentage (0-100)
 */
export function calculatePercentage(used, total) {
  if (!total || total === 0) return 0;
  if (!used || used < 0) return 100;
  if (used >= total) return 0;

  return Math.round(((total - used) / total) * 100);
}

/**
 * Get remaining percentage from a normalized quota row
 * @param {Object} quota - Normalized quota object
 * @returns {number} Remaining percentage (0-100)
 */
export function getRemainingPercentage(quota) {
  if (quota?.remainingPercentage !== undefined) {
    return Math.round(quota.remainingPercentage);
  }

  if (quota?.remaining !== undefined && (quota?.total === 100 || quota?.total === undefined)) {
    return Math.max(0, Math.round(quota.remaining));
  }

  return calculatePercentage(quota?.used, quota?.total);
}

export function getQuotaVisibilityKey(quota) {
  if (!quota || typeof quota !== "object") return "";
  return String(quota.modelKey || quota.name || "").trim();
}

/**
 * Trim hidden quota keys to only those matching currently valid quotas.
 * Stale or obsolete model keys (e.g. pre-grouping individual antigravity
 * model ids) are dropped. Read-side only — stored lists stay intact, so a
 * key hidden for one connection is never lost because another connection's
 * snapshot no longer reports it.
 */
export function trimHiddenQuotaKeys(hidden = [], quotas = []) {
  if (!Array.isArray(hidden) || hidden.length === 0) return [];
  const validKeys = new Set(quotas.map(getQuotaVisibilityKey).filter(Boolean));
  return [...new Set(hidden.map((k) => String(k).trim()).filter((k) => validKeys.has(k)))];
}

/**
 * Resolve the hidden-quota set for a scope.
 *
 * The primary scope key is the connection id so that two connections of the
 * same provider (e.g. two CodeBuddy CN accounts) hide their rows
 * independently. We fall back to the legacy provider-scoped key so settings
 * saved before this change (keyed by provider id) keep working — the provider
 * fallback still applies to every connection of that provider, but any new
 * hide/show writes use the connection id and are isolated per account.
 */
function getHiddenQuotaSet(scopeKey, quotaVisibility, legacyScopeKey, quotas = []) {
  let hidden = null;
  const byScope = quotaVisibility?.[scopeKey]?.hidden;
  if (Array.isArray(byScope)) hidden = byScope.map(String);
  else if (legacyScopeKey && legacyScopeKey !== scopeKey) {
    const byLegacy = quotaVisibility?.[legacyScopeKey]?.hidden;
    if (Array.isArray(byLegacy)) hidden = byLegacy.map(String);
  }
  if (!hidden) return new Set();
  // Only trim against this scope's own snapshot; never against another
  // connection's quotas.
  if (Array.isArray(quotas) && quotas.length > 0) {
    return new Set(trimHiddenQuotaKeys(hidden, quotas));
  }
  return new Set(hidden);
}

export function filterQuotasByVisibility(scopeKey, quotas = [], quotaVisibility = {}, legacyScopeKey) {
  if (!Array.isArray(quotas) || quotas.length === 0) return [];
  const hidden = getHiddenQuotaSet(scopeKey, quotaVisibility, legacyScopeKey, quotas);
  if (hidden.size === 0) return quotas;
  return quotas.filter((quota) => !hidden.has(getQuotaVisibilityKey(quota)));
}

export function getHiddenQuotaRows(scopeKey, quotas = [], quotaVisibility = {}, legacyScopeKey) {
  if (!Array.isArray(quotas) || quotas.length === 0) return [];
  const hidden = getHiddenQuotaSet(scopeKey, quotaVisibility, legacyScopeKey, quotas);
  if (hidden.size === 0) return [];
  return quotas.filter((quota) => hidden.has(getQuotaVisibilityKey(quota)));
}

/**
 * Compute the set of quota keys that should be hidden under "Only with balance"
 * for one connection's CURRENT quota snapshot. A row is hidden only when it has
 * an absolute zero balance: 0/0 (no allowance) or used >= total. Everything with
 * remaining credit is kept visible — including a fresh 0/total full pack (e.g. a
 * CodeBuddy CN daily check-in bonus). Genuinely unlimited rows (unlimited:true)
 * stay visible regardless.
 *
 * Because this recomputes from the live snapshot (rather than appending to a
 * persistent list), a key that was hidden in the past but whose pack now has
 * balance — or whose name was taken over by a renumbered brand-new pack — is
 * dropped, so it shows up again without a manual "show all".
 *
 * @param {Array<Object>} quotas - normalized quota rows for one connection
 * @returns {Set<string>} visibility keys to hide
 */
export function computeDepletedHiddenKeys(quotas) {
  const hidden = new Set();
  if (!Array.isArray(quotas)) return hidden;
  for (const q of quotas) {
    const qk = getQuotaVisibilityKey(q);
    if (!qk) continue;
    if (q.unlimited === true) continue;
    const total = q.total || 0;
    if (total <= 0 || (q.used || 0) >= total) hidden.add(qk);
  }
  return hidden;
}

/**
 * Parse provider-specific quota structures into normalized array
 * @param {string} provider - Provider name (github, antigravity, codex, kiro, claude)
 * @param {Object} data - Raw quota data from provider
 * @returns {Array<Object>} Normalized quota objects with { name, used, total, resetAt }
 */
export function parseQuotaData(provider, data) {
  if (!data || typeof data !== "object") return [];

  const normalizedQuotas = [];

  try {
    switch (provider.toLowerCase()) {
      case "github":
        if (data.quotas) {
          // Monthly per-category allowances: each keeps its own window row and is
          // never summed into the additive resource-pack total.
          Object.entries(data.quotas).forEach(([name, quota]) => {
            if (!quota.unlimited && !(quota.total > 0)) return;
            normalizedQuotas.push({
              name: `${name} · Monthly`,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
              recurring: true,
            });
          });
        }
        break;

      case "antigravity":
        if (data.quotas) {
          // Group the per-model quota pool into family rows: the pool is
          // shared per family upstream, so N model rows with identical
          // numbers are noise. The row shows the most-exhausted member —
          // that is the binding limit for the family.
          const entries = Object.entries(data.quotas);
          const geminiModels = entries.filter(([k]) => k.startsWith("gemini-") && !k.includes("image"));
          const claudeModels = entries.filter(([k]) => k.startsWith("claude-") || k.startsWith("gpt-"));
          const imageModels = entries.filter(([k]) => k.includes("image"));
          const otherModels = entries.filter(([k]) => !k.startsWith("gemini-") && !k.startsWith("claude-") && !k.startsWith("gpt-") && !k.includes("image"));

          if (geminiModels.length > 0) {
            const rep = geminiModels.reduce((min, cur) =>
              (cur[1].remainingPercentage ?? 100) < (min[1].remainingPercentage ?? 100) ? cur : min
            )[1];
            normalizedQuotas.push({
              name: "Gemini (Flash / Pro)",
              modelKey: "gemini",
              used: rep.used || 0,
              total: rep.total || 0,
              resetAt: rep.resetAt || null,
              remainingPercentage: rep.remainingPercentage,
              percentScale: true,
            });
          }

          if (claudeModels.length > 0) {
            const rep = claudeModels.reduce((min, cur) =>
              (cur[1].remainingPercentage ?? 100) < (min[1].remainingPercentage ?? 100) ? cur : min
            )[1];
            normalizedQuotas.push({
              name: "Claude (Sonnet / Opus / GPT)",
              modelKey: "claude",
              used: rep.used || 0,
              total: rep.total || 0,
              resetAt: rep.resetAt || null,
              remainingPercentage: rep.remainingPercentage,
              percentScale: true,
            });
          }

          imageModels.forEach(([modelKey, quota]) => {
            normalizedQuotas.push({
              name: quota.displayName || modelKey,
              modelKey,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
              remainingPercentage: quota.remainingPercentage,
              percentScale: true,
            });
          });

          otherModels.forEach(([modelKey, quota]) => {
            normalizedQuotas.push({
              name: quota.displayName || modelKey,
              modelKey,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
              remainingPercentage: quota.remainingPercentage,
              percentScale: true,
            });
          });
        }
        break;

      case "codex":
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([quotaType, quota]) => {
            normalizedQuotas.push({
              name: quotaType,
              used: quota.used || 0,
              total: quota.total || 0,
              remaining: quota.remaining,
              resetAt: quota.resetAt || null,
            });
          });
        }
        break;

      case "kiro":
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([quotaType, quota]) => {
            normalizedQuotas.push({
              name: quotaType,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
            });
          });
        }
        break;

      case "qoder":
      case "qoder-cn":
        // Qoder ships `user` (plan), `addOn` (resource packages) and optionally
        // `organization`, each {total, used, remaining, unit, resetAt}. `addOn`
        // additionally carries `packs[]` — but those packs ARE the addOn
        // breakdown, already summed into addOn.total (500+400 = 900). Charting
        // both the aggregate AND its members double-counted the same credits, so
        // the packs are emitted `detailOnly`: the per-pack table (逐包明细) lists
        // them with their own expiry dates, the card never charts them.
        //
        // The `user` bucket is NOT charted (用户定版 2026-10-01): Plan Credits
        // 本身就是一个资源包，misc.js 已把 plan 行并入 addOn.packs 按到期日
        // 混排进池，单独一行会与包明细重复计读（#187 症状：0/300 的套餐行
        // 挂在卡上，而它的额度已含在总数里）。
        //
        // Don't forward Qoder's `remaining`: it is an absolute credit count, but
        // getRemainingPercentage / QuotaTable read `remaining` as a 0-100
        // percentage and would render 348 credits as "348%". Percent comes from
        // used/total instead.
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([quotaType, quota]) => {
            const total = Number(quota?.total) || 0;
            if (quotaType === "user") return;
            // A zero-total bucket carries no allowance; showing it as "剩 0 / 0"
            // is noise (and on Qoder every account has an empty `organization` row).
            if ((quotaType === "organization" || quotaType === "addOn") && total === 0) {
              return;
            }
            const resetAt =
              quota.resetAt && new Date(quota.resetAt).getFullYear() <= 2099
                ? quota.resetAt
                : null;
            const displayName =
              quotaType === "addOn"
                ? "Resource Package"
                : quotaType === "organization"
                  ? "Organization"
                  : quotaType;
            normalizedQuotas.push({
              name: displayName,
              used: quota.used || 0,
              total,
              unit: quota.unit,
              // The addOn total mixes packs with different expiry dates; a single
              // countdown on it would be misleading (the official web UI shows
              // none). Per-pack dates remain available in the details table.
              resetAt: quotaType === "addOn" ? null : resetAt,
              unlimited: quota.unlimited === true,
              // One aggregate per bucket — this is the “综合” row the card charts.
              aggregate: true,
              // addOn with its packs itemised below is only their sum: the
              // per-pack details list the packs, not this restatement of them.
              ...(quotaType === "addOn" && Array.isArray(quota.packs) && quota.packs.length > 0
                ? { summarizesDetail: true }
                : {}),
            });
            // Per-campaign breakdown of addOn (soonest-expiring first), mirroring
            // the web account page's "包含 N 个资源包" list. The last entry may be
            // an aggregate-only remainder the device-token API cannot itemise —
            // no campaign, so no expiry, and labelled instead of numbered.
            if (quotaType === "addOn" && Array.isArray(quota.packs)) {
              quota.packs.forEach((pack, i) => {
                normalizedQuotas.push({
                  // A pack may carry its own name (Qoder's merged "Plan Credits"
                  // rows keep it, so the detail table still says 套餐内 Credits).
                  name: pack.name || (pack.unitemized ? "Bonus Pack (unitemized)" : `Bonus Pack ${i + 1}`),
                  used: pack.used || 0,
                  total: pack.total || 0,
                  unit: quota.unit,
                  resetAt:
                    pack.expiresAt && new Date(pack.expiresAt).getFullYear() <= 2099
                      ? pack.expiresAt
                      : null,
                  unlimited: false,
                  recurring: false,
                  detailOnly: true,
                });
              });
            }
          });
        }
        break;

      case "claude":
        if (data.message) {
          // Handle error message case
          normalizedQuotas.push({
            name: "error",
            used: 0,
            total: 0,
            resetAt: null,
            message: data.message,
          });
        } else if (data.quotas) {
          Object.entries(data.quotas).forEach(([name, quota]) => {
            normalizedQuotas.push({
              name,
              used: quota.used || 0,
              total: quota.total || 0,
              remaining: quota.remaining !== undefined ? quota.remaining : Math.max(0, (quota.total || 100) - (quota.used || 0)),
              remainingPercentage: quota.remainingPercentage !== undefined ? quota.remainingPercentage : calculatePercentage(quota.used, quota.total),
              resetAt: quota.resetAt || null,
            });
          });
        }
        break;

      case "vercel-ai-gateway":
        // Vercel returns currency credit balance, not request quotas.
        // The 'Remaining (USD)' row needs explicit remainingPercentage because
        // its used/total values would otherwise compute the wrong direction
        // (e.g. used=95.5 / total=100 → 4% instead of 96%).
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([name, quota]) => {
            normalizedQuotas.push({
              name,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
              remainingPercentage: quota.remainingPercentage,
            });
          });
        }
        break;

      case "codebuddy-cn":
      case "codebuddy-intl":
        // CodeBuddy (CN and intl share one usage payload shape — same fetcher in
        // open-sse/services/usage/codebuddy-cn.js) mixes recurring refill packs
        // ("Monthly"/"Weekly"/...) with one-shot bonus packs ("Bonus Pack N").
        // Forward `recurring` so the UI can show "Expires in" for bonus packs
        // (whose resetAt is a hard expiry, not a refresh) instead of "Reset in".
        // Without the intl label it fell through to `default:`, which drops
        // `recurring`, so intl bonus packs read "Reset in" and never expired.
        // displayRemaining: these rows are CREDIT packs — the UI renders
        // remaining/total counting DOWN as you spend (fresh = "100/100 100%"),
        // not used/total counting up ("0/100 100%", which reads as empty).
        //
        // giftPack: CodeBuddy's "Monthly" is a monthly GRANT — the same kind of
        // thing as the Bonus Packs, just on a cycle (the fetcher derives that
        // label from the cycle length; see `refillCadence` in
        // open-sse/services/usage/codebuddy-cn.js). It is NOT a plan window.
        // The card therefore keeps it out of the cycle rows and leaves it to the
        // per-pack details. Only a subscription's own monthly window
        // (opencode-go's `usage.monthly`) gets a line of its own. Upstream both
        // are spelled "Monthly", so the distinction has to be made HERE, while
        // the provider is still known.
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([name, quota]) => {
            normalizedQuotas.push({
              name,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
              recurring: quota.recurring !== false,
              displayRemaining: true,
              ...(name === "Monthly" ? { giftPack: true } : {}),
            });
          });
        }
        break;

      case "grok-cli":
        // Grok Build credits (on-demand window + prepaid balance).
        // Do NOT forward absolute `remaining` — getRemainingPercentage treats
        // it as a 0–100 percentage (same as Qoder). Use remainingPercentage.
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([name, quota]) => {
            normalizedQuotas.push({
              name,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
              remainingPercentage: quota.remainingPercentage,
            });
          });
        }
        break;

      case "kimi":
        // Weekly / Ratelimit from /v1/usages. Prefer remainingPercentage only.
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([name, quota]) => {
            normalizedQuotas.push({
              name,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
              remainingPercentage: quota.remainingPercentage,
            });
          });
        }
        break;

      case "deepseek":
      case "stepfun":
      case "stepfun-cn":
        // Credit balance — remainingPercentage only (no absolute remaining).
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([name, quota]) => {
            normalizedQuotas.push({
              name,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
              remainingPercentage: quota.remainingPercentage,
              displayRemaining: quota.displayRemaining,
            });
          });
        }
        break;

      case "ollama":
        // Session (5h) / Weekly (7d) usage % from ollama.com/api/usage.
        // remainingPercentage only — no absolute remaining (UI treats remaining as %).
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([name, quota]) => {
            normalizedQuotas.push({
              name,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
              remainingPercentage: quota.remainingPercentage,
            });
          });
        }
        break;

      case "commandcode":
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([name, quota]) => {
            normalizedQuotas.push({
              name,
              used: quota.used || 0,
              total: quota.total || 0,
              remaining: quota.remaining !== undefined ? quota.remaining : Math.max(0, (quota.total || 0) - (quota.used || 0)),
              remainingPercentage: quota.remainingPercentage !== undefined ? quota.remainingPercentage : calculatePercentage(quota.used, quota.total),
              resetAt: quota.resetAt || null,
              recurring: quota.recurring === true,
              displayRemaining: true,
            });
          });
        }
        break;

      default:
        // Generic fallback for unknown providers
        if (data.quotas) {
          Object.entries(data.quotas).forEach(([name, quota]) => {
            normalizedQuotas.push({
              name,
              used: quota.used || 0,
              total: quota.total || 0,
              resetAt: quota.resetAt || null,
            });
          });
        }
    }
  } catch (error) {
    console.error(`Error parsing quota data for ${provider}:`, error);
    return [];
  }

  // Claude quota rows are named windows, not models — fixed display order
  // (session first, then the shared weekly pool, per-model weekly pools after).
  if (provider?.toLowerCase() === "claude") {
    const CLAUDE_QUOTA_ORDER = {
      "session (5h)": 0,
      "weekly (7d)": 1,
      "weekly fable (7d)": 2,
      "weekly opus (7d)": 3,
      "weekly sonnet (7d)": 4,
    };
    normalizedQuotas.sort((a, b) => (CLAUDE_QUOTA_ORDER[a.name] ?? 99) - (CLAUDE_QUOTA_ORDER[b.name] ?? 99));
    return normalizedQuotas;
  }

  if (provider?.toLowerCase() === "commandcode") {
    const COMMANDCODE_QUOTA_ORDER = {
      "session (5h)": 0,
      "weekly (7d)": 1,
      "Monthly Credits": 2,
      "Purchased Credits": 3,
    };
    normalizedQuotas.sort((a, b) => (COMMANDCODE_QUOTA_ORDER[a.name] ?? 99) - (COMMANDCODE_QUOTA_ORDER[b.name] ?? 99));
    return normalizedQuotas;
  }

  // Sort quotas according to PROVIDER_MODELS order
  const modelOrder = getModelsByProviderId(provider);
  if (modelOrder.length > 0) {
    const orderMap = new Map(modelOrder.map((m, i) => [m.id, i]));
    
    normalizedQuotas.sort((a, b) => {
      // Use modelKey for antigravity, otherwise use name
      const keyA = a.modelKey || a.name;
      const keyB = b.modelKey || b.name;
      const orderA = orderMap.get(keyA) ?? 999;
      const orderB = orderMap.get(keyB) ?? 999;
      return orderA - orderB;
    });
  }

  return normalizedQuotas;
}
