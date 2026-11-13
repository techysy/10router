"use client";

import { useState, useEffect, useCallback } from "react";
import PropTypes from "prop-types";
import {
  Card,
  CardSkeleton,
  Badge,
  Button,
  Toggle,
  Popover,
  MenuItem,
} from "@/shared/components";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { getProviderIconSrc } from "@/shared/utils/providerIcon";
import { OAUTH_PROVIDERS, APIKEY_PROVIDERS } from "@/shared/constants/config";
import {
  FREE_PROVIDERS,
  FREE_TIER_PROVIDERS,
  WEB_COOKIE_PROVIDERS,
  OPENAI_COMPATIBLE_PREFIX,
  ANTHROPIC_COMPATIBLE_PREFIX,
} from "@/shared/constants/providers";
import Link from "next/link";
import { getErrorCode, getRelativeTime } from "@/shared/utils";
import { useNotificationStore } from "@/store/notificationStore";
import { useHeaderSearchStore } from "@/store/headerSearchStore";
import { translate } from "@/i18n/runtime";
import ModelAvailabilityBadge from "./components/ModelAvailabilityBadge";
import AddCompatibleModal from "./components/AddCompatibleModal";
import DraggableCard from "@/shared/components/DraggableCard";
import {
  effectiveConnectionStatus,
  computeConnectionStats,
  connectionRank,
  moveCardInOrder,
  saveProviderCardOrder,
} from "@/shared/utils/providerCardOrder";

// One implementation, shared with the media-providers listing pages
// (@/shared/components/DraggableCard). Declared at module top level so it is
// initialised before ProvidersPage() can render it — the previous local
// `function DraggableCardWrapper` was hoisted; a bare `const` beside
// ProviderCard() would leave a use-before-init (TDZ) window on first paint.
const DraggableCardWrapper = DraggableCard;

function getStatusDisplay(connected, error, errorCode) {
  const parts = [];
  if (connected > 0) {
    parts.push(
      <Badge key="connected" variant="success" size="sm" dot>
        {connected} Connected
      </Badge>,
    );
  }
  if (error > 0) {
    const errText = errorCode
      ? `${error} Error (${errorCode})`
      : `${error} Error`;
    parts.push(
      <Badge key="error" variant="error" size="sm" dot>
        {errText}
      </Badge>,
    );
  }
  if (parts.length === 0) {
    return <span className="text-text-muted">No connections</span>;
  }
  return parts;
}

function getConnectionErrorTag(connection) {
  if (!connection) return null;

  const explicitType = connection.lastErrorType;
  if (explicitType === "runtime_error") return "RUNTIME";
  if (
    explicitType === "upstream_auth_error" ||
    explicitType === "auth_missing" ||
    explicitType === "token_refresh_failed" ||
    explicitType === "token_expired"
  )
    return "AUTH";
  if (explicitType === "upstream_rate_limited") return "429";
  if (explicitType === "upstream_unavailable") return "5XX";
  if (explicitType === "network_error") return "NET";

  const numericCode = Number(connection.errorCode);
  if (Number.isFinite(numericCode) && numericCode >= 400)
    return String(numericCode);

  const fromMessage = getErrorCode(connection.lastError);
  if (fromMessage === "401" || fromMessage === "403") return "AUTH";
  if (fromMessage && fromMessage !== "ERR") return fromMessage;

  const msg = (connection.lastError || "").toLowerCase();
  if (
    msg.includes("runtime") ||
    msg.includes("not runnable") ||
    msg.includes("not installed")
  )
    return "RUNTIME";
  if (
    msg.includes("invalid api key") ||
    msg.includes("token invalid") ||
    msg.includes("revoked") ||
    msg.includes("unauthorized")
  )
    return "AUTH";

  return "ERR";
}

const APIKEY_INITIAL_VISIBLE = 20;

// Connection-status buckets for the wall filter. The "active" bucket is the
// same vocabulary as the cards' top rank (connectionRank): a provider with a
// live connection OR a no-auth provider whose topology toggle is on — one
// classifier, not a second one.
const STATUS_FILTER_OPTIONS = [
  { value: "all", label: "All", icon: "apps" },
  { value: "active", label: "Active", icon: "check_circle" },
  { value: "error", label: "Error", icon: "error" },
  { value: "disabled", label: "Inactive", icon: "block" },
  { value: "none", label: "No connections", icon: "link_off" },
];

