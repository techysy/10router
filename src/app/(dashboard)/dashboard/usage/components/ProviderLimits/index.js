"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import ProviderIcon from "@/shared/components/ProviderIcon";
import QuotaPackBar from "@/shared/components/QuotaPackBar";
import QuotaToolbar from "./QuotaToolbar";
import QuotaWindowTimeline from "@/shared/components/QuotaWindowTimeline";
import { detailRows, needsPerPackDetails } from "@/shared/utils/quotaRows";
import { classifyConnectionCooldown } from "@/shared/utils/connectionCooldown";
import {
  connectionsCacheKey,
  createLimiter,
  isQuotaFresh,
  readConnectionsCache,
  readQuotaEntries,
  writeConnectionsCache,
  writeQuotaEntry,
} from "./quotaPageCache";
import QuotaTable, { translateQuotaName } from "./QuotaTable";
import Toggle from "@/shared/components/Toggle";
import Tooltip from "@/shared/components/Tooltip";
import {
  parseQuotaData,
  calculatePercentage,
  filterQuotasByVisibility,
  getHiddenQuotaRows,
  computeDepletedHiddenKeys,
  getQuotaVisibilityKey,
  getConnectionLabel,
  getConnectionQuotaRemaining,
  sortVisibleConnections,
  filterQuotaStateByConnections,
  getConnectionsEmptyMessage,
  getPageSizeLabel,
  getConnectionsPaginationSummary,
  getVisiblePageSummary,
  getSafePagination,
  getSafeTotals,
  shouldResetPage,
  getPaginationPageValue,
  getProviderOptions,
  reconcileConnectionsPage,
  getInitialProviderFilter,
  buildProviderFilterUrl,
  getQuotaCache,
  QUOTA_CACHE_KEY,
  REFRESH_INTERVAL_MS,
  CLAUDE_REFRESH_INTERVAL_MS,
  DEPLETED_QUOTA_THRESHOLD,
  AUTO_REFRESH_STORAGE_KEY,
  CONNECTIONS_PAGE_SIZE,
  ACCOUNT_PAGE_SIZE_OPTIONS,
  ACCOUNT_PAGE_SIZE_MAX,
  ACCOUNT_FILTER_OPTIONS,
  QUOTA_SORT_OPTIONS,
} from "./utils";
import Card from "@/shared/components/Card";
import { translate } from "@/i18n/runtime";
import { ConfirmModal, EditConnectionModal } from "@/shared/components";
import { USAGE_SUPPORTED_PROVIDERS, getProviderWebsite } from "@/shared/constants/providers";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

// Maps the stored providerSpecificData.authMethod to a human label for Kiro.
// Values come from the Kiro connect flows: builder-id/idc (device code),
// google/github (social), imported (refresh-token paste), api_key (headless).
const KIRO_METHOD_LABELS = {
  "builder-id": "AWS Builder ID",
  idc: "IAM Identity Center",
  google: "Google",
  github: "GitHub",
  imported: "Imported Token",
  api_key: "API Key",
};

const AUTO_PING_SETTINGS_KEYS = {
  claude: "claudeAutoPing",
  codex: "codexAutoPing",
};

const AUTO_PING_TOOLTIPS = {
  claude: "When your 5h quota runs out, auto-sends a request the moment it resets so a new window starts right away.",
  codex: "Auto-starts the next 5h Codex window after reset by sending a tiny gpt-5.5 request. Consumes a small amount of quota.",
};

function kiroMethodLabel(conn) {
  const m = conn.providerSpecificData?.authMethod;
  if (m && KIRO_METHOD_LABELS[m]) return KIRO_METHOD_LABELS[m];
  return conn.authType === "api_key" ? "API Key" : "OAuth";
}

function getConnectionSecondaryLabel(connection) {
  const primary = getConnectionLabel(connection);
  const name = connection.name?.trim();
  const email = connection.email?.trim();
  const displayName = connection.displayName?.trim();

  // If user configured a custom name that is distinct from email and displayName,
  // do not clutter the card with redundant raw email or usernames.
  if (name && name !== email && (!displayName || name !== displayName)) {
    return null;
  }

  // Qoder cards show the profile display name as the primary label (email
  // hidden for privacy); never duplicate it in the secondary slot.
  if (connection.name?.trim() && connection.email?.trim() && connection.name.trim() !== connection.email.trim()) {
    const label = connection.email.trim();
    if (label !== primary) return label;
  }

  if (connection.name?.trim() && connection.displayName?.trim() && connection.name.trim() !== connection.displayName.trim()) {
    const label = connection.displayName.trim();
    if (label !== primary) return label;
  }

  return null;
}

// Region is stored for builder-id/idc/api_key flows; social and imported flows
// omit it, so fall back to the region segment of the profileArn
// (arn:aws:codewhisperer:<region>:...).
function kiroRegion(conn) {
  const r = conn.providerSpecificData?.region;
  if (r) return r;
  const arn = conn.providerSpecificData?.profileArn;
  const seg = typeof arn === "string" ? arn.split(":")[3] : "";
  return seg || "";
}

function getCodexResetCreditCount(quota) {
  const value = quota?.raw?.resetCredits?.availableCount;
  const count = typeof value === "number" ? value : Number(value);
  return Number.isFinite(count) ? Math.max(0, count) : 0;
}

// Anthropic limit-window ids → short display names for the "refills" column
const CLAUDE_RESET_LIMIT_NAMES = {
  five_hour: "session",
  seven_day: "weekly",
  seven_day_overage_included: "weekly",
  seven_day_opus: "Opus weekly",
  seven_day_sonnet: "Sonnet weekly",
};

function formatClaudeResetClears(clears) {
  const names = [...new Set((clears || []).map((c) => CLAUDE_RESET_LIMIT_NAMES[c]).filter(Boolean))];
  return names.length ? `${names.join(" + ")} limits` : "limits";
}

function claudeGrantStatus(grant) {
  if (grant.resetsLeft <= 0) return "used";
  if (grant.paused) return "paused";
  if (grant.endsAt && new Date(grant.endsAt).getTime() <= Date.now()) return "expired";
  if (grant.usableNow) return "usable now";
  if (grant.startsAt && new Date(grant.startsAt).getTime() > Date.now()) return "not started";
  return grant.useRequiresLimit ? "at limit only" : "unavailable";
}

function formatCreditDate(value) {
  if (!value) return "N/A";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "N/A";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatTimeRemaining(value) {
  if (!value) return "N/A";
  const diffMs = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(diffMs)) return "N/A";
  if (diffMs <= 0) return "Expired";
  const totalHours = Math.ceil(diffMs / (60 * 60 * 1000));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return days > 0 ? `${days}d ${hours}h` : `${hours}h`;
}

const KNOWN_PROVIDER_NAMES = {
  "qoder-cn": "Qoder CN",
  "qoder": "Qoder",
  "codebuddy-cn": "CodeBuddy CN",
  "codebuddy-intl": "CodeBuddy Intl",
  "minimax-cn": "MiniMax CN",
  "glm-cn": "GLM CN",
  "kimi-cn": "Kimi CN",
};