export default function ProvidersPage() {
  const [connections, setConnections] = useState([]);
  const [providerNodes, setProviderNodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAllApikey, setShowAllApikey] = useState(false);
  // Trial providers (体验: opencode/mimo-free) show by default;
  // hidden only when the settings toggle (Profile → Providers) is turned off.
  const [showCommunityProviders, setShowCommunityProviders] = useState(true);
  const [showAddCompatibleModal, setShowAddCompatibleModal] = useState(false);
  const [showAddAnthropicCompatibleModal, setShowAddAnthropicCompatibleModal] =
    useState(false);
  const [testingMode, setTestingMode] = useState(null);
  const [testResults, setTestResults] = useState(null);
  const [topologyVisibility, setTopologyVisibility] = useState({});
  const [cardOrder, setCardOrder] = useState([]);
  const [draggingCardId, setDraggingCardId] = useState(null);
  const [dragOverCardId, setDragOverCardId] = useState(null);
  // Connection-status filter for the whole wall (all / active / error /
  // disabled / none). Same buckets the cards already rank by (connectionRank),
  // so "active" here means exactly what rank 0 means: a live connection, or a
  // no-auth provider whose topology toggle is on.
  // A Popover menu, not a native <select>: the OS chrome of a select (white
  // box, blue highlight, untranslated options) is the one control language
  // this dashboard does not speak.
  const [statusFilter, setStatusFilter] = useState("all");
  const [statusFilterOpen, setStatusFilterOpen] = useState(false);
  const notify = useNotificationStore();
  const searchQuery = useHeaderSearchStore((s) => s.query);
  const registerSearch = useHeaderSearchStore((s) => s.register);
  const unregisterSearch = useHeaderSearchStore((s) => s.unregister);

  useEffect(() => {
    registerSearch("Search providers...");
    return () => unregisterSearch();
  }, [registerSearch, unregisterSearch]);

  const matchSearch = (name) => {
    if (!searchQuery.trim()) return true;
    if (!name) return false;
    return name.toLowerCase().includes(searchQuery.trim().toLowerCase());
  };

  // Compute a noAuth provider's topology visibility (same logic as the card).
  const topologyVisibleFor = (info, key) => {
    const setting = topologyVisibility?.[key];
    return setting === false
      ? false
      : setting === true
        ? true
        : !info.topologyHiddenByDefault;
  };

  // Connection state drives the primary sort key for every section.
  //
  //   0 connected (connected>0) or a noAuth provider shown on the topology
  //     canvas (enabled) → floats to the top
  //   1 a noAuth provider hidden from the topology canvas (disabled)
  //   2 configured but all connections disabled → auto-sinks below connected
  //   3 never configured (no connections at all) → auto-sinks last
  //
  // Disabled providers always sink below connected ones, but stay BEFORE
  // never-configured providers (the old toggle is removed; this is now fixed).
  const providerRank = (stats, info, key) =>
    connectionRank(stats, {
      noAuth: !!info?.noAuth,
      // noAuth free providers (opencode, mimo-free) have no connections; their
      // on/off is the topology toggle. Shown → top; hidden → just below connected.
      noAuthEnabled: topologyVisibleFor(info, key),
    });

  const getCardOrderIndex = (key) => {
    const idx = cardOrder.indexOf(key);
    return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
  };

  const sortByPriority = (entries) =>
    [...entries].sort(([ka, a], [kb, b]) => {
      // Connection state is the primary axis: active/connected providers always
      // surface before unconnected ones, then manual drag order, then priority, then name.
      // Count connections under EVERY auth type the provider can store (dualAuthTypes),
      // NOT a flat "oauth": a dual-auth card stores its credential as authType
      // "api_key"/"apikey" (mimo-desktop's account session, a qoder PAT), so the old
      // flat filter counted a live card as unconnected and sank it below empty ones —
      // while its badge (which already uses dualAuthTypes) showed it connected.
      const sa = getProviderStats(ka, dualAuthTypes(a, ka));
      const sb = getProviderStats(kb, dualAuthTypes(b, kb));
      const ra = providerRank(sa, a, ka);
      const rb = providerRank(sb, b, kb);
      if (ra !== rb) return ra - rb;
      const oa = getCardOrderIndex(ka);
      const ob = getCardOrderIndex(kb);
      if (oa !== ob) return oa - ob;
      const pa = a.priority ?? 999;
      const pb = b.priority ?? 999;
      if (pa !== pb) return pa - pb;
      return (a.name || "").localeCompare(b.name || "");
    });

  const sortItemsByPriority = (items, authType) =>
    [...items].sort((a, b) => {
      const sa = getProviderStats(a.id, authType);
      const sb = getProviderStats(b.id, authType);
      const ra = providerRank(sa, a, a.id);
      const rb = providerRank(sb, b, b.id);
      if (ra !== rb) return ra - rb;
      const oa = getCardOrderIndex(a.id);
      const ob = getCardOrderIndex(b.id);
      if (oa !== ob) return oa - ob;
      const pa = a.priority ?? 999;
      const pb = b.priority ?? 999;
      if (pa !== pb) return pa - pb;
      return (a.name || "").localeCompare(b.name || "");
    });

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [connectionsRes, nodesRes, settingsRes] = await Promise.all([
          fetch("/api/providers"),
          fetch("/api/provider-nodes"),
          fetch("/api/settings", { cache: "no-store" }),
        ]);
        const connectionsData = await connectionsRes.json();
        const nodesData = await nodesRes.json();
        if (connectionsRes.ok)
          setConnections(connectionsData.connections || []);
        if (nodesRes.ok) setProviderNodes(nodesData.nodes || []);
        if (settingsRes.ok) {
          const settingsData = await settingsRes.json();
          setTopologyVisibility(settingsData.topologyVisibility || {});
          setShowCommunityProviders(settingsData.showCommunityProviders !== false);
          if (Array.isArray(settingsData.providerCardOrder)) {
            setCardOrder(settingsData.providerCardOrder);
          }
        }
      } catch (error) {
        console.log("Error fetching data:", error);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  // Toggle whether a noAuth free provider appears on the usage topology canvas.
  const handleToggleTopology = useCallback(async (providerId, visible) => {
    const previous = topologyVisibility;
    const next = { ...previous, [providerId]: visible };
    setTopologyVisibility(next);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topologyVisibility: next }),
      });
      if (!response.ok) throw new Error("Failed to update topology visibility");
    } catch (error) {
      console.error("Error updating topology visibility:", error);
      setTopologyVisibility(previous);
    }
  }, [topologyVisibility]);

  const getProviderStats = (providerId, authType) => {
    const authTypes = Array.isArray(authType) ? authType : [authType];
    // Connection counting (connected / error / total / allDisabled) is shared
    // with the media-providers pages; the error tag/time below is page-specific.
    const stats = computeConnectionStats(connections, providerId, authTypes);
    const errorConns = connections
      .filter((c) => c.provider === providerId && authTypes.includes(c.authType))
      .filter((c) => {
        const status = effectiveConnectionStatus(c);
        return (
          status === "error" || status === "expired" || status === "unavailable"
        );
      });

    const latestError = errorConns.sort(
      (a, b) => new Date(b.lastErrorAt || 0) - new Date(a.lastErrorAt || 0),
    )[0];

    return {
      ...stats,
      errorCode: latestError ? getConnectionErrorTag(latestError) : null,
      errorTime: latestError?.lastErrorAt
        ? getRelativeTime(latestError.lastErrorAt)
        : null,
    };
  };

  // Bucket a provider's connection stats into the wall filter's states.
  // Precedence mirrors what the card shows first: a live connection wins over
  // a stale error badge, and an all-disabled provider is "Inactive" rather
  // than "Error" (its errors are history, not the current state). An enabled
  // no-auth provider (keyless free hosts, badge "Ready") counts as Active —
  // it has no connections row at all, so stats alone would misbucket it.
  const matchesStatusFilter = (stats, info, key) => {
    if (statusFilter === "all") return true;
    if (!stats) return statusFilter === "none";
    if (statusFilter === "active") {
      if (stats.connected > 0) return true;
      // noAuth free providers: on the topology canvas → active; hidden → Inactive.
      return !!info?.noAuth && providerRank(stats, info, key) === 0;
    }
    if (info?.noAuth) {
      // noAuth buckets beyond Active: topology-off is its only "Inactive" state;
      // it can never be Error (no connections) and lands in "none" otherwise.
      if (statusFilter === "disabled") return providerRank(stats, info, key) === 1;
      return statusFilter === "none";
    }
    // All-disabled wins over a stale error badge: every connection is off, so
    // the errors are history, not the current state.
    if (statusFilter === "disabled") return stats.allDisabled === true;
    if (statusFilter === "error") return stats.connected === 0 && stats.error > 0 && !stats.allDisabled;
    if (statusFilter === "none") return stats.total === 0;
    return true;
  };

  // Toggle all connections for a provider on/off. authType may be a single
  // string or an array (kiro counts oauth + api_key/apikey together).
  const handleToggleProvider = async (providerId, authType, newActive) => {
    const authTypes = Array.isArray(authType) ? authType : [authType];
    const matches = (c) =>
      c.provider === providerId && authTypes.includes(c.authType);
    const providerConns = connections.filter(matches);
    setConnections((prev) =>
      prev.map((c) => (matches(c) ? { ...c, isActive: newActive } : c)),
    );
    await Promise.allSettled(
      providerConns.map((c) =>
        fetch(`/api/providers/${c.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isActive: newActive }),
        }),
      ),
    );
  };

  const handleBatchTest = async (mode, providerId = null) => {
    if (testingMode) return;
    setTestingMode(mode === "provider" ? providerId : mode);
    setTestResults(null);
    try {
      const res = await fetch("/api/providers/test-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, providerId }),
      });
      const data = await res.json();
      setTestResults(data);
      if (data.summary) {
        const { passed, failed, total } = data.summary;
        if (failed === 0) notify.success(`${translate("All")} ${total} ${translate("tests passed")}`);
        else notify.warning(`${passed}/${total} ${translate("passed")}, ${failed} ${translate("failed")}`);
      }
    } catch (error) {
      setTestResults({ error: translate("Test request failed") });
      notify.error(translate("Provider test failed"));
    } finally {
      setTestingMode(null);
    }
  };

  const compatibleProviders = providerNodes
    .filter((node) => node.type === "openai-compatible")
    .map((node) => ({
      id: node.id,
      name: node.name || "OpenAI Compatible",
      color: "#10A37F",
      textIcon: "OC",
      apiType: node.apiType,
    }))
    .filter((p) => matchSearch(p.name));

  const anthropicCompatibleProviders = providerNodes
    .filter((node) => node.type === "anthropic-compatible")
    .map((node) => ({
      id: node.id,
      name: node.name || "Anthropic Compatible",
      color: "#D97757",
      textIcon: "AC",
    }))
    .filter((p) => matchSearch(p.name));

  // Dual-auth providers (oauth + apikey) store API keys as authType "apikey"
  // (and sometimes "api_key"). Card stats must count both so totals match detail.
  // kiro has no authModes in registry but accepts both (headless uses "api_key").
  const dualAuthTypes = (info, key) => {
    if (key === "kiro") return ["oauth", "apikey", "api_key"];
    // mimo-desktop declares authModes ["oauth"] (its credential is the account
    // session, not a key), but its ONLY connect path — the shared MiMo modal
    // through /api/oauth/xiaomi-mimo/api-key — writes rows with authType
    // "api_key" (placeholder token). Counting "oauth" only made the card show
    // "No connections" next to a live, tested connection on the detail page.
    if (key === "mimo-desktop") return ["oauth", "apikey", "api_key"];
    // dumate is a webCookie provider surfaced in the OAuth group (QR login) —
    // its connections carry authType "cookie", so count that alongside "oauth".
    if (key === "dumate") return ["cookie", "oauth"];
    const modes = info?.authModes;
    // Free-tier and API-key providers default to supporting apikey even when the
    // registry entry omits authModes (e.g. cloudflare-ai, byteplus, ollama,
    // vertex) — otherwise their apikey connections are invisible on the grid card.
    if (!Array.isArray(modes)) {
      return key in FREE_TIER_PROVIDERS || key in APIKEY_PROVIDERS
        ? ["oauth", "apikey", "api_key"]
        : "oauth";
    }
    if (!modes.includes("apikey")) return "oauth";
    return ["oauth", "apikey", "api_key"];
  };

  const oauthEntries = sortByPriority(
    // Merge the QR-login webCookie providers into the OAuth group so they show
    // up where users expect an interactive login flow (DuMate is today the
    // only one — the dedicated Web Cookie section stays collapsed below).
    Object.entries({
      ...OAUTH_PROVIDERS,
      ...(WEB_COOKIE_PROVIDERS.dumate ? { dumate: WEB_COOKIE_PROVIDERS.dumate } : {}),
    }).filter(([, info]) => !info.hidden && matchSearch(info.name)),
  ).filter(([key, info]) => matchesStatusFilter(getProviderStats(key, dualAuthTypes(info, key)), info, key));
  // Merge free (noAuth/connectionless) and free-tier (api-key) providers into
  // ONE list sorted by the shared connection-state rule. Without this, the two
  // arrays render sequentially and a connected free-tier provider (e.g. Dots)
  // could still appear BELOW a topology-hidden noAuth provider (e.g. opencode),
  // which looks wrong. Combined sort keeps connected providers on top.
  const freeAllEntries = [
    ...Object.entries(FREE_PROVIDERS)
      .filter(
        ([, info]) =>
          !info.hidden &&
          !(info.community && !showCommunityProviders) &&
          matchSearch(info.name),
      )
      .map(([k, info]) => ({ key: k, info, stats: getProviderStats(k, dualAuthTypes(info, k)), isFreeTier: false })),
    ...Object.entries(FREE_TIER_PROVIDERS)
      .filter(
        ([, info]) =>
          !info.hidden &&
          !(info.community && !showCommunityProviders) &&
          matchSearch(info.name) &&
          (info.serviceKinds ?? ["llm"]).includes("llm"),
      )
      .map(([k, info]) => ({ key: k, info, stats: getProviderStats(k, dualAuthTypes(info, k)), isFreeTier: true })),
  ].filter((item) => matchesStatusFilter(item.stats, item.info, item.key)).sort((a, b) => {
    const ra = providerRank(a.stats, a.info, a.key);
    const rb = providerRank(b.stats, b.info, b.key);
    if (ra !== rb) return ra - rb;
    const noAuthDiff = (b.info.noAuth ? 1 : 0) - (a.info.noAuth ? 1 : 0);
    if (noAuthDiff !== 0) return noAuthDiff;
    // Trial providers (体验: opencode/mimo-free) cluster together
    // as one contiguous block at the end of their rank group, instead of
    // interleaving with the regular free-tier providers by priority/name.
    const ca = a.info.community ? 1 : 0;
    const cb = b.info.community ? 1 : 0;
    if (ca !== cb) return ca - cb;
    const oa = getCardOrderIndex(a.key);
    const ob = getCardOrderIndex(b.key);
    if (oa !== ob) return oa - ob;
    const pa = a.info.priority ?? 999;
    const pb = b.info.priority ?? 999;
    if (pa !== pb) return pa - pb;
    return (a.info.name || "").localeCompare(b.info.name || "");
  });
  // API Key: connected providers first, then alphabetical by name
  const apikeyEntries = Object.entries(APIKEY_PROVIDERS)
    .filter(
      ([, info]) =>
        !info.hidden &&
        (info.serviceKinds ?? ["llm"]).includes("llm") &&
        matchSearch(info.name),
    )
    .sort(([ka, a], [kb, b]) => {
      // Connection state first (connected providers surface first), then
      // priority, then name.
      const sa = getProviderStats(ka, "apikey");
      const sb = getProviderStats(kb, "apikey");
      const ra = providerRank(sa, a, ka);
      const rb = providerRank(sb, b, kb);
      if (ra !== rb) return ra - rb;
      const oa = getCardOrderIndex(ka);
      const ob = getCardOrderIndex(kb);
      if (oa !== ob) return oa - ob;
      const pa = a.priority ?? 999;
      const pb = b.priority ?? 999;
      if (pa !== pb) return pa - pb;
      return (a.name || "").localeCompare(b.name || "");
    })
    .filter(([k, info]) => matchesStatusFilter(getProviderStats(k, "apikey"), info, k));

  const customProviders = [...compatibleProviders, ...anthropicCompatibleProviders]
    .filter((p) => matchesStatusFilter(getProviderStats(p.id, "apikey"), null, p.id))
    .sort((a, b) => {
    const oa = getCardOrderIndex(a.id);
    const ob = getCardOrderIndex(b.id);
    if (oa !== ob) return oa - ob;
    return (a.name || "").localeCompare(b.name || "");
  });

  const allDisplayKeys = useCallback(() => {
    const keys = [];
    for (const p of [...compatibleProviders, ...anthropicCompatibleProviders]) {
      if (!keys.includes(p.id)) keys.push(p.id);
    }
    for (const [k] of oauthEntries) {
      if (!keys.includes(k)) keys.push(k);
    }
    for (const item of freeAllEntries) {
      if (!keys.includes(item.key)) keys.push(item.key);
    }
    for (const [k] of apikeyEntries) {
      if (!keys.includes(k)) keys.push(k);
    }
    return keys;
  }, [compatibleProviders, anthropicCompatibleProviders, oauthEntries, freeAllEntries, apikeyEntries]);

  const handleCardDrop = useCallback(
    (targetId) => {
      const sourceId = draggingCardId;
      setDraggingCardId(null);
      setDragOverCardId(null);
      if (!sourceId || !targetId || sourceId === targetId) return;

      setCardOrder((prev) => {
        // Shared reorder math (merge known keys → splice) lives in
        // shared/utils/providerCardOrder.js so every surface stays identical.
        const base = moveCardInOrder(prev, allDisplayKeys(), sourceId, targetId);
        if (base === prev) return prev;
        saveProviderCardOrder(base).catch((err) =>
          console.log("Failed to save provider card order:", err),
        );
        return base;
      });
    },
    [draggingCardId, allDisplayKeys],
  );
  const isApikeySearching = !!searchQuery.trim();
  const visibleApikeyEntries =
    isApikeySearching || showAllApikey
      ? apikeyEntries
      : apikeyEntries.slice(0, APIKEY_INITIAL_VISIBLE);
  const hiddenApikeyCount = apikeyEntries.length - APIKEY_INITIAL_VISIBLE;

  if (loading) {
    return (
      <div className="flex flex-col gap-8">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  // Reads the FILTERED lists (customProviders is the merged+filtered custom
  // set), so a status filter that hides everything surfaces the empty state
  // instead of four blank section headers.
  const hasAnyResult =
    oauthEntries.length > 0 ||
    freeAllEntries.length > 0 ||
    apikeyEntries.length > 0 ||
    customProviders.length > 0;

  const activeStatusOption =
    STATUS_FILTER_OPTIONS.find((o) => o.value === statusFilter) || STATUS_FILTER_OPTIONS[0];

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      {/* Connection-status filter for the whole wall. A Popover menu in the
          dashboard's own control language (surface panel + item rows), not a
          native <select> — the OS chrome of a select is the one visual
          dialect this UI does not speak, and its option text would skip
          translate() entirely. */}
      <div className="flex items-center justify-end gap-2">
        <div className="relative">
          <button
            type="button"
            onClick={() => setStatusFilterOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={statusFilterOpen}
            title={translate("Filter providers by connection status")}
            aria-label={translate("Filter providers by connection status")}
            className={`flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition-colors ${
              statusFilter === "all"
                ? "border-black/10 bg-surface text-text-muted hover:bg-black/[0.04] dark:border-white/10 dark:hover:bg-white/[0.06]"
                : "border-primary/30 bg-primary/10 text-primary"
            }`}
          >
            <span className="material-symbols-outlined text-[16px] leading-none">
              {activeStatusOption.icon}
            </span>
            <span>{translate(activeStatusOption.label)}</span>
            <span className="material-symbols-outlined text-[14px] leading-none text-text-muted">
              expand_more
            </span>
          </button>
          <Popover
            open={statusFilterOpen}
            onClose={() => setStatusFilterOpen(false)}
            align="right"
            className="w-48"
          >
            {STATUS_FILTER_OPTIONS.map((option) => (
              <MenuItem
                key={option.value}
                selected={statusFilter === option.value}
                icon={
                  <span className="material-symbols-outlined mt-px text-[16px] leading-none text-text-muted">
                    {option.icon}
                  </span>
                }
                onClick={() => {
                  setStatusFilter(option.value);
                  setStatusFilterOpen(false);
                }}
              >
                {translate(option.label)}
              </MenuItem>
            ))}
          </Popover>
        </div>
      </div>
      {!hasAnyResult && (
        <div className="text-center py-8 border border-dashed border-border rounded-xl">
          <span className="material-symbols-outlined text-[32px] text-text-muted mb-2">
            search_off
          </span>
          <p className="text-text-muted text-sm">
            {statusFilter !== "all" && !searchQuery.trim()
              ? translate("No providers match this filter")
              : translate("No providers match your search")}
          </p>
        </div>
      )}

      {/* Custom Providers (OpenAI/Anthropic Compatible) — dynamic */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-lg sm:text-xl font-semibold flex items-center gap-2 leading-tight">
            Custom Providers (OpenAI/Anthropic Compatible){" "}
          </h2>
          <div className="grid grid-cols-1 gap-2 sm:flex sm:w-auto">
            <Button
              size="sm"
              icon="add"
              onClick={() => setShowAddAnthropicCompatibleModal(true)}
              className="w-full sm:w-auto"
            >
              Add Anthropic Compatible
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon="add"
              onClick={() => setShowAddCompatibleModal(true)}
              className="w-full !bg-white !text-black hover:!bg-gray-100 sm:w-auto"
            >
              Add OpenAI Compatible
            </Button>
          </div>
        </div>
        {customProviders.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-2 border border-dashed border-border rounded-xl text-text-muted text-sm">
            <span className="material-symbols-outlined text-[18px]">extension</span>
            <span>
              {statusFilter !== "all"
                ? translate("No custom providers match this filter")
                : "No custom providers — use buttons above to add OpenAI/Anthropic compatible endpoints"}
            </span>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">
            {customProviders.map((info) => (
              <DraggableCardWrapper
                key={info.id}
                cardId={info.id}
                isDragging={draggingCardId === info.id}
                isOver={dragOverCardId === info.id}
                onDragStart={setDraggingCardId}
                onDragOver={setDragOverCardId}
                onDrop={handleCardDrop}
                onDragEnd={() => {
                  setDraggingCardId(null);
                  setDragOverCardId(null);
                }}
              >
                <ApiKeyProviderCard
                  providerId={info.id}
                  provider={info}
                  stats={getProviderStats(info.id, "apikey")}
                  authType="compatible"
                  onToggle={(active) =>
                    handleToggleProvider(info.id, "apikey", active)
                  }
                />
              </DraggableCardWrapper>
            ))}
          </div>
        )}
      </div>

      {/* OAuth Providers */}
      {oauthEntries.length > 0 && (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-lg sm:text-xl font-semibold flex items-center gap-2 leading-tight">
            OAuth Providers
          </h2>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            <ModelAvailabilityBadge />
            <button
              onClick={() => handleBatchTest("oauth")}
              disabled={!!testingMode}
              className={`flex w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors sm:w-auto sm:py-1.5 ${
                testingMode === "oauth"
                  ? "bg-primary/20 border-primary/40 text-primary animate-pulse"
                  : "bg-bg border-border text-text-muted hover:text-text-main hover:border-primary/40"
              }`}
              title={translate("Test all OAuth connections")}
              aria-label={translate("Test all OAuth connections")}
            >
              <span
                className={`material-symbols-outlined text-[14px]${testingMode === "oauth" ? " animate-spin" : ""}`}
              >
                play_arrow
              </span>
              {testingMode === "oauth" ? translate("Testing...") : translate("Test All")}
            </button>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">
          {oauthEntries.map(([key, info]) => {
            const authTypes = dualAuthTypes(info, key);
            return (
              <DraggableCardWrapper
                key={key}
                cardId={key}
                isDragging={draggingCardId === key}
                isOver={dragOverCardId === key}
                onDragStart={setDraggingCardId}
                onDragOver={setDragOverCardId}
                onDrop={handleCardDrop}
                onDragEnd={() => {
                  setDraggingCardId(null);
                  setDragOverCardId(null);
                }}
              >
                <ProviderCard
                  providerId={key}
                  provider={info}
                  stats={getProviderStats(key, authTypes)}
                  authType="oauth"
                  onToggle={(active) => handleToggleProvider(key, authTypes, active)}
                />
              </DraggableCardWrapper>
            );
          })}
        </div>
      </div>
      )}

      {/* Free Tier Providers */}
      {freeAllEntries.length > 0 && (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-lg sm:text-xl font-semibold flex items-center gap-2 leading-tight">
            Free Tier Providers
          </h2>
          <button
            onClick={() => handleBatchTest("free")}
            disabled={!!testingMode}
            className={`flex w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors sm:w-auto sm:py-1.5 ${
              testingMode === "free"
                ? "bg-primary/20 border-primary/40 text-primary animate-pulse"
                : "bg-bg border-border text-text-muted hover:text-text-main hover:border-primary/40"
            }`}
            title={translate("Test all Free connections")}
            aria-label={translate("Test all Free provider connections")}
          >
            <span
              className={`material-symbols-outlined text-[14px]${testingMode === "free" ? " animate-spin" : ""}`}
            >
              play_arrow
            </span>
            {testingMode === "free" ? translate("Testing...") : translate("Test All")}
          </button>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">
          {freeAllEntries.map(({ key, info, isFreeTier }) => {
            const freeAuthTypes = dualAuthTypes(info, key);
            // noAuth free providers (opencode, mimo-free) get a topology
            // visibility toggle instead of an enable/disable switch.
            const topologySetting = topologyVisibility?.[key];
            const topologyVisible =
              topologySetting === false
                ? false
                : topologySetting === true
                  ? true
                  : !info.topologyHiddenByDefault;
            return (
              <DraggableCardWrapper
                key={key}
                cardId={key}
                isDragging={draggingCardId === key}
                isOver={dragOverCardId === key}
                onDragStart={setDraggingCardId}
                onDragOver={setDragOverCardId}
                onDrop={handleCardDrop}
                onDragEnd={() => {
                  setDraggingCardId(null);
                  setDragOverCardId(null);
                }}
              >
                {!isFreeTier ? (
                  <ProviderCard
                    providerId={key}
                    provider={info}
                    stats={getProviderStats(key, freeAuthTypes)}
                    authType="free"
                    onToggle={(active) =>
                      handleToggleProvider(key, freeAuthTypes, active)
                    }
                    topologyVisible={topologyVisible}
                    onToggleTopology={
                      info.noAuth
                        ? (visible) => handleToggleTopology(key, visible)
                        : undefined
                    }
                  />
                ) : (
                  <ApiKeyProviderCard
                    providerId={key}
                    provider={info}
                    stats={getProviderStats(key, freeAuthTypes)}
                    authType={Array.isArray(freeAuthTypes) ? (freeAuthTypes[0] ?? "apikey") : freeAuthTypes}
                    onToggle={(active) => handleToggleProvider(key, freeAuthTypes, active)}
                  />
                )}
              </DraggableCardWrapper>
            );
          })}
        </div>
      </div>
      )}

      {/* API Key Providers — fixed list */}
      {apikeyEntries.length > 0 && (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-lg sm:text-xl font-semibold flex items-center gap-2 leading-tight">
            API Key Providers{" "}
          </h2>
          <button
            onClick={() => handleBatchTest("apikey")}
            disabled={!!testingMode}
            className={`flex w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors sm:w-auto sm:py-1.5 ${
              testingMode === "apikey"
                ? "bg-primary/20 border-primary/40 text-primary animate-pulse"
                : "bg-bg border-border text-text-muted hover:text-text-main hover:border-primary/40"
            }`}
            title={translate("Test all API Key connections")}
            aria-label={translate("Test all API Key connections")}
          >
            <span
              className={`material-symbols-outlined text-[14px]${testingMode === "apikey" ? " animate-spin" : ""}`}
            >
              play_arrow
            </span>
            {testingMode === "apikey" ? translate("Testing...") : translate("Test All")}
          </button>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">
          {visibleApikeyEntries.map(([key, info]) => (
            <DraggableCardWrapper
              key={key}
              cardId={key}
              isDragging={draggingCardId === key}
              isOver={dragOverCardId === key}
              onDragStart={setDraggingCardId}
              onDragOver={setDragOverCardId}
              onDrop={handleCardDrop}
              onDragEnd={() => {
                setDraggingCardId(null);
                setDragOverCardId(null);
              }}
            >
              <ApiKeyProviderCard
                providerId={key}
                provider={info}
                stats={getProviderStats(key, "apikey")}
                authType="apikey"
                onToggle={(active) => handleToggleProvider(key, "apikey", active)}
              />
            </DraggableCardWrapper>
          ))}
        </div>
        {!isApikeySearching && !showAllApikey && hiddenApikeyCount > 0 && (
          <button
            onClick={() => setShowAllApikey(true)}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-primary/40 px-3 py-2.5 text-sm font-medium text-primary transition-colors hover:border-primary hover:bg-primary/5"
          >
            <span className="material-symbols-outlined text-[16px]">expand_more</span>
            Show all {apikeyEntries.length} providers
          </button>
        )}
      </div>
      )}

      {/* Web Cookie Providers — use browser subscription cookie instead of API key */}
      {/* <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            Web Cookie Providers{" "}
          </h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {Object.entries(WEB_COOKIE_PROVIDERS).map(([key, info]) => (
            <ApiKeyProviderCard
              key={key}
              providerId={key}
              provider={info}
              stats={getProviderStats(key, "apikey")}
              authType="apikey"
              onToggle={(active) => handleToggleProvider(key, "apikey", active)}
            />
          ))}
        </div>
      </div> */}

      <AddCompatibleModal
        variant="openai"
        isOpen={showAddCompatibleModal}
        onClose={() => setShowAddCompatibleModal(false)}
        onCreated={(node) => {
          setProviderNodes((prev) => [...prev, node]);
          setShowAddCompatibleModal(false);
        }}
      />
      <AddCompatibleModal
        variant="anthropic"
        isOpen={showAddAnthropicCompatibleModal}
        onClose={() => setShowAddAnthropicCompatibleModal(false)}
        onCreated={(node) => {
          setProviderNodes((prev) => [...prev, node]);
          setShowAddAnthropicCompatibleModal(false);
        }}
      />

      {/* Test Results Modal */}
      {testResults && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center px-3 pt-[6vh] sm:pt-[10vh]"
          onClick={() => setTestResults(null)}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div
            className="relative bg-surface border border-border rounded-xl w-full max-w-[600px] max-h-[86vh] sm:max-h-[80vh] overflow-y-auto shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-3 border-b border-border bg-surface/95 backdrop-blur-sm rounded-t-xl">
              <h3 className="font-semibold">{translate("Test Results")}</h3>
              <button
                onClick={() => setTestResults(null)}
                className="p-1 rounded-lg hover:bg-bg text-text-muted hover:text-text-main transition-colors"
                aria-label={translate("Close")}
              >
                <span className="material-symbols-outlined text-lg">close</span>
              </button>
            </div>
            <div className="p-5">
              <ProviderTestResultsView results={testResults} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// (Aliased to the shared DraggableCard at module top level.)

function ProviderCard({ providerId, provider, stats, authType, onToggle, topologyVisible, onToggleTopology }) {
  const { connected, error, errorCode, errorTime, allDisabled } = stats;
  const isNoAuth = !!provider.noAuth;

  const dotColors = {
    free: "bg-green-500",
    oauth: "bg-blue-500",
    apikey: "bg-amber-500",
    compatible: "bg-orange-500",
  };
  const dotLabels = {
    free: "Free",
    oauth: "OAuth",
    apikey: "API Key",
    compatible: "Compatible",
  };

  // noAuth free providers have no connections, so they can't be enabled/disabled
  // in the usual sense. Instead the toggle controls whether they appear on the
  // usage topology canvas.
  const hasConnection = stats.total > 0;
  const topologyToggleable = isNoAuth && typeof onToggleTopology === "function";
  const topologyOn = topologyVisible !== false;

  return (
    <Link href={`/dashboard/providers/${providerId}`} className="group min-w-0">
      <Card
        padding="xs"
        className={`h-full hover:bg-black/[0.01] dark:hover:bg-white/[0.01] transition-colors cursor-pointer ${allDisabled || (topologyToggleable && !topologyOn) ? "opacity-50" : ""}`}
      >
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div
              className="size-8 shrink-0 rounded-lg flex items-center justify-center"
              style={{
                backgroundColor: `${provider.color?.length > 7 ? provider.color : provider.color + "15"}`,
              }}
            >
              <ProviderIcon
                src={`/providers/${provider.id}.png`}
                providerId={provider.id}
                alt={provider.name}
                size={30}
                className="object-contain rounded-lg max-w-[32px] max-h-[32px]"
                fallbackText={
                  provider.textIcon || provider.id.slice(0, 2).toUpperCase()
                }
                fallbackColor={provider.color}
              />
            </div>
            <div className="min-w-0">
              <h3 className="truncate font-semibold flex items-center gap-1.5">
                {provider.name}
                {provider.community && (
                  <Badge variant="warning" size="sm" className="shrink-0">
                    {translate("Trial")}
                  </Badge>
                )}
              </h3>
              <div className="flex min-w-0 items-center gap-1.5 text-xs flex-wrap">
                {allDisabled ? (
                  <Badge variant="default" size="sm">
                    <span className="flex items-center gap-1">
                      <span className="material-symbols-outlined text-[12px]">
                        pause_circle
                      </span>
                      {translate("Disabled")}
                    </span>
                  </Badge>
                ) : isNoAuth ? (
                  topologyOn ? (
                    <Badge variant="success" size="sm" dot>{translate("Ready")}</Badge>
                  ) : (
                    <Badge variant="default" size="sm">{translate("Topology off")}</Badge>
                  )
                ) : (
                  <>
                    {getStatusDisplay(connected, error, errorCode)}
                    {errorTime && (
                      <span className="text-text-muted">{errorTime}</span>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {hasConnection && (
              <div
                className="opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onToggle(!allDisabled ? false : true);
                }}
              >
                <Toggle
                  size="sm"
                  checked={!allDisabled}
                  onChange={() => {}}
                  title={allDisabled ? translate("Enable provider") : translate("Disable provider")}
                />
              </div>
            )}
            {topologyToggleable && (
              <div
                className="opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onToggleTopology(!topologyOn);
                }}
              >
                <Toggle
                  size="sm"
                  checked={topologyOn}
                  onChange={() => {}}
                  title={
                    topologyOn
                      ? "Hide from usage topology"
                      : "Show on usage topology"
                  }
                />
              </div>
            )}
          </div>
        </div>
      </Card>
    </Link>
  );
}

ProviderCard.propTypes = {
  providerId: PropTypes.string.isRequired,
  provider: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string.isRequired,
    color: PropTypes.string,
    textIcon: PropTypes.string,
  }).isRequired,
  stats: PropTypes.shape({
    connected: PropTypes.number,
    error: PropTypes.number,
    errorCode: PropTypes.string,
    errorTime: PropTypes.string,
  }).isRequired,
  authType: PropTypes.string,
  onToggle: PropTypes.func,
};

function ApiKeyProviderCard({
  providerId,
  provider,
  stats,
  authType,
  onToggle,
}) {
  const { connected, error, errorCode, errorTime, allDisabled } = stats;
  const isCompatible = providerId.startsWith(OPENAI_COMPATIBLE_PREFIX);
  const isAnthropicCompatible = providerId.startsWith(
    ANTHROPIC_COMPATIBLE_PREFIX,
  );

  const dotColors = {
    free: "bg-green-500",
    oauth: "bg-blue-500",
    apikey: "bg-amber-500",
    compatible: "bg-orange-500",
  };
  const dotLabels = {
    free: "Free",
    oauth: "OAuth",
    apikey: "API Key",
    compatible: "Compatible",
  };

  const getIconPath = () => {
    if (isCompatible && provider.apiType)
      return provider.apiType === "responses"
        ? "/providers/oai-r.png"
        : "/providers/oai-cc.png";
    if (isAnthropicCompatible) return "/providers/anthropic-m.png";
    return getProviderIconSrc(provider.id);
  };

  return (
    <Link href={`/dashboard/providers/${providerId}`} className="group min-w-0">
      <Card
        padding="xs"
        className={`h-full hover:bg-black/[0.01] dark:hover:bg-white/[0.01] transition-colors cursor-pointer ${allDisabled ? "opacity-50" : ""}`}
      >
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div
              className="size-8 shrink-0 rounded-lg flex items-center justify-center"
              style={{
                backgroundColor: `${provider.color?.length > 7 ? provider.color : provider.color + "15"}`,
              }}
            >
              <ProviderIcon
                src={getIconPath()}
                providerId={provider.id}
                alt={provider.name}
                size={30}
                className="object-contain rounded-lg max-w-[30px] max-h-[30px]"
                fallbackText={
                  provider.textIcon || provider.id.slice(0, 2).toUpperCase()
                }
                fallbackColor={provider.color}
              />
            </div>
            <div className="min-w-0">
              <h3 className="truncate font-semibold flex items-center gap-1.5">
                {provider.name}
                {provider.community && (
                  <Badge variant="warning" size="sm" className="shrink-0">
                    {translate("Trial")}
                  </Badge>
                )}
              </h3>
              <div className="flex min-w-0 items-center gap-1.5 text-xs flex-wrap">
                {allDisabled ? (
                  <Badge variant="default" size="sm">
                    <span className="flex items-center gap-1">
                      <span className="material-symbols-outlined text-[12px]">
                        pause_circle
                      </span>
                      {translate("Disabled")}
                    </span>
                  </Badge>
                ) : (
                  <>
                    {getStatusDisplay(connected, error, errorCode)}
                    {isCompatible && (
                      <Badge variant="default" size="sm">
                        {provider.apiType === "responses"
                          ? "Responses"
                          : "Chat"}
                      </Badge>
                    )}
                    {isAnthropicCompatible && (
                      <Badge variant="default" size="sm">
                        Messages
                      </Badge>
                    )}
                    {errorTime && (
                      <span className="text-text-muted">{errorTime}</span>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {stats.total > 0 && (
              <div
                className="opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onToggle(!allDisabled ? false : true);
                }}
              >
                <Toggle
                  size="sm"
                  checked={!allDisabled}
                  onChange={() => {}}
                  title={allDisabled ? translate("Enable provider") : translate("Disable provider")}
                />
              </div>
            )}
          </div>
        </div>
      </Card>
    </Link>
  );
}

ApiKeyProviderCard.propTypes = {
  providerId: PropTypes.string.isRequired,
  provider: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string.isRequired,
    color: PropTypes.string,
    textIcon: PropTypes.string,
    apiType: PropTypes.string,
  }).isRequired,
  stats: PropTypes.shape({
    connected: PropTypes.number,
    error: PropTypes.number,
    errorCode: PropTypes.string,
    errorTime: PropTypes.string,
  }).isRequired,
  authType: PropTypes.string,
  onToggle: PropTypes.func,
};

function ProviderTestResultsView({ results }) {
  if (results.error && !results.results) {
    return (
      <div className="text-center py-6">
        <span className="material-symbols-outlined text-red-500 text-[32px] mb-2 block">
          error
        </span>
        <p className="text-sm text-red-400">{results.error}</p>
      </div>
    );
  }

  const { summary, mode } = results;
  const items = results.results || [];
  const modeLabel =
    {
      oauth: "OAuth",
      free: translate("Free"),
      apikey: translate("API Key"),
      provider: translate("Provider"),
      all: translate("All"),
    }[mode] || mode;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {summary && (
        <div className="flex flex-wrap items-center gap-2 text-xs mb-1 sm:gap-3">
          <span className="text-text-muted">{modeLabel} {translate("Test")}</span>
          <span className="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-medium">
            {summary.passed} {translate("passed")}
          </span>
          {summary.failed > 0 && (
            <span className="px-2 py-0.5 rounded bg-red-500/15 text-red-400 font-medium">
              {summary.failed} {translate("failed")}
            </span>
          )}
          <span className="text-text-muted sm:ml-auto">
            {summary.total} {translate("tested")}
          </span>
        </div>
      )}
      {items.map((r, i) => (
        <div
          key={r.connectionId || i}
          className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg bg-black/[0.03] px-3 py-2 text-xs dark:bg-white/[0.03] sm:flex-nowrap"
        >
          <span
            className={`material-symbols-outlined text-[16px] ${r.valid ? "text-emerald-500" : "text-red-500"}`}
          >
            {r.valid ? "check_circle" : "error"}
          </span>
          <div className="min-w-0 flex-[1_1_160px]">
            <span className="block truncate font-medium sm:inline">
              {r.connectionName}
            </span>
            <span className="block truncate text-text-muted sm:ml-1.5 sm:inline">
              ({r.provider})
            </span>
          </div>
          {r.latencyMs !== undefined && (
            <span className="shrink-0 text-text-muted font-mono tabular-nums">
              {r.latencyMs}ms
            </span>
          )}
          <span
            className={`shrink-0 text-[10px] uppercase font-bold px-1.5 py-0.5 rounded ${
              r.valid
                ? "bg-emerald-500/15 text-emerald-400"
                : "bg-red-500/15 text-red-400"
            }`}
          >
            {r.valid ? translate("OK") : r.diagnosis?.type || translate("ERROR")}
          </span>
        </div>
      ))}
      {items.length === 0 && (
        <div className="text-center py-4 text-text-muted text-sm">
          {translate("No active connections found for this group.")}
        </div>
      )}
    </div>
  );
}

ProviderTestResultsView.propTypes = {
  results: PropTypes.shape({
    mode: PropTypes.string,
    results: PropTypes.array,
    summary: PropTypes.shape({
      total: PropTypes.number,
      passed: PropTypes.number,
      failed: PropTypes.number,
    }),
    error: PropTypes.string,
  }).isRequired,
};