export default function ProviderLimits() {
  const { copied, copy } = useCopyToClipboard();
  const [connections, setConnections] = useState([]);
  const [quotaData, setQuotaData] = useState({});
  const [loading, setLoading] = useState({});
  const [errors, setErrors] = useState({});
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [autoPingMaps, setAutoPingMaps] = useState({ claude: {}, codex: {} });
  const [lastUpdated, setLastUpdated] = useState(null);
  const [hasHydratedAutoRefresh, setHasHydratedAutoRefresh] = useState(false);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [countdown, setCountdown] = useState(60);
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const [deletingId, setDeletingId] = useState(null);
  const [togglingId, setTogglingId] = useState(null);
  const [resettingLimitId, setResettingLimitId] = useState(null);
  const [resetConfirmState, setResetConfirmState] = useState(null);
  const [resetCreditsState, setResetCreditsState] = useState(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedConnection, setSelectedConnection] = useState(null);
  const [proxyPools, setProxyPools] = useState([]);
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  // 初值优先取 URL ?provider=，让过滤后的视图可以被书签化/分享；无参时保持
  // 原语义，回落 localStorage 里持久化的上次选择。
  const [providerFilter, setProviderFilterState] = useState(() => {
    const stored = typeof window === "undefined" ? null : window.localStorage.getItem("quotaProviderFilter");
    return getInitialProviderFilter(searchParams?.get("provider"), stored);
  });
  // 切换过滤器时回写 URL：replace 不产生历史记录、scroll:false 不打断滚动位置；
  // 下面的 localStorage 持久化 effect 保持不变，继续充当无 URL 参时的兜底初值。
  const setProviderFilter = useCallback((value) => {
    setProviderFilterState(value);
    router.replace(buildProviderFilterUrl(pathname, searchParams?.toString() || "", value), { scroll: false });
  }, [router, pathname, searchParams]);
  const [providerOptions, setProviderOptions] = useState([]);
  const [accountFilter, setAccountFilter] = useState(() => {
    if (typeof window === "undefined") return "all";
    return window.localStorage.getItem("quotaAccountFilter") || "all";
  });
  // Persist filter choices across visits/sessions.
  useEffect(() => {
    if (typeof window !== "undefined") window.localStorage.setItem("quotaProviderFilter", providerFilter);
  }, [providerFilter]);
  useEffect(() => {
    if (typeof window !== "undefined") window.localStorage.setItem("quotaAccountFilter", accountFilter);
  }, [accountFilter]);
  const [quotaSortMode, setQuotaSortMode] = useState("default");
  // "cards" | "windows" (the 配额窗口 timeline). Session-only on purpose: every
  // visit opens on the cards, the main view — remembering "windows" across
  // visits left people staring at the timeline wondering where their cards went.
  const [trackerView, setTrackerView] = useState("cards");
  const [windowsRefreshKey, setWindowsRefreshKey] = useState(0);
  const [quotaVisibility, setQuotaVisibility] = useState({});
  const [expiringFirst, setExpiringFirst] = useState(false);
  // "Hide no-quota cards": a view toggle that drops connections with no quota
  // package to show (the cloud MiMo card, Token Plan, …). The switch itself
  // lives on the Experimental page (Providers card) — the toolbar here was
  // getting crowded — so this page only reads the persisted pref. Default
  // off so nothing disappears unasked.
  const [hideNoQuota] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("quotaHideNoQuota") === "1";
  });
  // Experimental (same localStorage pattern as hideNoQuota, switch on the
  // Experimental page): draw contained subscription windows as ONE nested
  // track instead of flat rows.
  const [nestedCycle] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("quotaNestedCycle") === "1";
  });
  // "Only with balance" is NOT a separate view filter. It writes the
  // zero-balance rows into the SAME per-connection `quotaVisibility.hidden` list
  // that the per-row hide button writes, so the two stay one thing: a row hidden
  // either way shows up in the "Hidden:" chips below its card, is listed by name,
  // and can be restored individually. Implementing it as its own render-time
  // filter instead (the "hideDepleted" boolean that used to live here) dropped
  // rows with NO chips to explain them and no way to bring one back — the state
  // and the screen disagreed.
  const [bulkToggling, setBulkToggling] = useState(false);
  // 逐包明细默认收起（CreditDaddy 语言）：展开才渲染 QuotaTable。
  const [expandedDetails, setExpandedDetails] = useState(() => new Set());
  const toggleDetails = useCallback((id) => {
    setExpandedDetails((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(CONNECTIONS_PAGE_SIZE);
  const [customPageSizeInput, setCustomPageSizeInput] = useState(
    String(CONNECTIONS_PAGE_SIZE),
  );
  const [pagination, setPagination] = useState({
    page: 1,
    pageSize: CONNECTIONS_PAGE_SIZE,
    total: 0,
    totalPages: 1,
  });
  const [totals, setTotals] = useState({
    eligibleConnections: 0,
    providerFilteredConnections: 0,
  });

  const intervalRef = useRef(null);
  const countdownRef = useRef(null);
  const tickCountRef = useRef(0);

  const fetchConnections = useCallback(
    async (targetPage = page) => {
      try {
        const params = new URLSearchParams({
          page: String(targetPage),
          pageSize: String(pageSize),
          accountStatus: accountFilter,
          sort: "priority",
        });

        if (providerFilter !== "all") {
          params.set("provider", providerFilter);
        }

        const response = await fetch(
          `/api/providers/client?${params.toString()}`,
        );
        if (!response.ok) throw new Error("Failed to fetch connections");

        const data = await response.json();
        const connectionList = data.connections || [];
        const nextPagination = getSafePagination(data.pagination, pageSize);
        const nextTotals = getSafeTotals(data.totals, connectionList.length);

        setConnections(connectionList);
        setProviderOptions(getProviderOptions(data.providerOptions));
        setPagination(nextPagination);
        setTotals(nextTotals);
        setPage(getPaginationPageValue(data.pagination, targetPage));
        writeConnectionsCache(
          connectionsCacheKey({ page: targetPage, pageSize, accountFilter, providerFilter }),
          {
            connections: connectionList,
            pagination: nextPagination,
            totals: nextTotals,
            providerOptions: data.providerOptions,
          },
        );
        return connectionList;
      } catch (error) {
        // Keep whatever is on screen (the cache-painted page, or the previous
        // one): a transient /api/providers/client failure must not blank the
        // wall the stale-while-revalidate flow just painted. Returning null —
        // not [] — tells callers to skip this round: re-filtering quota state
        // against an empty list would wipe it too.
        console.error("Error fetching connections:", error);
        return null;
      }
    },
    [accountFilter, expiringFirst, page, pageSize, providerFilter],
  );

  // Fetch quota for a specific connection
  const fetchQuota = useCallback(async (connectionId, provider, { force = false } = {}) => {
    setLoading((prev) => ({ ...prev, [connectionId]: true }));
    setErrors((prev) => ({ ...prev, [connectionId]: null }));

    try {
      console.log(
        `[ProviderLimits] Fetching quota for ${provider} (${connectionId})`,
      );
      const url = `/api/usage/${connectionId}${force ? "?force=1" : ""}`;
      const response = await fetch(url);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMsg = errorData.error || response.statusText;

        // Handle different error types gracefully
        if (response.status === 404) {
          // Connection not found - skip silently
          console.warn(
            `[ProviderLimits] Connection not found for ${provider}, skipping`,
          );
          return;
        }

        if (response.status === 401) {
          // Auth error - show message instead of throwing
          console.warn(
            `[ProviderLimits] Auth error for ${provider}:`,
            errorMsg,
          );
          const quotaEntry = {
            quotas: [],
            message: errorMsg,
            cachedAt: new Date().toISOString(),
          };
          setQuotaData((prev) => ({
            ...prev,
            [connectionId]: quotaEntry,
          }));
          writeQuotaEntry(connectionId, quotaEntry);
          return;
        }

        throw new Error(`HTTP ${response.status}: ${errorMsg}`);
      }

      const data = await response.json();
      console.log(`[ProviderLimits] Got quota for ${provider}:`, data);

      // Parse quota data using provider-specific parser
      const parsedQuotas = parseQuotaData(provider, data);

      const quotaEntry = {
        quotas: parsedQuotas,
        plan: data.plan || null,
        message: data.message || null,
        raw: data,
        cachedAt: new Date().toISOString(),
      };

      setQuotaData((prev) => ({
        ...prev,
        [connectionId]: quotaEntry,
      }));
      writeQuotaEntry(connectionId, quotaEntry);
    } catch (error) {
      console.error(
        `[ProviderLimits] Error fetching quota for ${provider} (${connectionId}):`,
        error,
      );
      setErrors((prev) => ({
        ...prev,
        [connectionId]: error.message || "Failed to fetch quota",
      }));
    } finally {
      setLoading((prev) => ({ ...prev, [connectionId]: false }));
    }
  }, []);

  // ─── Lazy revalidation ────────────────────────────────────────────────
  // Cards paint from the browser cache (quotaPageCache.js); the network only
  // revalidates behind them. A card is refetched when it is on screen (or
  // within 200px of it); an off-screen card is parked in `pendingQuotaRef`
  // and fetched the moment it scrolls into view. At most
  // QUOTA_FETCH_CONCURRENCY upstream calls run at once.
  const [runLimited] = useState(() => createLimiter());
  const visibleIdsRef = useRef(new Set());
  const pendingQuotaRef = useRef(new Map()); // connectionId → provider
  const observerRef = useRef(null);
  const fetchQuotaRef = useRef(fetchQuota);
  useEffect(() => {
    fetchQuotaRef.current = fetchQuota;
  }, [fetchQuota]);

  const getCardObserver = useCallback(() => {
    if (observerRef.current || typeof IntersectionObserver === "undefined") return observerRef.current;
    observerRef.current = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.dataset.connId;
          if (!id) continue;
          if (!entry.isIntersecting) {
            visibleIdsRef.current.delete(id);
            continue;
          }
          visibleIdsRef.current.add(id);
          if (pendingQuotaRef.current.has(id)) {
            const provider = pendingQuotaRef.current.get(id);
            pendingQuotaRef.current.delete(id);
            runLimited(() => fetchQuotaRef.current(id, provider));
          }
        }
      },
      { rootMargin: "200px 0px" },
    );
    return observerRef.current;
  }, [runLimited]);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  /** Ref callback for a card: observe it, stop observing when it unmounts. */
  const observeCard = useCallback((el) => {
    const observer = getCardObserver();
    if (!el || !observer) return undefined;
    observer.observe(el);
    return () => {
      observer.unobserve(el);
      visibleIdsRef.current.delete(el.dataset.connId);
    };
  }, [getCardObserver]);

  /**
   * Revalidate these connections' quotas.
   *  - skipFreshFrom: entries younger than QUOTA_FRESH_MS are left alone
   *  - lazy: off-screen cards wait until they scroll into view (without an
   *    IntersectionObserver everything is fetched straight away)
   */
  const scheduleQuotaFetches = useCallback(
    (conns, { lazy = true, skipFreshFrom = null } = {}) => {
      const canObserve = typeof IntersectionObserver !== "undefined";
      const tasks = [];
      for (const conn of conns) {
        if (skipFreshFrom && isQuotaFresh(skipFreshFrom[conn.id])) continue;
        if (lazy && canObserve && !visibleIdsRef.current.has(conn.id)) {
          pendingQuotaRef.current.set(conn.id, conn.provider);
          continue;
        }
        pendingQuotaRef.current.delete(conn.id);
        tasks.push(runLimited(() => fetchQuotaRef.current(conn.id, conn.provider)));
      }
      return Promise.all(tasks);
    },
    [runLimited],
  );

  // Refresh quota for a specific provider
  const refreshProvider = useCallback(
    async (connectionId, provider) => {
      await fetchQuota(connectionId, provider, { force: true });
      setLastUpdated(new Date());
    },
    [fetchQuota],
  );

  const handleResetLimit = useCallback(
    async (connectionId, provider) => {
      if ((provider !== "codex" && provider !== "claude") || resettingLimitId) return;

      setResettingLimitId(connectionId);
      setErrors((prev) => ({ ...prev, [connectionId]: null }));

      try {
        const response = provider === "claude"
          ? await fetch(`/api/usage/${connectionId}/claude-reset`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ grantId: quotaData[connectionId]?.raw?.resetCredits?.nextGrantId }),
          })
          : await fetch(`/api/usage/${connectionId}/codex-reset-credits`, { method: "POST" });
        const result = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(result.message || result.error || result.code || "Failed to reset limit");
        }

        await fetchQuota(connectionId, provider, { force: true });
        setLastUpdated(new Date());
      } catch (error) {
        setErrors((prev) => ({ ...prev, [connectionId]: error.message || "Failed to reset limit" }));
      } finally {
        setResettingLimitId(null);
      }
    },
    [fetchQuota, resettingLimitId, quotaData],
  );

  // Claude grants already arrive with the usage read; no extra fetch
  const handleViewClaudeResets = useCallback((connection, resetCredits) => {
    setResetCreditsState({ connection, loading: false, error: null, data: { kind: "claude", ...resetCredits } });
  }, []);

  const handleViewCodexResetCredits = useCallback(async (connection) => {
    setResetCreditsState({ connection, loading: true, error: null, data: null });
    try {
      const response = await fetch(`/api/usage/${connection.id}/codex-reset-credits`, { cache: "no-store" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.error || result.message || "Failed to load Codex reset credits");
      }
      const credits = Array.isArray(result.credits) ? [...result.credits] : [];
      credits.sort((a, b) => {
        const aTime = a.expiresAt ? new Date(a.expiresAt).getTime() : Number.POSITIVE_INFINITY;
        const bTime = b.expiresAt ? new Date(b.expiresAt).getTime() : Number.POSITIVE_INFINITY;
        return aTime - bTime;
      });
      setResetCreditsState({ connection, loading: false, error: null, data: { ...result, credits } });
    } catch (error) {
      setResetCreditsState({ connection, loading: false, error: error.message || "Failed to load Codex reset credits", data: null });
    }
  }, []);

  const handleDeleteConnection = useCallback(
    async (id) => {
      if (!confirm("Delete this connection?")) return;
      setDeletingId(id);
      try {
        const res = await fetch(`/api/providers/${id}`, { method: "DELETE" });
        if (res.ok) {
          setQuotaData((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
          setLoading((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
          setErrors((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });

          if (typeof window !== "undefined") {
            try {
              const cache = getQuotaCache();
              if (cache[id]) {
                delete cache[id];
                window.localStorage.setItem(
                  QUOTA_CACHE_KEY,
                  JSON.stringify(cache),
                );
              }
            } catch (e) {
              console.error("Error deleting cache entry:", e);
            }
          }

          await reconcileConnectionsPage(fetchConnections, page);
        }
      } catch (error) {
        console.error("Error deleting connection:", error);
      } finally {
        setDeletingId(null);
      }
    },
    [fetchConnections, page],
  );

  const handleToggleConnectionActive = useCallback(
    async (id, isActive) => {
      setTogglingId(id);
      try {
        const res = await fetch(`/api/providers/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isActive }),
        });
        if (res.ok) {
          setQuotaData((prev) => {
            const next = { ...prev };
            return next;
          });
          await reconcileConnectionsPage(fetchConnections, page);
        }
      } catch (error) {
        console.error("Error updating connection status:", error);
      } finally {
        setTogglingId(null);
      }
    },
    [fetchConnections, page],
  );

  const handleUpdateConnection = useCallback(
    async (formData) => {
      if (!selectedConnection?.id) return;
      const connectionId = selectedConnection.id;
      const provider = selectedConnection.provider;
      try {
        const res = await fetch(`/api/providers/${connectionId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(formData),
        });
        if (res.ok) {
          await fetchConnections();
          setShowEditModal(false);
          setSelectedConnection(null);
          if (USAGE_SUPPORTED_PROVIDERS.includes(provider)) {
            await fetchQuota(connectionId, provider);
          }
        }
      } catch (error) {
        console.error("Error saving connection:", error);
      }
    },
    [selectedConnection, fetchConnections, fetchQuota],
  );

  useEffect(() => {
    let cancelled = false;
    fetch("/api/proxy-pools?isActive=true", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && data?.proxyPools) {
          setProxyPools(data.proxyPools);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshAll = useCallback(async (force = false) => {
    if (refreshingAll) return;

    setRefreshingAll(true);
    setCountdown(60);

    // Throttle Claude: poll its quota every Nth auto-tick (manual force bypasses)
    const tick = (tickCountRef.current += 1);
    const claudeEvery = Math.round(CLAUDE_REFRESH_INTERVAL_MS / REFRESH_INTERVAL_MS);
    const shouldFetch = (conn) =>
      force || conn.provider !== "claude" || tick % claudeEvery === 0;

    try {
      const visibleConnections = await fetchConnections(page);
      if (!visibleConnections) return; // fetch failed — keep the last-known page

      // Cards keep their last numbers while they refresh (the header icon
      // spins) — no more blanking every card back to a spinner each minute.
      setErrors((prev) =>
        filterQuotaStateByConnections(prev, visibleConnections),
      );
      setQuotaData((prev) =>
        filterQuotaStateByConnections(prev, visibleConnections),
      );

      // Auto-refresh only touches cards on screen; the rest refresh when
      // scrolled to. The toolbar's "refresh all" (force) does every card.
      await scheduleQuotaFetches(visibleConnections.filter(shouldFetch), { lazy: !force });

      setLastUpdated(new Date());
    } catch (error) {
      console.error("Error refreshing all providers:", error);
    } finally {
      setRefreshingAll(false);
    }
  }, [refreshingAll, fetchConnections, scheduleQuotaFetches, page]);

  useEffect(() => {
    let cancelled = false;

    // 1) Paint the last-known page + quotas from the browser cache at once.
    //    (Read in an effect, not a state initializer, so SSR markup matches.)
    const cached = readConnectionsCache(
      connectionsCacheKey({ page, pageSize, accountFilter, providerFilter }),
    );
    if (cached) {
      setConnections(cached.connections);
      setProviderOptions(getProviderOptions(cached.providerOptions));
      if (cached.pagination) setPagination(cached.pagination);
      if (cached.totals) setTotals(cached.totals);
      setQuotaData((prev) => ({ ...readQuotaEntries(cached.connections), ...prev }));
      setConnectionsLoading(false);
    } else {
      setConnectionsLoading(true);
    }

    // 2) Revalidate behind it: the real list, then only the quotas that are
    //    stale — visible cards first, the rest as they scroll into view.
    const initializeData = async () => {
      const visibleConnections = await fetchConnections(page);
      if (cancelled) return;
      setConnectionsLoading(false);
      if (!visibleConnections) return; // fetch failed — the painted page stands

      const stored = readQuotaEntries(visibleConnections);
      setErrors((prev) =>
        filterQuotaStateByConnections(prev, visibleConnections),
      );
      setQuotaData((prev) => ({
        ...stored,
        ...filterQuotaStateByConnections(prev, visibleConnections),
      }));

      await scheduleQuotaFetches(visibleConnections, { skipFreshFrom: stored });
      if (!cancelled) setLastUpdated(new Date());
    };

    initializeData();
    return () => {
      cancelled = true;
    };
  }, [fetchConnections, scheduleQuotaFetches, page, pageSize, accountFilter, providerFilter]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(AUTO_REFRESH_STORAGE_KEY);
    setAutoRefresh(stored === null ? true : stored === "true");
    setHasHydratedAutoRefresh(true);
  }, []);

  // Persist auto-refresh preference
  useEffect(() => {
    if (typeof window === "undefined" || !hasHydratedAutoRefresh) return;
    window.localStorage.setItem(AUTO_REFRESH_STORAGE_KEY, String(autoRefresh));
  }, [autoRefresh, hasHydratedAutoRefresh]);

  // Load auto-ping per-connection maps
  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : {}))
      .then((s) => {
        setAutoPingMaps({
          claude: s?.claudeAutoPing?.connections || {},
          codex: s?.codexAutoPing?.connections || {},
        });
        setQuotaVisibility(s?.quotaVisibility || {});
      })
      .catch(() => {});
  }, []);

  const toggleAutoPing = useCallback(async (connectionId, provider, on) => {
    const settingsKey = AUTO_PING_SETTINGS_KEYS[provider];
    if (!settingsKey) return;

    const previous = autoPingMaps;
    const nextProviderMap = { ...(autoPingMaps[provider] || {}), [connectionId]: on };
    const nextMaps = { ...autoPingMaps, [provider]: nextProviderMap };
    setAutoPingMaps(nextMaps);
    try {
      const r = await fetch("/api/settings", { cache: "no-store" });
      const s = r.ok ? await r.json() : {};
      const cfg = { ...(s[settingsKey] || {}), connections: nextProviderMap };
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [settingsKey]: cfg }),
      });
    } catch {
      setAutoPingMaps(previous);
    }
  }, [autoPingMaps]);

  const updateQuotaVisibility = useCallback(async (nextVisibility, previousVisibility) => {
    setQuotaVisibility(nextVisibility);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quotaVisibility: nextVisibility }),
      });
      if (!response.ok) throw new Error("Failed to update quota visibility");
    } catch (error) {
      console.error("Error updating quota visibility:", error);
      setQuotaVisibility(previousVisibility);
    }
  }, []);

  /**
   * Apply a hide/show edit against the CURRENT visibility map.
   *
   * This must not read `quotaVisibility` from the render closure. The "Hidden:"
   * chip row and the per-row hide buttons are all in one card, so a burst of
   * clicks lands in the same tick — every handler would then compute its edit
   * from the same pre-click snapshot and the last PATCH would win, silently
   * discarding the rest. That is why clicking five chips only restored two rows.
   * Taking the updater form of setState makes each edit see the previous one.
   */
  const editQuotaVisibility = useCallback((connectionId, mutate) => {
    if (!connectionId) return;
    setQuotaVisibility((current) => {
      const entryVisibility = current[connectionId] || {};
      const nextHidden = mutate(new Set(entryVisibility.hidden || []));
      const next = {
        ...current,
        [connectionId]: { ...entryVisibility, hidden: [...nextHidden] },
      };
      // Persist the map we are actually installing. Failures roll the UI back
      // to the snapshot this edit started from.
      void (async () => {
        try {
          const response = await fetch("/api/settings", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ quotaVisibility: next }),
          });
          if (!response.ok) throw new Error("Failed to update quota visibility");
        } catch (error) {
          console.error("Error updating quota visibility:", error);
          setQuotaVisibility(current);
        }
      })();
      return next;
    });
  }, []);

  // Antigravity rows are family groups (gemini/claude); toggling the group also
  // clears stale per-model keys so the group row and its members never disagree.
  const pruneAntigravityGroup = (hidden, key) => {
    if (key === "gemini") {
      for (const k of hidden) {
        if (k.startsWith("gemini-") && !k.includes("image")) hidden.delete(k);
      }
    } else if (key === "claude") {
      for (const k of hidden) {
        if (k.startsWith("claude-") || k.startsWith("gpt-")) hidden.delete(k);
      }
    }
  };

  const handleHideQuota = useCallback((connectionId, quota, provider) => {
    const key = getQuotaVisibilityKey(quota);
    if (!connectionId || !key) return;
    editQuotaVisibility(connectionId, (hidden) => {
      hidden.add(key);
      if (provider === "antigravity") pruneAntigravityGroup(hidden, key);
      return hidden;
    });
  }, [editQuotaVisibility]);

  // "Show all" on a card's hidden strip: empty that connection's hidden list —
  // the same list the per-row hide and the bulk "only with balance" filter write.
  const handleShowAllQuotas = useCallback((connectionId) => {
    if (!connectionId) return;
    editQuotaVisibility(connectionId, () => new Set());
  }, [editQuotaVisibility]);

  const handleShowQuota = useCallback((connectionId, quota, provider) => {
    const key = getQuotaVisibilityKey(quota);
    if (!connectionId || !key) return;
    editQuotaVisibility(connectionId, (hidden) => {
      hidden.delete(key);
      if (provider === "antigravity") pruneAntigravityGroup(hidden, key);
      return hidden;
    });
  }, [editQuotaVisibility]);

  /**
   * Bulk-apply a hidden-list to every given connection, through the same
   * setState updater the per-row buttons use, so a bulk click and a row click in
   * the same tick cannot lose each other.
   */
  const applyVisibilityToConnections = useCallback((connectionIds, buildHidden) => {
    if (!connectionIds.length) return;
    setQuotaVisibility((current) => {
      const next = { ...current };
      let changed = false;
      for (const connId of connectionIds) {
        const entryVisibility = next[connId] || {};
        const hiddenList = buildHidden(connId, entryVisibility);
        if (hiddenList === null) continue; // nothing to change
        const prevHidden = entryVisibility.hidden || [];
        if (
          hiddenList.length !== prevHidden.length ||
          hiddenList.some((k, i) => k !== prevHidden[i])
        ) {
          next[connId] = { ...entryVisibility, hidden: hiddenList };
          changed = true;
        }
      }
      if (!changed) return current;
      void (async () => {
        try {
          const response = await fetch("/api/settings", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ quotaVisibility: next }),
          });
          if (!response.ok) throw new Error("Failed to update quota visibility");
        } catch (error) {
          console.error("Error updating quota visibility:", error);
          setQuotaVisibility(current);
        }
      })();
      return next;
    });
  }, []);

  /**
   * "Only with balance": hide every zero-balance row across the current
   * connections by writing them into `quotaVisibility.hidden` — the same list
   * the per-row hide button writes.
   *
   * This is a live re-filter, not a one-way add: a row that currently HAS balance
   * (used < total — including a fresh 0/total pack, e.g. CodeBuddy CN's daily
   * check-in bonus) is dropped from `hidden` even if a past click hid it.
   * CodeBuddy renumbers bonus packs (older ones expire and later packs shift into
   * their names), so a persistent hide-by-name would otherwise keep a brand-new
   * full pack invisible under the name of a pack that used to be depleted.
   *
   * Defined further down, next to `sortedConnections` — these need that memo,
   * and referencing it from here would be a temporal-dead-zone error.
   */

  // Auto-refresh interval
  useEffect(() => {
    if (!hasHydratedAutoRefresh || !autoRefresh) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (countdownRef.current) {
        clearInterval(countdownRef.current);
        countdownRef.current = null;
      }
      return;
    }

    // Main refresh interval
    intervalRef.current = setInterval(() => {
      refreshAll();
    }, REFRESH_INTERVAL_MS);

    // Countdown interval
    countdownRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) return 60;
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [autoRefresh, refreshAll, hasHydratedAutoRefresh]);

  // Pause auto-refresh when tab is hidden (Page Visibility API)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
        if (countdownRef.current) {
          clearInterval(countdownRef.current);
          countdownRef.current = null;
        }
      } else if (autoRefresh && hasHydratedAutoRefresh) {
        // Resume auto-refresh when tab becomes visible
        intervalRef.current = setInterval(() => refreshAll(), REFRESH_INTERVAL_MS);
        countdownRef.current = setInterval(() => {
          setCountdown((prev) => (prev <= 1 ? 60 : prev - 1));
        }, 1000);
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [autoRefresh, refreshAll, hasHydratedAutoRefresh]);

  const sortedConnections = useMemo(
    () =>
      sortVisibleConnections(
        connections,
        quotaData,
        expiringFirst,
        providerFilter,
        quotaSortMode,
      ),
    [connections, quotaData, expiringFirst, providerFilter, quotaSortMode],
  );

  // "Hide no-quota" view: drop a card only once its fetch has COMPLETED with no
  // quota package at all (kept while loading, on error, or as soon as any quota
  // row is present, so a real card never blinks out). A message-only card (the
  // cloud MiMo "no separate quota" note, Token Plan) counts as no-quota here —
  // that is exactly what the toggle is for.
  const renderConnections = useMemo(() => {
    if (!hideNoQuota) return sortedConnections;
    return sortedConnections.filter((conn) => {
      if (loading[conn.id]) return true;
      if (errors[conn.id]) return true;
      const q = quotaData[conn.id];
      if (!q) return true; // not fetched yet — decide once we know
      return (q.quotas?.length ?? 0) > 0;
    });
  }, [sortedConnections, hideNoQuota, loading, errors, quotaData]);

  /**
   * "Only with balance" bulk action removed (用户拍板): the pack-bar top block
   * and the collapsed details made row-level balance filtering noise. The
   * per-row hide button and the "Hidden:" chips stay for manual curation.
   */
  // A connection is empty (depleted) only when EVERY quota row has an absolute
  // zero balance — 0/0 (no allowance, e.g. Qoder) or used >= total. Any single
  // row with remaining credit (e.g. a fresh Bonus Pack) keeps the account
  // "available". Genuinely unlimited rows opt out via unlimited:true and don't
  // count either way; accounts with only unlimited rows stay available.
  const isConnectionDepleted = (conn) => {
    const quotas = quotaData[conn.id]?.quotas;
    if (!quotas?.length) return false;
    const judged = quotas.filter((q) => q.unlimited !== true);
    if (judged.length === 0) return false;
    return judged.every((q) => {
      const total = q.total || 0;
      return total <= 0 || (q.used || 0) >= total;
    });
  };

  const bulkSetActive = useCallback(
    async (targetIds, isActive) => {
      if (!targetIds.length || bulkToggling) return;
      setBulkToggling(true);
      try {
        await Promise.all(
          targetIds.map((id) =>
            fetch(`/api/providers/${id}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ isActive }),
            }),
          ),
        );
        await reconcileConnectionsPage(fetchConnections, page);
      } catch (error) {
        console.error("Error bulk toggling connections:", error);
      } finally {
        setBulkToggling(false);
      }
    },
    [bulkToggling, fetchConnections, page],
  );

  const handleDisableDepleted = () => {
    const ids = sortedConnections
      .filter((c) => (c.isActive ?? true) && isConnectionDepleted(c))
      .map((c) => c.id);
    bulkSetActive(ids, false);
  };

  const handleEnableAvailable = () => {
    const ids = sortedConnections
      .filter((c) => !(c.isActive ?? true) && !isConnectionDepleted(c))
      .map((c) => c.id);
    bulkSetActive(ids, true);
  };

  const selectedProviderLabel =
    providerFilter === "all" ? "All providers" : providerFilter;
  const hasEligibleConnections = totals.eligibleConnections > 0;
  const hasVisibleConnections = renderConnections.length > 0;
  const emptyState = getConnectionsEmptyMessage(
    totals,
    providerFilter,
    accountFilter,
  );
  const showingRange = ({ start, end, total }) =>
    translate("Showing {start}-{end} of {total}")
      .replace("{start}", String(start))
      .replace("{end}", String(end))
      .replace("{total}", String(total));
  const connectionsPageSummary = getConnectionsPaginationSummary(pagination, showingRange);
  // "Hide no-quota" removes whole cards from this page, and the backend summary
  // ("Showing 1-10 of 46") counts the server's page — it cannot see the filter.
  // Report what is actually rendered instead, so the mismatch reads as "a filter
  // is on" rather than as broken controls.
  //
  // "Only with balance" deliberately does NOT feed this: it hides quota ROWS
  // inside the cards and leaves the card count alone, so switching to a
  // row-based number here would only make the summary mean something else.
  const viewFilterActive = renderConnections.length !== sortedConnections.length;
  const visiblePageSummary = getVisiblePageSummary(renderConnections.length, pageSize, showingRange);
  const isCustomPageSize = !ACCOUNT_PAGE_SIZE_OPTIONS.includes(pageSize);
  const pageSizeLabel = getPageSizeLabel(pageSize, isCustomPageSize);

  const emptyStateNode = !connectionsLoading && !hasEligibleConnections ? (
    <Card padding="lg">
      <div className="text-center py-12">
        <span className="material-symbols-outlined text-[64px] text-text-muted opacity-20">
          cloud_off
        </span>
        <h3 className="mt-4 text-lg font-semibold text-text">
          No Providers Connected
        </h3>
        <p className="mt-2 text-sm text-text-muted max-w-md mx-auto">
          Connect to providers with OAuth to track your API quota limits and
          usage.
        </p>
      </div>
    </Card>
  ) : !connectionsLoading && !hasVisibleConnections ? (
    <Card padding="lg">
      <div className="text-center py-12">
        <span className="material-symbols-outlined text-[64px] text-text-muted opacity-20">
          {emptyState.icon}
        </span>
        <h3 className="mt-4 text-lg font-semibold text-text">
          {emptyState.title}
        </h3>
        <p className="mt-2 text-sm text-text-muted max-w-md mx-auto">
          {emptyState.description}
        </p>
      </div>
    </Card>
  ) : null;

  return (
    <div className="space-y-6">
      <QuotaToolbar
        view={trackerView}
        onViewChange={setTrackerView}
        providerFilter={providerFilter}
        providerOptions={providerOptions}
        providerLabel={providerFilter === "all" ? translate("All providers") : selectedProviderLabel}
        onProviderChange={(provider) => {
          if (shouldResetPage(providerFilter, provider)) setPage(1);
          setProviderFilter(provider);
        }}
        accountFilter={accountFilter}
        onAccountChange={(value) => {
          if (shouldResetPage(accountFilter, value)) setPage(1);
          setAccountFilter(value);
        }}
        showCodexSort={providerFilter === "codex"}
        quotaSortMode={quotaSortMode}
        onQuotaSortChange={setQuotaSortMode}
        expiringFirst={expiringFirst}
        onToggleExpiringFirst={() => setExpiringFirst((prev) => !prev)}
        onDisableDepleted={handleDisableDepleted}
        onEnableAvailable={handleEnableAvailable}
        bulkToggling={bulkToggling}
        autoRefresh={autoRefresh}
        onToggleAutoRefresh={() => setAutoRefresh((prev) => !prev)}
        countdown={countdown}
        refreshingAll={refreshingAll}
        onRefreshAll={() =>
          trackerView === "windows" ? setWindowsRefreshKey((k) => k + 1) : refreshAll(true)
        }
        accountCount={pagination.total}
      />

      {trackerView === "windows" ? (
        <QuotaWindowTimeline
          providerFilter={providerFilter}
          accountFilter={accountFilter}
          refreshKey={windowsRefreshKey}
          showTrackerLink={false}
        />
      ) : (
      <>

      {/* Empty state (filters matched nothing) — controls stay visible above */}
      {emptyStateNode && <div className="pt-2">{emptyStateNode}</div>}

      {!emptyStateNode && (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {renderConnections.map((conn) => {
          const quota = quotaData[conn.id];
          const providerWebsite = getProviderWebsite(conn.provider);
          // Spinner only while a card has NOTHING to show; with cached numbers
          // it keeps them and only the header refresh icon spins.
          const isRefreshing = Boolean(loading[conn.id]);
          const error = errors[conn.id];
          const isLoading = !quota && !error;

          // Use table layout for all providers
          const isInactive = conn.isActive === false;
          // Classified, not read raw: this pill used to consult conn.testStatus
          // directly, with no cooldown awareness at all, so a single model's
          // 429 painted it red and left it red for the whole lock window even
          // though the account kept serving every other model (issue #46).
          const connState = classifyConnectionCooldown(conn).state;
          const isCodex = conn.provider === "codex";
          const claudeReset = conn.provider === "claude" ? quota?.raw?.resetCredits : null;
          const resetLabel = isCodex ? "Codex reset credit" : "Claude limit reset";
          const resetCreditCount = getCodexResetCreditCount(quota);
          const isResettingLimit = resettingLimitId === conn.id;
          const rowBusy = deletingId === conn.id || togglingId === conn.id || isResettingLimit;
          const rawQuotas = quota?.quotas || [];
          // One source of truth: rows hidden by "Only with balance" and rows
          // hidden by the per-row button are both listed in `quotaVisibility`, so
          // both surface as "Hidden:" chips and both can be restored individually.
          const visibleQuotas = filterQuotasByVisibility(conn.id, rawQuotas, quotaVisibility, conn.provider);
          const hiddenQuotaRows = getHiddenQuotaRows(conn.id, rawQuotas, quotaVisibility, conn.provider);
          // 逐包明细 lists packs, not the totals the card headline already shows
          // (总积分, Qoder's 资源包 sum) — see isSummaryRow.
          const detailQuotas = detailRows(visibleQuotas);
          // Subscription cards already show every row; the toggle only appears
          // when the card collapsed something (packs summed into the headline).
          const showDetails = needsPerPackDetails(visibleQuotas);
          // 逐包明细展开 = 原始数据（用户拍板：不筛选不改序）；顶部块的分段
          // 条/剩余总额由 QuotaPackBar 内部聚合（月度并入，作为以重置日为
          // 到期日的资源包）。

          return (
            <Card
              key={conn.id}
              ref={observeCard}
              data-conn-id={conn.id}
              padding="none"
              className={`min-w-0 ${isInactive ? "opacity-60" : ""}`}
            >
              <div className="px-3 py-2 border-b border-black/10 dark:border-white/10">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    {/* 图标点击跳转供应商官网/控制台(注册表 display.website 等,
                        与 providers/[id] 详情页同一回退链)。解析不到 URL 的
                        provider(自定义连接)保持纯图标,不渲染链接。 */}
                    {providerWebsite ? (
                      <a
                        href={providerWebsite}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={`${translate("Open provider site")} — ${providerWebsite.replace(/^https?:\/\//, "")}`}
                        className="w-8 h-8 shrink-0 rounded-md flex items-center justify-center overflow-hidden hover:ring-2 hover:ring-brand-500/40 hover:bg-black/5 dark:hover:bg-white/5 transition-all"
                      >
                        <ProviderIcon
                          src={`/providers/${conn.provider}.png`}
                          alt={conn.provider}
                          size={32}
                          className="object-contain"
                          fallbackText={
                            conn.provider?.slice(0, 2).toUpperCase() || "PR"
                          }
                        />
                      </a>
                    ) : (
                      <div className="w-8 h-8 shrink-0 rounded-md flex items-center justify-center overflow-hidden">
                        <ProviderIcon
                          src={`/providers/${conn.provider}.png`}
                          alt={conn.provider}
                          size={32}
                          className="object-contain"
                          fallbackText={
                            conn.provider?.slice(0, 2).toUpperCase() || "PR"
                          }
                        />
                      </div>
                    )}
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold text-text truncate">
                        {KNOWN_PROVIDER_NAMES[conn.provider] || (
                          <span className="capitalize">{conn.provider}</span>
                        )}
                      </h3>
                      {getConnectionLabel(conn) ? (
                        <p className="text-xs text-text-muted truncate">
                          {getConnectionLabel(conn)}
                        </p>
                      ) : null}
                      {getConnectionSecondaryLabel(conn) ? (
                        <p className="text-[11px] text-text-muted/80 truncate">
                          {getConnectionSecondaryLabel(conn)}
                        </p>
                      ) : null}
                      {conn.provider === "kiro" && (
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          <span className="rounded-full bg-brand-500/10 px-2 py-0.5 text-[10px] font-semibold text-brand-600 dark:text-brand-300">
                            {kiroMethodLabel(conn)}
                          </span>
                          {kiroRegion(conn) && (
                            <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] font-semibold text-blue-600 dark:text-blue-400">
                              {kiroRegion(conn)}
                            </span>
                          )}
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                              isInactive
                                ? "bg-surface-2 text-text-muted"
                                : connState === "active" || connState === "success"
                                  ? "bg-green-500/10 text-green-600 dark:text-green-400"
                                  : connState === "partial"
                                    ? "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400"
                                    : connState === "error" || connState === "expired" || connState === "unavailable" || connState === "needs-reauth"
                                      ? "bg-red-500/10 text-red-600 dark:text-red-400"
                                      : "bg-surface-2 text-text-muted"
                            }`}
                          >
                            {isInactive ? "disabled" : (connState === "needs-reauth" ? translate("Needs re-auth") : connState === "partial" ? "partial" : connState || "unknown")}
                          </span>
                          {conn.providerSpecificData?.profileArn && (
                            <button
                              type="button"
                              onClick={() => copy(conn.providerSpecificData.profileArn, conn.id)}
                              title={conn.providerSpecificData.profileArn}
                              className="inline-flex max-w-full items-center gap-1 rounded-full border border-border-subtle px-2 py-0.5 text-[10px] text-text-muted transition-colors hover:text-primary"
                            >
                              <span className="material-symbols-outlined text-[12px]">
                                {copied === conn.id ? "check" : "content_copy"}
                              </span>
                              <code className="truncate font-mono">
                                {conn.providerSpecificData.profileArn}
                              </code>
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    {(isCodex || claudeReset) && (
                      <>
                        <Tooltip
                          text={
                            resetCreditCount > 0
                              ? claudeReset
                                ? `Use your reset now (${resetCreditCount} left, use by ${formatCreditDate(claudeReset.expiresAt)}) · refills ${formatClaudeResetClears(claudeReset.clears)}`
                                : `Use one ${resetLabel}. Available: ${resetCreditCount}`
                              : `No ${resetLabel}s available`
                          }
                        >
                          <button
                            type="button"
                            onClick={() => setResetConfirmState({ connection: conn, resetCreditCount })}
                            disabled={resetCreditCount <= 0 || isLoading || isRefreshing || rowBusy}
                            aria-label={
                              resetCreditCount > 0
                                ? `Use one ${resetLabel}. ${resetCreditCount} available.`
                                : `No ${resetLabel}s available`
                            }
                            className={`flex h-8 min-w-10 items-center justify-center gap-1 rounded-lg border px-2 text-[11px] font-medium tabular-nums transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/60 disabled:cursor-not-allowed disabled:opacity-60 ${
                              resetCreditCount > 0
                                ? "border-primary/30 bg-primary/5 text-primary hover:bg-primary/10"
                                : "border-black/10 bg-black/[0.02] text-text-muted dark:border-white/10 dark:bg-white/[0.03]"
                            }`}
                          >
                            <span className={`material-symbols-outlined text-[15px] ${isResettingLimit ? "animate-spin" : ""}`}>
                              {isResettingLimit ? "progress_activity" : "restart_alt"}
                            </span>
                            <span>{resetCreditCount}</span>
                          </button>
                        </Tooltip>
                        <Tooltip text={isCodex ? "View Codex reset credit expiry" : "View Claude Code reset expiry"}>
                          <button
                            type="button"
                            onClick={() => (isCodex ? handleViewCodexResetCredits(conn) : handleViewClaudeResets(conn, claudeReset))}
                            disabled={isLoading || rowBusy}
                            aria-label={isCodex ? "View Codex reset credit expiry" : "View Claude Code reset expiry"}
                            className="flex h-8 w-8 items-center justify-center rounded-lg border border-black/10 text-text-muted transition-colors hover:bg-black/5 hover:text-primary disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:hover:bg-white/5"
                          >
                            <span className="material-symbols-outlined text-[17px]">schedule</span>
                          </button>
                        </Tooltip>
                      </>
                    )}
                    {AUTO_PING_SETTINGS_KEYS[conn.provider] && conn.authType === "oauth" && (
                      <Tooltip text={AUTO_PING_TOOLTIPS[conn.provider]}>
                        <button
                          type="button"
                          onClick={() => toggleAutoPing(conn.id, conn.provider, !(autoPingMaps[conn.provider]?.[conn.id] === true))}
                          aria-label="Toggle auto-ping"
                          className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-black/5 dark:hover:bg-white/5 ${autoPingMaps[conn.provider]?.[conn.id] === true ? "text-primary" : "text-text-muted"}`}
                        >
                          <span className="material-symbols-outlined text-[18px]">bolt</span>
                        </button>
                      </Tooltip>
                    )}
                    <Tooltip text="Refresh quota">
                      <button
                        type="button"
                        onClick={() => refreshProvider(conn.id, conn.provider)}
                        disabled={isRefreshing || rowBusy}
                        aria-label="Refresh quota"
                        className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                      >
                        <span
                          className={`material-symbols-outlined text-[18px] text-text-muted ${isRefreshing || isLoading ? "animate-spin" : ""}`}
                        >
                          refresh
                        </span>
                      </button>
                    </Tooltip>
                    <Tooltip text="Edit connection">
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedConnection(conn);
                          setShowEditModal(true);
                        }}
                        disabled={rowBusy}
                        aria-label="Edit connection"
                        className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-text-muted hover:text-primary transition-colors disabled:opacity-50"
                      >
                        <span className="material-symbols-outlined text-[18px]">
                          edit
                        </span>
                      </button>
                    </Tooltip>
                    <Tooltip text="Delete connection">
                      <button
                        type="button"
                        onClick={() => handleDeleteConnection(conn.id)}
                        disabled={rowBusy}
                        aria-label="Delete connection"
                        className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-red-500/10 text-red-500 transition-colors disabled:opacity-50"
                      >
                        <span
                          className={`material-symbols-outlined text-[18px] ${deletingId === conn.id ? "animate-pulse" : ""}`}
                        >
                          delete
                        </span>
                      </button>
                    </Tooltip>
                    <div
                      className="inline-flex items-center pl-0.5"
                      title={
                        (conn.isActive ?? true)
                          ? "Disable connection"
                          : "Enable connection"
                      }
                    >
                      <Toggle
                        size="sm"
                        checked={conn.isActive ?? true}
                        disabled={rowBusy}
                        onChange={(nextActive) =>
                          handleToggleConnectionActive(conn.id, nextActive)
                        }
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Multi-pack segmented bar (CreditDaddy visual language): one
                  segment per quota pack, earliest-expiry first; the meta line
                  carries the earliest live pack's remaining + reset date and
                  the connection-wide used/total sums. */}
              {quota && visibleQuotas.length > 0 && (
                <div className="px-3 pt-2.5">
                  <QuotaPackBar packs={visibleQuotas} nestedCycle={nestedCycle} />
                </div>
              )}

              <div className="px-2 py-1.5">
                {/* Qoder: a CreditDaddy web session was synced but is no longer
                    usable (expired / owner mismatch). The plan row then falls
                    back to the openapi aggregate, which zeroes out on some
                    accounts — say so instead of showing an unexplained gap
                    vs CreditDaddy (issue #44). */}
                {quota?.raw?.webSessionExpired === true && (
                  <p className="px-1 pb-1 text-[11px] text-amber-600 dark:text-amber-400">
                    <span className="material-symbols-outlined align-[-2px] text-[13px]">
                      warning
                    </span>{" "}
                    {translate(
                      "Synced CreditDaddy web session expired — plan credits may read low or missing. Re-export the account from CreditDaddy after logging in to Qoder web again.",
                    )}
                  </p>
                )}
                {/* A failed revalidation keeps the cached numbers and says so,
                    instead of replacing a working card with an error. */}
                {error && quota && (
                  <p className="px-1 pb-1 text-[11px] text-red-500/80">
                    {translate("Update failed, showing last known")} · {error}
                  </p>
                )}
                {isLoading ? (
                  <div className="text-center py-5 text-text-muted">
                    <span className="material-symbols-outlined text-[28px] animate-spin">
                      progress_activity
                    </span>
                  </div>
                ) : error && !quota ? (
                  <div className="text-center py-5">
                    <span className="material-symbols-outlined text-[28px] text-red-500">
                      error
                    </span>
                    <p className="mt-1.5 text-xs text-text-muted">{error}</p>
                  </div>
                ) : quota?.message ? (
                  <div className="text-center py-5">
                    <p className="text-xs text-text-muted">{quota.message}</p>
                  </div>
                ) : (
                  <>
                    {/* QuotaTable renders nothing for an empty list, so a card
                        whose rows are ALL hidden collapsed to a bare "Hidden:"
                        chip row with no body at all — it read as a broken card
                        rather than as a filtered one. Say what happened instead.
                        Every hidden row is reachable from the chips below, so
                        point at them. */}
                    {visibleQuotas.length === 0 && rawQuotas.length > 0 && (
                      <div className="text-center py-5">
                        <span className="material-symbols-outlined text-[28px] text-text-muted opacity-40">
                          visibility_off
                        </span>
                        <p className="mt-1.5 text-xs text-text-muted">
                          {translate("All quota rows are hidden — use the chips below to show them")}
                        </p>
                      </div>
                    )}
                    {/* 逐包明细默认收起：展开才渲染 QuotaTable（原始行不筛选
                        不改序）。所有卡都保留该入口——卡片顶部呈现的是聚合与
                        嵌套周期条，原始数据仍可一键查看。 */}
                    {showDetails && (
                      <button
                        type="button"
                        onClick={() => toggleDetails(conn.id)}
                        className="flex w-full items-center gap-1 rounded-lg py-1.5 text-[11px] text-text-muted transition-colors hover:bg-black/5 hover:text-text dark:hover:bg-white/5"
                        aria-expanded={expandedDetails.has(conn.id)}
                      >
                        <span className="material-symbols-outlined text-[14px]">
                          {expandedDetails.has(conn.id) ? "expand_less" : "expand_more"}
                        </span>
                        {translate("Per-pack details")}
                        <span className="tabular-nums opacity-60">
                          ({detailQuotas.length})
                        </span>
                      </button>
                    )}
                    {showDetails && expandedDetails.has(conn.id) && (
                      <QuotaTable
                        quotas={detailQuotas}
                        sortMode="default"
                        showSortLabel={
                          conn.provider === "codex" && quotaSortMode !== "default"
                        }
                        onHideQuota={(quotaRow) => handleHideQuota(conn.id, quotaRow, conn.provider)}
                      />
                    )}
                  </>
                )}
                {hiddenQuotaRows.length > 0 && (
                  // Hidden rows are left out of the card's totals too, so they
                  // stay listed even while the details are collapsed. Same row
                  // language as the details: 11px muted, chips restore one row,
                  // "Show all" restores the lot.
                  <div className="mt-1 flex min-w-0 items-center gap-1.5 border-t border-black/5 pt-1.5 text-[11px] text-text-muted dark:border-white/5">
                    <span className="material-symbols-outlined shrink-0 text-[14px]">
                      visibility_off
                    </span>
                    <span className="shrink-0">
                      {translate("Hidden")}
                      <span className="tabular-nums opacity-60"> ({hiddenQuotaRows.length})</span>
                    </span>
                    <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto whitespace-nowrap">
                      {hiddenQuotaRows.map((quotaRow) => (
                        <button
                          key={getQuotaVisibilityKey(quotaRow)}
                          type="button"
                          onClick={() => handleShowQuota(conn.id, quotaRow, conn.provider)}
                          className="shrink-0 rounded-[3px] bg-black/5 px-1.5 py-px transition-colors hover:bg-black/10 hover:text-text dark:bg-white/5 dark:hover:bg-white/10"
                          title={translate("Show this quota row")}
                        >
                          {translateQuotaName(quotaRow.name)}
                        </button>
                      ))}
                    </div>
                    {hiddenQuotaRows.length > 1 && (
                      <button
                        type="button"
                        onClick={() => handleShowAllQuotas(conn.id)}
                        className="shrink-0 rounded-md px-1.5 py-px transition-colors hover:bg-black/5 hover:text-text dark:hover:bg-white/5"
                      >
                        {translate("Show all")}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </Card>
          );
        })}
      </div>
      )}

      <div className="rounded-xl border border-black/10 bg-black/[0.02] px-3 py-2 dark:border-white/10 dark:bg-white/[0.03]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-text-muted">
              {viewFilterActive ? visiblePageSummary : connectionsPageSummary}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={isCustomPageSize ? "custom" : String(pageSize)}
                onChange={(event) => {
                  const nextValue = event.target.value;
                  if (nextValue === "custom") return;
                  const nextPageSize = Number.parseInt(nextValue, 10);
                  if (Number.isFinite(nextPageSize)) {
                    setPage(1);
                    setPageSize(nextPageSize);
                    setCustomPageSizeInput(String(nextPageSize));
                  }
                }}
                className="h-8 rounded-lg border border-black/10 bg-black/[0.02] px-2 text-xs text-text outline-none transition-colors hover:bg-black/5 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/10"
                aria-label="Accounts per page"
              >
                {ACCOUNT_PAGE_SIZE_OPTIONS.map((option) => (
                  <option key={option} value={String(option)}>
                    {translate("{count} / page").replace("{count}", String(option))}
                  </option>
                ))}
                <option value="custom">Custom</option>
              </select>
              <input
                type="number"
                min="1"
                max={String(ACCOUNT_PAGE_SIZE_MAX)}
                inputMode="numeric"
                value={customPageSizeInput}
                onChange={(event) => setCustomPageSizeInput(event.target.value)}
                onBlur={() => {
                  const parsedValue = Number.parseInt(customPageSizeInput, 10);
                  if (!Number.isFinite(parsedValue)) {
                    setCustomPageSizeInput(String(pageSize));
                    return;
                  }
                  const nextPageSize = Math.min(ACCOUNT_PAGE_SIZE_MAX, Math.max(1, parsedValue));
                  setPage(1);
                  setPageSize(nextPageSize);
                  setCustomPageSizeInput(String(nextPageSize));
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  const parsedValue = Number.parseInt(customPageSizeInput, 10);
                  if (!Number.isFinite(parsedValue)) {
                    setCustomPageSizeInput(String(pageSize));
                    return;
                  }
                  const nextPageSize = Math.min(ACCOUNT_PAGE_SIZE_MAX, Math.max(1, parsedValue));
                  setPage(1);
                  setPageSize(nextPageSize);
                  setCustomPageSizeInput(String(nextPageSize));
                }}
                className="h-8 w-20 rounded-lg border border-black/10 bg-black/[0.02] px-2 text-xs text-text outline-none transition-colors hover:bg-black/5 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/10"
                aria-label="Custom accounts per page"
                placeholder="Custom"
              />
              <span className="text-xs text-text-muted">
                {translate("Page {page} / {total}")
                  .replace("{page}", String(pagination.page))
                  .replace("{total}", String(pagination.totalPages))}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setPage(1)}
                disabled={
                  pagination.page <= 1 || connectionsLoading || refreshingAll
                }
                className="flex h-8 items-center rounded-lg border border-black/10 px-3 text-xs text-text transition-colors hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/5"
              >
                First Page
              </button>
              <button
                type="button"
                onClick={() =>
                  setPage((currentPage) => Math.max(1, currentPage - 1))
                }
                disabled={
                  pagination.page <= 1 || connectionsLoading || refreshingAll
                }
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-black/10 text-text transition-colors hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/5"
                aria-label="Previous accounts page"
              >
                <span className="material-symbols-outlined text-[16px]">
                  chevron_left
                </span>
              </button>
              <button
                type="button"
                onClick={() =>
                  setPage((currentPage) =>
                    Math.min(pagination.totalPages, currentPage + 1),
                  )
                }
                disabled={
                  pagination.page >= pagination.totalPages ||
                  connectionsLoading ||
                  refreshingAll
                }
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-black/10 text-text transition-colors hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/5"
                aria-label="Next accounts page"
              >
                <span className="material-symbols-outlined text-[16px]">
                  chevron_right
                </span>
              </button>
              <button
                type="button"
                onClick={() => setPage(pagination.totalPages)}
                disabled={
                  pagination.page >= pagination.totalPages ||
                  connectionsLoading ||
                  refreshingAll
                }
                className="flex h-8 items-center rounded-lg border border-black/10 px-3 text-xs text-text transition-colors hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/5"
              >
                Last Page
              </button>
            </div>
          </div>
        </div>
      </>
      )}

      <ConfirmModal
        isOpen={Boolean(resetConfirmState)}
        onClose={() => {
          if (!resettingLimitId) setResetConfirmState(null);
        }}
        onConfirm={async () => {
          const connection = resetConfirmState?.connection;
          if (!connection) return;
          await handleResetLimit(connection.id, connection.provider);
          setResetConfirmState(null);
        }}
        title={resetConfirmState?.connection?.provider === "claude" ? "Reset Claude limits?" : "Reset Codex limit?"}
        message={resetConfirmState?.connection?.provider === "claude"
          ? `Refills your ${formatClaudeResetClears(quotaData[resetConfirmState.connection.id]?.raw?.resetCredits?.clears)} now for ${getConnectionLabel(resetConfirmState.connection) || "this account"} · your weekly reset day stays ${formatCreditDate(quotaData[resetConfirmState.connection.id]?.raw?.resetCredits?.weeklyResetsAt)}. This cannot be undone. Resets left: ${resetConfirmState.resetCreditCount ?? 0}.`
          : `Use 1 Codex reset credit for ${getConnectionLabel(resetConfirmState?.connection || {}) || "this account"}. This cannot be undone. Remaining credits: ${resetConfirmState?.resetCreditCount ?? 0}.`}
        confirmText="Reset limit"
        cancelText="Cancel"
        variant="danger"
        loading={Boolean(resettingLimitId)}
      />

      {resetCreditsState && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm">
          <div className="w-full max-w-2xl overflow-hidden rounded-2xl border border-black/15 bg-white shadow-2xl ring-1 ring-black/10 dark:border-white/15 dark:bg-neutral-950 dark:ring-white/10">
            <div className="flex items-start justify-between gap-3 border-b border-black/10 bg-black/[0.03] px-4 py-3 dark:border-white/10 dark:bg-white/[0.04]">
              <div className="min-w-0">
                <h3 className="text-base font-semibold text-text">
                  {resetCreditsState.data?.kind === "claude" ? "Claude Code Limit Resets" : "Codex Reset Credit Expiry"}
                </h3>
                <p className="mt-0.5 truncate text-xs text-text-muted">
                  {getConnectionLabel(resetCreditsState.connection) || (resetCreditsState.data?.kind === "claude" ? "Claude account" : "Codex account")}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setResetCreditsState(null)}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-black/5 hover:text-text dark:hover:bg-white/5"
                aria-label="Close reset credit expiry modal"
              >
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>

            <div className="max-h-[70vh] overflow-auto bg-white p-4 dark:bg-neutral-950">
              {resetCreditsState.loading ? (
                <div className="flex items-center justify-center gap-2 py-10 text-sm text-text-muted">
                  <span className="material-symbols-outlined animate-spin text-[20px]">progress_activity</span>
                  Loading reset credits...
                </div>
              ) : resetCreditsState.error ? (
                <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-300">
                  {resetCreditsState.error}
                </div>
              ) : resetCreditsState.data?.kind === "claude" && resetCreditsState.data.grants?.length ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between rounded-xl border border-black/10 bg-black/[0.02] px-3 py-2 text-xs text-text-muted dark:border-white/10 dark:bg-white/[0.03]">
                    <span>{resetCreditsState.data.availableCount ?? 0} reset{resetCreditsState.data.availableCount === 1 ? "" : "s"} left</span>
                    <span>Weekly reset day: {formatCreditDate(resetCreditsState.data.weeklyResetsAt)}</span>
                  </div>
                  <div className="overflow-x-auto rounded-xl border border-black/10 dark:border-white/10">
                    <table className="w-full min-w-[560px] text-left text-sm">
                      <thead className="bg-black/[0.03] text-xs uppercase tracking-wide text-text-muted dark:bg-white/[0.04]">
                        <tr>
                          <th className="px-3 py-2 font-medium">Reset</th>
                          <th className="px-3 py-2 font-medium">Left</th>
                          <th className="px-3 py-2 font-medium">Refills</th>
                          <th className="px-3 py-2 font-medium">Use By</th>
                          <th className="px-3 py-2 font-medium">Remaining</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(resetCreditsState.data.grants || []).map((grant) => (
                          <tr key={grant.id} className="border-t border-black/5 dark:border-white/5">
                            <td className="px-3 py-2">
                              <div className="text-text">{grant.label || grant.id}</div>
                              <span className="mt-1 inline-block rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                                {claudeGrantStatus(grant)}
                              </span>
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 font-medium tabular-nums text-text">{grant.resetsLeft} / {grant.resetsTotal}</td>
                            <td className="px-3 py-2 text-text-muted">{formatClaudeResetClears(grant.clears)}</td>
                            <td className="px-3 py-2 text-text">{formatCreditDate(grant.endsAt)}</td>
                            <td className="whitespace-nowrap px-3 py-2 font-medium text-text">{formatTimeRemaining(grant.endsAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : resetCreditsState.data?.credits?.length ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between rounded-xl border border-black/10 bg-black/[0.02] px-3 py-2 text-xs text-text-muted dark:border-white/10 dark:bg-white/[0.03]">
                    <span>{resetCreditsState.data.credits.length} reset credit{resetCreditsState.data.credits.length === 1 ? "" : "s"}</span>
                    <span>{resetCreditsState.data.availableCount ?? 0} available</span>
                  </div>
                  <div className="overflow-x-auto rounded-xl border border-black/10 dark:border-white/10">
                    <table className="w-full min-w-[560px] text-left text-sm">
                      <thead className="bg-black/[0.03] text-xs uppercase tracking-wide text-text-muted dark:bg-white/[0.04]">
                        <tr>
                          <th className="px-3 py-2 font-medium">Status</th>
                          <th className="px-3 py-2 font-medium">Granted At</th>
                          <th className="px-3 py-2 font-medium">Expires At</th>
                          <th className="px-3 py-2 font-medium">Remaining</th>
                        </tr>
                      </thead>
                      <tbody>
                        {resetCreditsState.data.credits.map((credit, index) => (
                          <tr key={`${credit.status}-${credit.expiresAt || index}`} className="border-t border-black/5 dark:border-white/5">
                            <td className="px-3 py-2">
                              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                                {credit.status || "unknown"}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-text-muted">{formatCreditDate(credit.grantedAt)}</td>
                            <td className="px-3 py-2 text-text">{formatCreditDate(credit.expiresAt)}</td>
                            <td className="px-3 py-2 font-medium text-text">{formatTimeRemaining(credit.expiresAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-black/10 bg-black/[0.02] px-3 py-8 text-center text-sm text-text-muted dark:border-white/10 dark:bg-white/[0.03]">
                  {resetCreditsState.data?.kind === "claude" ? "No limit resets available for this account." : "No reset credit details returned for this account."}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <EditConnectionModal
        isOpen={showEditModal}
        connection={selectedConnection}
        proxyPools={proxyPools}
        onSave={handleUpdateConnection}
        onClose={() => {
          setShowEditModal(false);
          setSelectedConnection(null);
        }}
      />
    </div>
  );
}
