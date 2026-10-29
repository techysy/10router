"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { getProviderIconSrc, markProviderIconMissing } from "@/shared/utils/providerIcon";
import { Card, Button, Badge, Input, Modal, CardSkeleton, OAuthModal, KiroOAuthWrapper, CursorAuthModal, ZedAuthModal, XiaomiMimoAuthModal, IFlowCookieModal, GitLabAuthModal, Toggle, Select, EditConnectionModal, NoAuthProxyCard, ConfirmModal, InviteCodeChip, Tooltip } from "@/shared/components";
import { OAUTH_PROVIDERS, APIKEY_PROVIDERS, FREE_PROVIDERS, FREE_TIER_PROVIDERS, WEB_COOKIE_PROVIDERS, getProviderAlias, isOpenAICompatibleProvider, isAnthropicCompatibleProvider, AI_PROVIDERS } from "@/shared/constants/providers";
import { getModelsByProviderId, getModelKind } from "@/shared/constants/models";
import { mergeQoderLivePricing } from "@/shared/utils/qoderLivePricing";
import OffPeakBanner from "./OffPeakBanner";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { useModelCaps } from "@/shared/hooks/useModelCaps";
import { translate } from "@/i18n/runtime";
import { useNotificationStore } from "@/store/notificationStore";
import { fetchSuggestedModels } from "@/shared/utils/providerModelsFetcher";
import { getProviderCustomModelRows } from "@/shared/utils/providerCustomModels";
import { extractAccountsVerificationUrl } from "@/shared/utils/validationUrl";
import { translateQuotaError } from "@/shared/utils/quotaError";
import { cn } from "@/shared/utils/cn";
import ModelRow from "./ModelRow";
import PassthroughModelsSection from "./PassthroughModelsSection";
import CompatibleModelsSection from "./CompatibleModelsSection";
import ConnectionRow from "./ConnectionRow";
import AddApiKeyModal from "./AddApiKeyModal";
import EditCompatibleNodeModal from "./EditCompatibleNodeModal";
import AddCustomModelModal from "./AddCustomModelModal";
import BulkImportCodexModal from "./BulkImportCodexModal";
import CodeBuddyImportModal from "./CodeBuddyImportModal";
import OAuthTransferModal from "./OAuthTransferModal";
import AutoPingScheduleModal from "./AutoPingScheduleModal";
import { getScheduleSlotLabels } from "@/shared/services/quotaPingSchedule";
import { getProviderQuotaCategory, PROVIDER_QUOTA_TYPES } from "open-sse/config/providerCategories.js";

const ONE_BY_ONE_DELAY_MS = 1000;

const AUTO_PING_SETTINGS_KEYS = {
  claude: "claudeAutoPing",
  codex: "codexAutoPing",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatModelTestError(error) {
  if (!error) return "";
  const quotaFriendly = translateQuotaError(error);
  if (quotaFriendly && quotaFriendly !== error) return quotaFriendly;
  const direct = translate(error);
  if (direct && direct !== error) return direct;

  const match = String(error).match(/^HTTP\s+\d+:\s*(?:\[(?:\d+|[A-Z0-9_]+)\]:\s*)?(.*)$/i);
  if (match && match[1]) {
    const inner = match[1].trim();
    const translatedInner = translate(inner);
    if (translatedInner && translatedInner !== inner) {
      return translatedInner;
    }
  }

  return translate(error);
}

export default function ProviderDetailPage() {
  const params = useParams();
  const router = useRouter();
  const providerId = params.id;
  const { getCaps, getBaseCaps, overrides, refresh } = useModelCaps();
  const notify = useNotificationStore();
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [providerNode, setProviderNode] = useState(null);
  const [proxyPools, setProxyPools] = useState([]);
  const [showOAuthModal, setShowOAuthModal] = useState(false);
  const [showXiaomiMimoModal, setShowXiaomiMimoModal] = useState(false);
  const [showIFlowCookieModal, setShowIFlowCookieModal] = useState(false);
  const [showAddApiKeyModal, setShowAddApiKeyModal] = useState(false);
  const [addConnectionError, setAddConnectionError] = useState("");
  const [showBulkImportCodex, setShowBulkImportCodex] = useState(false);
  const [showCodeBuddyImport, setShowCodeBuddyImport] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showEditNodeModal, setShowEditNodeModal] = useState(false);
  const [showBulkProxyModal, setShowBulkProxyModal] = useState(false);
  const [selectedConnection, setSelectedConnection] = useState(null);
  const [modelAliases, setModelAliases] = useState({});
  const [customModels, setCustomModels] = useState([]);
  const [oauthTransferEnabled, setOauthTransferEnabled] = useState(false); // per-provider toggle (falls back to legacy global)
  const [codeBuddyCheckinEnabled, setCodeBuddyCheckinEnabled] = useState(false); // experimental auto daily check-in toggle
  const [codeBuddyCompensationEnabled, setCodeBuddyCompensationEnabled] = useState(false); // experimental auto compensation toggle
  // cbcn check-in manual trigger: running flag (per-account results go to the
  // summary toast + [CB_CN_CHECKIN] server log, not an inline list).
  const [cbCheckinRunning, setCbCheckinRunning] = useState(false);
  const [cbCompRunning, setCbCompRunning] = useState(false);
  const [qoderCheckinRunning, setQoderCheckinRunning] = useState(false);
  // cbcn export/import re-auth: { open, action: 'export'|'import', value }
  const [cbPw, setCbPw] = useState({ open: false, action: null, value: "" });
  const [cbPwVerifying, setCbPwVerifying] = useState(false);
  const [cbPwError, setCbPwError] = useState("");
  const [cbImportPassword, setCbImportPassword] = useState(""); // password for bulk-import (passed to modal)
  const [headerImgError, setHeaderImgError] = useState(false);
  const [modelTestResults, setModelTestResults] = useState({});
  const [modelsTestError, setModelsTestError] = useState("");
  const [testingModelIds, setTestingModelIds] = useState(() => new Set());
  const [showAddCustomModel, setShowAddCustomModel] = useState(false);
  const [selectedConnectionIds, setSelectedConnectionIds] = useState([]);
  const [bulkProxyPoolId, setBulkProxyPoolId] = useState("__none__");
  const [bulkUpdatingProxy, setBulkUpdatingProxy] = useState(false);
  const [providerStrategy, setProviderStrategy] = useState(null);
  const [providerStickyLimit, setProviderStickyLimit] = useState("");
  const [earliestExpiryFirst, setEarliestExpiryFirst] = useState(false);
  const [balanceStrategy, setBalanceStrategy] = useState("priority");
  const [thinkingMode, setThinkingMode] = useState("auto");
  const [autoPing, setAutoPing] = useState({ enabled: false, connections: {} });
  const [suggestedModels, setSuggestedModels] = useState([]);
  const [officialModelsRefreshing, setOfficialModelsRefreshing] = useState(false);
  const [liveModels, setLiveModels] = useState([]);
  const [kiloFreeModels, setKiloFreeModels] = useState([]);
  const [disabledModelIds, setDisabledModelIds] = useState([]);
  const [confirmState, setConfirmState] = useState(null);
  const [showAgRiskModal, setShowAgRiskModal] = useState(false);
  const [oneByOneRunning, setOneByOneRunning] = useState(false);
  const [oneByOneStopping, setOneByOneStopping] = useState(false);
  // Model sent with each one-by-one probe. The sentinel (not "") because Select
  // always renders a disabled placeholder option on value="" — a real "" option
  // would be shadowed by it. The test route treats an absent body.model as
  // "provider default". Needed because some credentials only accept a subset of
  // ids (e.g. mimo-desktop: its session reaches the desktop models only).
  const ONE_BY_ONE_DEFAULT_MODEL = "__provider_default__";
  const [oneByOneModel, setOneByOneModel] = useState(ONE_BY_ONE_DEFAULT_MODEL);
  const [oneByOneCurrentConnectionId, setOneByOneCurrentConnectionId] = useState(null);
  const [oneByOneResults, setOneByOneResults] = useState({});
  const [oneByOneSummary, setOneByOneSummary] = useState(null);
  const stopOneByOneRef = useRef(false);
  const [importingQoderModels, setImportingQoderModels] = useState(false);
  const { copied, copy } = useCopyToClipboard();

  const AG_RISK_STORAGE_KEY = "ag_risk_confirmed";

  const openOAuthConnection = () => {
    // Both Xiaomi MiMo cards support the same connect surface and share a local-credential
    // flow, so they get this dedicated modal instead of the generic PKCE one. The modal is
    // told which card it was opened for and creates the connection under that id.
    if (providerId === "xiaomi-mimo" || providerId === "mimo-desktop") {
      setShowXiaomiMimoModal(true);
      return;
    }
    setShowOAuthModal(true);
  };

  const triggerOAuthConnection = () => {
    if (providerId === "antigravity" && typeof window !== "undefined") {
      const confirmed = window.localStorage.getItem(AG_RISK_STORAGE_KEY) === "true";
      if (!confirmed) {
        setShowAgRiskModal(true);
        return;
      }
    }
    if (isOAuth) {
      openOAuthConnection();
      return;
    }
    setAddConnectionError("");
    setShowAddApiKeyModal(true);
  };

  const triggerApiKeyConnection = () => {
    setAddConnectionError("");
    setShowAddApiKeyModal(true);
  };

  const triggerAddConnection = () => {
    if (isOAuth) {
      triggerOAuthConnection();
      return;
    }
    triggerApiKeyConnection();
  };

  // Password-confirm modal for the OAuth transfer export gate. The dashboard
  // password is VERIFIED HERE (preflight), so a wrong password errors in this
  // dialog — never two steps later inside the passphrase modal.
  const handleCbPwConfirm = async () => {
    if (cbPwVerifying) return;
    setCbPwVerifying(true);
    setCbPwError("");
    try {
      const res = await fetch("/api/auth/verify-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: cbPw.value }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setCbPwError(data?.error || translate("Invalid password"));
        return;
      }
      const { action, value: verifiedPassword } = cbPw;
      setCbPw({ open: false, action: null, value: "" });
      if (action === "export") {
        setOauthTransferPassword(verifiedPassword);
        setOauthTransferMode(action);
        setShowOAuthTransfer(true);
      }
    } catch (error) {
      setCbPwError(error.message || translate("Invalid password"));
    } finally {
      setCbPwVerifying(false);
    }
  };

  const openCbPassword = (action) => {
    setCbImportPassword("");
    setCbPw({ open: true, action, value: "" });
  };

  // Generic encrypted OAuth credentials transfer (all OAuth providers, P2
  // sibling of the codebuddy-cn wb-format routes which stay API-compatible).
  const [showOAuthTransfer, setShowOAuthTransfer] = useState(false);
  const [oauthTransferMode, setOauthTransferMode] = useState("export");
  // The export route re-authenticates the dashboard password on every request
  // (defense in depth: the JWT cookie alone must not dump tokens). The
  // preflight dialog verifies the password first so a wrong one errors where
  // it was typed; on success we hand the verified value to the modal —
  // dropping this wiring makes EVERY export die with "Invalid password".
  const [oauthTransferPassword, setOauthTransferPassword] = useState("");
  const [scheduleConnection, setScheduleConnection] = useState(null);

  // Manual CodeBuddy CN daily check-in trigger (only shown when the auto
  // check-in experimental toggle is on). Per-account results surface via the
  // summary toast here and the [CB_CN_CHECKIN] server log — no inline list.
  const handleCodeBuddyCheckin = async () => {
    setCbCheckinRunning(true);
    try {
      const res = await fetch("/api/oauth/codebuddy-cn/checkin", {
        method: "POST",
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `Request failed: ${res.status}`);
      const list = Array.isArray(data?.results) ? data.results : [];
      if (list.length === 0) {
        notify.warning(translate("No CodeBuddy CN connections to check in"));
        return;
      }
      const okCount = list.filter((r) => r.status === "checked-in").length;
      const alreadyCount = list.filter((r) => r.status === "already").length;
      const failedCount = list.filter((r) => r.status === "failed").length;
      if (failedCount === 0) {
        notify.success(
          `${translate("Check-in complete")}: ${okCount} ${translate("checked-in")}, ${alreadyCount} ${translate("already checked in")}`
        );
      } else {
        notify.error(
          `${translate("Check-in complete with errors")}: ${failedCount} ${translate("failed")}`
        );
      }
    } catch (e) {
      notify.error(translate("Check-in failed") + ": " + e.message);
    } finally {
      setCbCheckinRunning(false);
    }
  };

  // Manual CodeBuddy CN compensation & gift claim trigger.
  const handleCodeBuddyCompensation = async () => {
    setCbCompRunning(true);
    try {
      const res = await fetch("/api/oauth/codebuddy-cn/claim-compensation", {
        method: "POST",
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `Request failed: ${res.status}`);
      const list = Array.isArray(data?.results) ? data.results : [];
      if (list.length === 0) {
        notify.warning(translate("No CodeBuddy CN connections found"));
        return;
      }
      const claimedList = list.filter((r) => r.status === "claimed");
      const alreadyList = list.filter((r) => r.status === "already");
      const noneList = list.filter((r) => r.status === "no-activity");
      const failedList = list.filter((r) => r.status === "failed");

      const totalCredits = claimedList.reduce((acc, cur) => acc + (cur.claimedAmount || 0), 0);

      if (claimedList.length > 0) {
        notify.success(
          `${translate("Claim successful")}: +${totalCredits} Credits (${claimedList.length} ${translate("accounts")})`
        );
      } else if (failedList.length > 0) {
        notify.error(
          `${translate("Claim failed")}: ${failedList.map(f => f.error).join(", ")}`
        );
      } else if (alreadyList.length > 0) {
        notify.info(translate("Compensation credits already claimed"));
      } else {
        notify.info(translate("No claimable activity available for this account"));
      }
    } catch (e) {
      notify.error(translate("Claim failed") + ": " + e.message);
    } finally {
      setCbCompRunning(false);
    }
  };

  // Check-in control block (button with hover note). Rendered in place of the
  // import/export buttons when the auto check-in toggle is on.
  const renderCbCheckinBlock = () => (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        icon="calendar_today"
        onClick={handleCodeBuddyCheckin}
        disabled={cbCheckinRunning}
        className="w-full sm:w-auto"
        title={translate("CodeBuddy CN auto-checks in daily (retries all day until confirmed)")}
      >
        {cbCheckinRunning ? translate("Checking in...") : translate("Check in now")}
      </Button>
      <Button
        size="sm"
        icon="redeem"
        variant="secondary"
        onClick={handleCodeBuddyCompensation}
        disabled={cbCompRunning}
        className="w-full sm:w-auto"
        title={translate("Claim extra compensation & gifts")}
      >
        {cbCompRunning ? translate("Claiming...") : translate("Claim Compensation")}
      </Button>
    </div>
  );

  // Qoder daily credits claim manual trigger.
  const handleQoderCheckin = async () => {
    setQoderCheckinRunning(true);
    try {
      // minimax-code / minimax-code-global share the generic [provider]/checkin
      // action route. minimax-free never reaches here: the button is not
      // rendered for it (its check-in lives inside CreditDaddy).
      const endpoint = providerId === "qoder-cn" ? "/api/oauth/qoder-cn/checkin" : providerId === "qoder" ? "/api/oauth/qoder/checkin" : `/api/oauth/${providerId}/checkin`;
      const res = await fetch(endpoint, {
        method: "POST",
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `Request failed: ${res.status}`);
      const list = Array.isArray(data?.results) ? data.results : [];
      if (list.length === 0) {
        notify.warning(translate("No active Qoder connections found"));
        return;
      }
      const checkedInList = list.filter((r) => r.status === "checked-in");
      const alreadyList = list.filter((r) => r.status === "already");
      // Accounts the deployment offers no claim campaign for at all (intl Qoder
      // currently returns only a "view details" promo). These are NOT failures
      // and NOT an "already claimed" — saying either read as a lie.
      const noneList = list.filter((r) => r.status === "no-activity");
      const failedList = list.filter((r) => r.status === "failed");

      const totalCredits = checkedInList.reduce((acc, cur) => acc + (cur.claimedAmount || 0), 0);

      if (checkedInList.length > 0) {
        notify.success(
          `${translate("Claim successful")}: +${totalCredits} Credits (${checkedInList.length} ${translate("accounts")})`
        );
      } else if (failedList.length > 0) {
        notify.error(
          `${translate("Claim failed")}: ${failedList.map(f => f.error).join(", ")}`
        );
      } else if (noneList.length > 0) {
        // Friendly, informational: nothing is broken and there is nothing to do.
        const suffix = alreadyList.length > 0
          ? ` / ${translate("Daily credits already claimed for today")} (${alreadyList.length} ${translate("accounts")})`
          : ` (${noneList.length} ${translate("accounts")})`;
        notify.info(translate("No claimable activity available for this account") + suffix);
      } else {
        notify.info(translate("Daily credits already claimed for today"));
      }
    } catch (e) {
      notify.error(translate("Claim failed") + ": " + e.message);
    } finally {
      setQoderCheckinRunning(false);
    }
  };

  const renderQoderCheckinBlock = () => (
    <Button
      size="sm"
      icon="redeem"
      variant="secondary"
      onClick={handleQoderCheckin}
      disabled={qoderCheckinRunning}
      className="w-full sm:w-auto"
      title={translate("Claim daily activity Credits")}
    >
      {qoderCheckinRunning ? translate("Claiming...") : translate("Claim Credits")}
    </Button>
  );

  const handleAgRiskConfirm = () => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(AG_RISK_STORAGE_KEY, "true");
    }
    setShowAgRiskModal(false);
    if (isOAuth) {
      openOAuthConnection();
      return;
    }
    triggerApiKeyConnection();
  };

  const providerInfo = providerNode
    ? {
        id: providerNode.id,
        name: providerNode.name || (providerNode.type === "anthropic-compatible" ? "Anthropic Compatible" : "OpenAI Compatible"),
        color: providerNode.type === "anthropic-compatible" ? "#D97757" : "#10A37F",
        textIcon: providerNode.type === "anthropic-compatible" ? "AC" : "OC",
        apiType: providerNode.apiType,
        baseUrl: providerNode.baseUrl,
        type: providerNode.type,
      }
    : (OAUTH_PROVIDERS[providerId] || APIKEY_PROVIDERS[providerId] || FREE_PROVIDERS[providerId] || FREE_TIER_PROVIDERS[providerId] || WEB_COOKIE_PROVIDERS[providerId]);
  const authModes = providerInfo?.authModes || [];
  const isOAuth = !!OAUTH_PROVIDERS[providerId] || !!FREE_PROVIDERS[providerId] || authModes.includes("oauth");
  const supportsApiKeyAuth = !!APIKEY_PROVIDERS[providerId] || authModes.includes("apikey");
  const isFreeNoAuth = !!FREE_PROVIDERS[providerId]?.noAuth;
  const isCodeBuddy = providerId === "codebuddy-cn";
  // Generic OAuth transfer: every provider whose registry declares an oauth
  // auth mode (not just codebuddy). When CN check-in is on it hides the
  // buttons in favor of the check-in block — surface a reminder then.
  const oauthTransferOn = isOAuth && providerInfo?.authModes?.includes("oauth") && oauthTransferEnabled;
  // Experimental auto daily check-in / compensation — mutually exclusive display vs import/export.
  const codeBuddyCheckinOn = isCodeBuddy && (codeBuddyCheckinEnabled || codeBuddyCompensationEnabled);
  // Manual claim / check-in button (Qoder credits, MiniMax Code daily sign-in).
  // Must appear in every action row — single-auth providers (minimax-code is
  // OAuth-only) take the non-dual branch, which once lacked it.
  const hasClaimCheckin = ["qoder", "qoder-cn", "minimax-code", "minimax-code-global"].includes(providerId);
  /**
   * The Export/Import button pair, hoisted out of the dual-auth-only branch.
   *
   * The transfer routes are provider-agnostic and `accountTransfer` carries
   * each provider's session payload — for `mimo-desktop` that payload (the
   * account session) IS the credential, and the Desktop card's authModes are a
   * single "oauth", so keeping these buttons inside the dual-auth arm left the
   * one card that most needs cross-machine migration with no transfer UI at
   * all. The helper is the only place the pair is rendered now.
   */
  const renderOAuthTransferButtons = (className) =>
    oauthTransferOn && !codeBuddyCheckinOn ? (
      <>
        <Button size="sm" icon="file_download" variant="secondary" onClick={() => openCbPassword("export")} className={className}>
          {translate("Export")}
        </Button>
        <Button size="sm" icon="upload_file" variant="secondary" onClick={() => { setOauthTransferMode("import"); setShowOAuthTransfer(true); }} className={className}>
          {translate("Import")}
        </Button>
      </>
    ) : null;

  const staticModels = getModelsByProviderId(providerId);
  // Qoder publishes credit multipliers + off-peak promos only on its live
  // catalog (price_factor flips to 0 during a free window, the promotion
  // object carries the 22:00–08:00 Asia/Singapore discount). Overlay them
  // onto the static rows so the badges reflect the account's real pricing.
  const isQoderFamily = providerId === "qoder" || providerId === "qoder-cn";
  // "Fetch official catalog" import button scope: qoder family (live catalog)
  // and xiaomi-mimo (public /v1/models). mimo-x client previews are filtered
  // server-side in resolveMimoModels, so the import can never shadow them.
  const supportsCatalogImport = providerId === "qoder" || providerId === "qoder-cn" || providerId === "xiaomi-mimo";
  const models = providerId === "cursor" && liveModels.length > 0
    ? liveModels
    : isQoderFamily
      ? mergeQoderLivePricing(staticModels, liveModels)
      : staticModels;
  // One shared off-peak window for the whole list (Qoder attaches the same
  // promotion object to every discounted model).
  const offPeakPromotion = isQoderFamily ? (models.find((m) => m.promotion)?.promotion || null) : null;
  const providerAlias = getProviderAlias(providerId);
  
  const isOpenAICompatible = isOpenAICompatibleProvider(providerId);
  const isAnthropicCompatible = isAnthropicCompatibleProvider(providerId);
  const isCompatible = isOpenAICompatible || isAnthropicCompatible;
  const hasDualAuthModes = !isCompatible && isOAuth && supportsApiKeyAuth;
  const oauthConnectionLabel =
    providerId === "xai" ? "Grok Build OAuth"
    : providerId === "grok-cli" ? "Grok CLI Device Login"
    : providerId === "kimi" ? "Kimi Coding OAuth"
    : "OAuth";
  const apiKeyConnectionLabel =
    providerId === "xai" ? "xAI API Key"
    : providerId === "kimi" ? "Kimi API Key"
    : providerId === "qoder" ? "PAT"
    : "API Key";
  // Resolve suffix "(level)" for a model when a thinking level is picked and the model supports it.
  const resolveThinkingSuffix = (modelId) => {
    if (!thinkingMode || thinkingMode === "auto") return null;
    const levels = getThinkingLevels(providerId, modelId);
    return levels && levels.includes(thinkingMode) ? thinkingMode : null;
  };
  const providerStorageAlias = isCompatible ? providerId : providerAlias;
  // Union of levels across this provider's reasoning models — drives the level picker options.
  // Include custom models too (e.g. manually added gpt-5.6-sol → max).
  const providerThinkingLevels = (() => {
    const set = new Set();
    const seen = new Set();
    const addLevels = (modelId) => {
      if (!modelId || seen.has(modelId)) return;
      seen.add(modelId);
      const lv = getThinkingLevels(providerId, modelId);
      if (lv) lv.forEach((l) => { if (l !== "none") set.add(l); });
    };
    for (const m of models) addLevels(m.id);
    for (const m of kiloFreeModels) addLevels(m.id);
    for (const entry of customModels) {
      if (entry.providerAlias !== providerStorageAlias) continue;
      if ((entry.kind || entry.type || "llm") !== "llm") continue;
      addLevels(entry.id);
    }
    return set.size ? ["auto", ...[...set]] : null;
  })();
  const providerDisplayAlias = isCompatible
    ? (providerNode?.prefix || providerId)
    : providerAlias;

  const fetchDisabledModels = useCallback(async () => {
    try {
      const res = await fetch(`/api/models/disabled?providerAlias=${encodeURIComponent(providerStorageAlias)}`, { cache: "no-store" });
      const data = await res.json();
      if (res.ok) setDisabledModelIds(data.ids || []);
    } catch (error) {
      console.log("Error fetching disabled models:", error);
    }
  }, [providerStorageAlias]);

  const handleDisableModel = async (modelId) => {
    try {
      const res = await fetch("/api/models/disabled", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerAlias: providerStorageAlias, ids: [modelId] }),
      });
      if (res.ok) await fetchDisabledModels();
    } catch (error) {
      console.log("Error disabling model:", error);
    }
  };

  const handleEnableModel = async (modelId) => {
    try {
      const res = await fetch(`/api/models/disabled?providerAlias=${encodeURIComponent(providerStorageAlias)}&id=${encodeURIComponent(modelId)}`, { method: "DELETE" });
      if (res.ok) await fetchDisabledModels();
    } catch (error) {
      console.log("Error enabling model:", error);
    }
  };

  // Flip a custom model's enabled flag without a per-model refetch (bulk path).
  const putCustomModelEnabled = async (modelId, enabled) => {
    await fetch("/api/models/custom", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerAlias: providerStorageAlias, id: modelId, type: "llm", enabled }),
    });
  };

  const handleDisableAll = async (ids, customIds = []) => {
    const total = ids.length + customIds.length;
    if (!total) return;
    setConfirmState({
      title: "Disable All Models",
      message: `Disable all ${total} model(s)?`,
      onConfirm: async () => {
        setConfirmState(null);
        try {
          if (ids.length) {
            const res = await fetch("/api/models/disabled", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ providerAlias: providerStorageAlias, ids }),
            });
            if (res.ok) await fetchDisabledModels();
          }
          for (const id of customIds) await putCustomModelEnabled(id, false);
          if (customIds.length) await fetchCustomModels();
        } catch (error) {
          console.log("Error disabling all models:", error);
        }
      }
    });
  };

  const handleEnableAll = async (customIds = []) => {
    try {
      const res = await fetch(`/api/models/disabled?providerAlias=${encodeURIComponent(providerStorageAlias)}`, { method: "DELETE" });
      if (res.ok) await fetchDisabledModels();
      for (const id of customIds) await putCustomModelEnabled(id, true);
      if (customIds.length) await fetchCustomModels();
    } catch (error) {
      console.log("Error enabling all models:", error);
    }
  };

  // Define callbacks BEFORE the useEffect that uses them
  const fetchAliases = useCallback(async () => {
    try {
      const res = await fetch("/api/models/alias");
      const data = await res.json();
      if (res.ok) {
        setModelAliases(data.aliases || {});
      }
    } catch (error) {
      console.log("Error fetching aliases:", error);
    }
  }, []);

  const fetchCustomModels = useCallback(async () => {
    try {
      const res = await fetch("/api/models/custom", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) {
        setCustomModels(data.models || []);
      }
    } catch (error) {
      console.log("Error fetching custom models:", error);
    }
  }, []);

  // Fetch free models from Kilo API for kilocode provider
  useEffect(() => {
    if (providerId !== "kilocode") return;
    fetch("/api/providers/kilo/free-models")
      .then((res) => res.json())
      .then((data) => { if (data.models?.length) setKiloFreeModels(data.models); })
      .catch(() => {});
  }, [providerId]);

  const fetchConnections = useCallback(async () => {
    try {
      const [connectionsRes, nodesRes, proxyPoolsRes, settingsRes] = await Promise.all([
        fetch("/api/providers", { cache: "no-store" }),
        fetch("/api/provider-nodes", { cache: "no-store" }),
        fetch("/api/proxy-pools?isActive=true", { cache: "no-store" }),
        fetch("/api/settings", { cache: "no-store" }),
      ]);
      const connectionsData = await connectionsRes.json();
      const nodesData = await nodesRes.json();
      const proxyPoolsData = await proxyPoolsRes.json();
      const settingsData = settingsRes.ok ? await settingsRes.json() : {};
      if (connectionsRes.ok) {
        const filtered = (connectionsData.connections || []).filter(c => c.provider === providerId);
        setConnections(filtered);
      }
      if (proxyPoolsRes.ok) {
        setProxyPools(proxyPoolsData.proxyPools || []);
      }
      // Load per-provider strategy override
      const override = (settingsData.providerStrategies || {})[providerId] || {};
      setProviderStrategy(override.fallbackStrategy || null);
      setProviderStickyLimit(override.stickyRoundRobinLimit != null ? String(override.stickyRoundRobinLimit) : "1");
      setEarliestExpiryFirst(override.earliestExpiryFirst === true);
      setOauthTransferEnabled(settingsData.codeBuddyOAuthImport === true);
      // Load per-provider thinking config
      const thinkingCfg = (settingsData.providerThinking || {})[providerId] || {};
      setThinkingMode(thinkingCfg.mode || "auto");
      const autoPingSettingsKey = AUTO_PING_SETTINGS_KEYS[providerId];
      const apCfg = autoPingSettingsKey ? settingsData[autoPingSettingsKey] || {} : {};
      setAutoPing({
        enabled: apCfg.enabled === true,
        connections: apCfg.connections || {},
        schedules: apCfg.schedules || {},
      });
      if (nodesRes.ok) {
        let node = (nodesData.nodes || []).find((entry) => entry.id === providerId) || null;

        // Newly created compatible nodes can be briefly unavailable on one worker.
        // Retry a few times before showing "Provider not found".
        if (!node && isCompatible) {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 150));
            const retryRes = await fetch("/api/provider-nodes", { cache: "no-store" });
            if (!retryRes.ok) continue;
            const retryData = await retryRes.json();
            node = (retryData.nodes || []).find((entry) => entry.id === providerId) || null;
            if (node) break;
          }
        }

        setProviderNode(node);
      }
    } catch (error) {
      console.log("Error fetching connections:", error);
    } finally {
      setLoading(false);
    }
  }, [providerId, isCompatible]);

  // A provider's FIRST connection triggers the server-side default-disable of
  // every built-in LLM model (connectionsRepo) — refresh connections AND the
  // disabled list together, or the UI keeps claiming "all enabled" until a
  // manual reload while /v1/models (same table) serves nothing. Issue #14-A.
  // Must be declared AFTER fetchConnections: the deps array evaluates it on
  // every render, and a forward reference is a TDZ crash (page wouldn't load).
  const refreshAfterConnectionChange = useCallback(async () => {
    await fetchConnections();
    await fetchDisabledModels();
  }, [fetchConnections, fetchDisabledModels]);

  const handleUpdateNode = async (formData) => {
    try {
      const res = await fetch(`/api/provider-nodes/${providerId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });
      const data = await res.json();
      if (res.ok) {
        setProviderNode(data.node);
        await fetchConnections();
        setShowEditNodeModal(false);
      }
    } catch (error) {
      console.log("Error updating provider node:", error);
    }
  };

  const saveProviderStrategy = async (
    strategy,
    stickyLimit,
    earliestExpiry = earliestExpiryFirst,
    balStrategy = balanceStrategy,
  ) => {
    try {
      const settingsRes = await fetch("/api/settings", { cache: "no-store" });
      const settingsData = settingsRes.ok ? await settingsRes.json() : {};
      const current = settingsData.providerStrategies || {};

      // Build override: null strategy means remove override, use global
      const override = { ...(current[providerId] || {}) };
      if (strategy) override.fallbackStrategy = strategy;
      else delete override.fallbackStrategy;

      if (strategy === "round-robin" && stickyLimit !== "") {
        override.stickyRoundRobinLimit = Number(stickyLimit) || 3;
      } else {
        delete override.stickyRoundRobinLimit;
      }

      if (earliestExpiry) {
        override.earliestExpiryFirst = true;
      } else {
        delete override.earliestExpiryFirst;
      }

      if (balStrategy && balStrategy !== "priority") {
        override.balanceStrategy = balStrategy;
      } else {
        delete override.balanceStrategy;
      }

      const updated = { ...current };
      if (Object.keys(override).length === 0) {
        delete updated[providerId];
      } else {
        updated[providerId] = override;
      }

      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerStrategies: updated }),
      });
    } catch (error) {
      console.log("Error saving provider strategy:", error);
    }
  };

  const handleRoundRobinToggle = (enabled) => {
    const strategy = enabled ? "round-robin" : null;
    const sticky = enabled ? (providerStickyLimit || "1") : providerStickyLimit;
    if (enabled && !providerStickyLimit) setProviderStickyLimit("1");
    setProviderStrategy(strategy);
    saveProviderStrategy(strategy, sticky, earliestExpiryFirst, balanceStrategy);
  };

  const handleStickyLimitChange = (value) => {
    setProviderStickyLimit(value);
    saveProviderStrategy("round-robin", value, earliestExpiryFirst, balanceStrategy);
  };

  const handleEarliestExpiryToggle = (enabled) => {
    setEarliestExpiryFirst(enabled);
    saveProviderStrategy(providerStrategy, providerStickyLimit, enabled, balanceStrategy);
  };

  const handlePackOrSubStrategyChange = (value) => {
    if (value === "round-robin") {
      setEarliestExpiryFirst(false);
      setProviderStrategy("round-robin");
      if (!providerStickyLimit) setProviderStickyLimit("1");
      saveProviderStrategy("round-robin", providerStickyLimit || "1", false, balanceStrategy);
    } else if (value === "earliest") {
      setEarliestExpiryFirst(true);
      setProviderStrategy(null);
      saveProviderStrategy(null, providerStickyLimit, true, balanceStrategy);
    } else {
      setEarliestExpiryFirst(false);
      setProviderStrategy(null);
      saveProviderStrategy(null, providerStickyLimit, false, balanceStrategy);
    }
  };

  const handleBalanceStrategyChange = (value) => {
    setBalanceStrategy(value);
    if (value === "round-robin") {
      setProviderStrategy("round-robin");
      if (!providerStickyLimit) setProviderStickyLimit("1");
      saveProviderStrategy("round-robin", providerStickyLimit || "1", false, value);
    } else {
      setProviderStrategy(null);
      saveProviderStrategy(null, providerStickyLimit, false, value);
    }
  };

  const saveThinkingConfig = async (mode) => {
    try {
      const settingsRes = await fetch("/api/settings", { cache: "no-store" });
      const settingsData = settingsRes.ok ? await settingsRes.json() : {};
      const current = settingsData.providerThinking || {};
      const updated = { ...current };
      if (!mode || mode === "auto") {
        delete updated[providerId];
      } else {
        updated[providerId] = { mode };
      }
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerThinking: updated }),
      });
    } catch (error) {
      console.log("Error saving thinking config:", error);
    }
  };

  const handleThinkingModeChange = (mode) => {
    setThinkingMode(mode);
    saveThinkingConfig(mode);
  };

  const saveAutoPing = async (next) => {
    const autoPingSettingsKey = AUTO_PING_SETTINGS_KEYS[providerId];
    if (!autoPingSettingsKey) return;

    setAutoPing(next);
    try {
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [autoPingSettingsKey]: next }),
      });
    } catch (error) {
      console.log("Error saving auto-ping config:", error);
    }
  };

  const handleSaveAutoPing = (connectionId, { reactive, schedule }) => {
    saveAutoPing({
      ...autoPing,
      connections: { ...autoPing.connections, [connectionId]: reactive },
      schedules: { ...(autoPing.schedules || {}), [connectionId]: schedule },
    });
  };

  useEffect(() => {
    fetchConnections();
    fetchAliases();
    fetchCustomModels();
    fetchDisabledModels();
  }, [fetchConnections, fetchAliases, fetchCustomModels, fetchDisabledModels]);

  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        setOauthTransferEnabled(data.codeBuddyOAuthImport === true);
        if (typeof data.codeBuddyCheckin === "boolean") {
          setCodeBuddyCheckinEnabled(data.codeBuddyCheckin);
        }
        if (typeof data.codeBuddyCompensation === "boolean") {
          setCodeBuddyCompensationEnabled(data.codeBuddyCompensation);
        }
        const strategyOverride = (data.providerStrategies || {})[providerId] || {};
        setProviderStrategy(strategyOverride.fallbackStrategy || null);
        setProviderStickyLimit(strategyOverride.stickyRoundRobinLimit != null ? String(strategyOverride.stickyRoundRobinLimit) : "1");
        setEarliestExpiryFirst(strategyOverride.earliestExpiryFirst === true);
        setBalanceStrategy(strategyOverride.balanceStrategy || "priority");
      })
      .catch((e) => console.log("Error reading settings:", e));
  }, []);

  // Cursor's model availability is account-specific and changes frequently.
  // Load the active account's live catalog for the dashboard; the static
  // registry remains the fallback while the request is pending or unavailable.
  // The Qoder family piggybacks on the same fetch: the live rows carry the
  // promo-aware rateMultiplier / promotion objects the multiplier badges,
  // green free badge and off-peak banner render from (server already
  // rewrites price_factor into rateMultiplier — the client does no pricing).
  useEffect(() => {
    if (providerId !== "cursor" && !isQoderFamily) {
      setLiveModels([]);
      return;
    }

    const connection = connections.find((item) => item.isActive !== false);
    if (!connection?.id) {
      setLiveModels([]);
      return;
    }

    let cancelled = false;
    fetch(`/api/providers/${connection.id}/models`, { cache: "no-store" })
      .then(async (res) => ({ ok: res.ok, data: await res.json() }))
      .then(({ ok, data }) => {
        if (!cancelled && ok && Array.isArray(data.models) && data.models.length > 0) {
          setLiveModels(data.models);
        }
      })
      .catch(() => {});

    return () => { cancelled = true; };
  }, [providerId, connections]);

  // Fetch suggested models from provider's public API (if configured)
  useEffect(() => {
    const fetcher = (OAUTH_PROVIDERS[providerId] || APIKEY_PROVIDERS[providerId] || FREE_PROVIDERS[providerId] || FREE_TIER_PROVIDERS[providerId])?.modelsFetcher;
    if (!fetcher) return;
    fetchSuggestedModels(fetcher).then(setSuggestedModels);
  }, [providerId]);

  const handleSetAlias = async (modelId, alias, providerAliasOverride = providerAlias) => {
    const fullModel = `${providerAliasOverride}/${modelId}`;
    try {
      const res = await fetch("/api/models/alias", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: fullModel, alias }),
      });
      if (res.ok) {
        await fetchAliases();
      } else {
        const data = await res.json();
        notify.error(data.error || "Failed to set alias")
      }
    } catch (error) {
      console.log("Error setting alias:", error);
    }
  };

  const handleDeleteAlias = async (alias) => {
    try {
      const res = await fetch(`/api/models/alias?alias=${encodeURIComponent(alias)}`, {
        method: "DELETE",
      });
      if (res.ok) {
        await fetchAliases();
      }
    } catch (error) {
      console.log("Error deleting alias:", error);
    }
  };

  const handleAddCustomModel = async (modelId, type = "llm", providerAliasOverride = providerStorageAlias, caps = {}, enabled, transport) => {
    try {
      const body = { providerAlias: providerAliasOverride, id: modelId, type };
      if (enabled !== undefined) body.enabled = enabled;
      // Realtime STT dispatch marker — the API whitelist only honours it on
      // type "stt" records and silently drops unknown values.
      if (transport) body.transport = transport;
      if (caps && typeof caps === "object") {
        for (const k of ["vision", "reasoning", "contextWindow", "maxOutput", "thinkingFormat"]) {
          if (caps[k] !== undefined) body[k] = caps[k];
        }
      }
      const res = await fetch("/api/models/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        await fetchCustomModels();
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("customModelChanged"));
      } else {
        const data = await res.json();
        notify.error(data.error || "Failed to add custom model")
      }
    } catch (error) {
      console.log("Error adding custom model:", error);
    }
  };

  // Per-model context-window / max-output pins (kept out of the catalog, in
  // the modelCaps scope). The hook already folds overrides into getCaps, so
  // badges update as soon as refresh() re-reads /api/models/caps.
  const isCapsPinned = (modelId) =>
    !!(overrides?.[providerStorageAlias]?.[modelId] || overrides?.[providerId]?.[modelId]);
  const handleSaveModelCaps = async (modelId, caps) => {
    try {
      const res = await fetch("/api/models/caps", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerStorageAlias || providerId, modelId, ...(caps || {}) }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        notify.error(d?.error || "Failed to save model settings");
        return;
      }
      refresh();
    } catch (error) {
      console.log("Error saving model caps:", error);
      notify.error("Failed to save model settings");
    }
  };

  const handleDeleteCustomModel = async (modelId, type = "llm", providerAliasOverride = providerStorageAlias) => {
    try {
      const params = new URLSearchParams({ providerAlias: providerAliasOverride, id: modelId, type });
      const res = await fetch(`/api/models/custom?${params}`, { method: "DELETE" });
      if (res.ok) {
        await fetchCustomModels();
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("customModelChanged"));
      }
    } catch (error) {
      console.log("Error deleting custom model:", error);
    }
  };

  // Toggle a custom model's enabled flag (PUT /api/models/custom).
  const handleToggleCustomModel = async (modelId, enabled, type = "llm") => {
    try {
      const res = await fetch("/api/models/custom", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerAlias: providerStorageAlias, id: modelId, type, enabled }),
      });
      if (res.ok) {
        await fetchCustomModels();
        if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("customModelChanged"));
      }
    } catch (error) {
      console.log("Error toggling custom model:", error);
    }
  };

  // Bulk enable/disable every custom model of this provider (P2). Both
  // directions confirm first — enable exposes models to clients via /v1/models,
  // disable hides them.
  const handleBulkCustomModels = (enabled, type = "llm") => {
    setConfirmState({
      title: enabled ? translate("Enable all custom models?") : translate("Disable all custom models?"),
      message: enabled
        ? translate("All custom models of this provider will be listed in /v1/models and exposed to clients.")
        : translate("All custom models of this provider will disappear from /v1/models until re-enabled. Clients will no longer see them."),
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch("/api/models/custom/bulk", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ providerAlias: providerStorageAlias, type, enabled }),
          });
          if (res.ok) {
            await fetchCustomModels();
            if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("customModelChanged"));
          }
        } catch (error) {
          console.log("Error bulk-updating custom models:", error);
        }
      },
    });
  };

  // Fetch Qoder model list and automatically add to available models
  const handleImportQoderModels = async () => {
    if (importingQoderModels) return;
    const activeConnection = connections.find((conn) => conn.isActive !== false);
    if (!activeConnection) {
      notify.warning(providerId === "xiaomi-mimo"
        ? translate("Please add an active MiMo connection first")
        : translate("Please add an active Qoder connection first"))
      return;
    }

    setImportingQoderModels(true);
    try {
      const res = await fetch(`/api/providers/${activeConnection.id}/models`);
      const data = await res.json();
      if (!res.ok) {
        notify.error(data.error || translate("Failed to fetch models"))
        return;
      }
      const models = data.models || [];
      if (models.length === 0) {
        notify.warning(translate("No models returned"))
        return;
      }

      let importedCount = 0;
      let mediaSkipped = 0;
      for (const model of models) {
        const modelId = model.id || model.name;
        if (!modelId) continue;
        // Media-kind models (tts/stt/image/…) belong to the media-providers
        // surface, never to this chat model list. MiMo's upstream catalog
        // mixes them and the resolver tags them; qoder models arrive without
        // a kind field and default to "llm", so qoder import is unchanged.
        if ((model.kind || "llm") !== "llm") {
          mediaSkipped += 1;
          continue;
        }
        
        // Qoder model ID format may be "qoder/auto", "qoder-cn/auto" or
        // "auto" — strip whichever provider prefix the route attached.
        const cleanModelId = modelId.replace(/^qoder(-cn)?\//, "");
        // Models already listed as official registry entries are NOT re-added
        // as customs — the fetch button exists to pull in catalog newcomers
        // (e.g. q37fmodel before it was registered), not to duplicate the
        // whole catalog into the custom table (29 shadow rows observed 2026-09-19).
        if (models.some((official) => official.id === cleanModelId)) {
          continue;
        }
        const alreadyExists = customModels.some(
          (entry) => entry.providerAlias === providerStorageAlias && entry.id === cleanModelId && (entry.kind || entry.type || "llm") === "llm"
        ) || Object.values(modelAliases).includes(`${providerStorageAlias}/${cleanModelId}`);
        if (alreadyExists) {
          continue;
        }

        // Fetched catalog → add disabled; the user enables on demand.
        await handleAddCustomModel(cleanModelId, "llm", providerStorageAlias, {}, false);
        importedCount += 1;
      }
      
      if (importedCount === 0) {
        notify.warning(translate("All models already exist, no new models added"))
      } else {
        notify.success(translate("Successfully added") + ` ${importedCount} ` + translate("models"))
      }
      if (mediaSkipped > 0) {
        notify.info(translate("Media models skipped (use Media Providers)") + ` (${mediaSkipped})`)
      }
    } catch (error) {
      console.log("Error importing Qoder models:", error);
      notify.error(translate("Error fetching models") + ": " + error.message)
    } finally {
      setImportingQoderModels(false);
    }
  };

  // Credential-backed model discovery for providers that expose an official
  // OpenAI-compatible /models endpoint. Results stay in the page as suggestions
  // and are added explicitly by the user; they never become a second catalog or
  // override the global capability library.
  const canRefreshOfficialModels = providerId === "opencode-go" || providerId === "bai" || providerId === "cline";
  const handleRefreshOfficialModels = async () => {
    if (officialModelsRefreshing) return;
    const connection = connections.find((item) => item.isActive !== false);
    if (!connection?.id) {
      notify.warning(translate("Add a connection to enable importing models."));
      return;
    }

    setOfficialModelsRefreshing(true);
    try {
      const res = await fetch(`/api/providers/${connection.id}/models`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `Request failed: ${res.status}`);
      const models = (Array.isArray(data.models) ? data.models : [])
        .map((model) => {
          const id = model?.id || model?.name || model?.model;
          return id ? { ...model, id: String(id), name: model.name || String(id) } : null;
        })
        .filter(Boolean);
      setSuggestedModels(models);
      notify.success(`${translate("Models refreshed")} (${models.length})`);
    } catch (error) {
      notify.error(translate("Failed to fetch models") + ": " + error.message);
    } finally {
      setOfficialModelsRefreshing(false);
    }
  };

  const handleRunOneByOneTest = async () => {
    if (oneByOneRunning || connections.length === 0) return;

    const queuedState = Object.fromEntries(
      connections.map((connection) => [connection.id, { state: "queued", error: null }]),
    );

    stopOneByOneRef.current = false;
    setOneByOneRunning(true);
    setOneByOneStopping(false);
    setOneByOneCurrentConnectionId(null);
    setOneByOneResults(queuedState);
    setOneByOneSummary({ total: connections.length, completed: 0, passed: 0, failed: 0, stopped: false });

    let passed = 0;
    let failed = 0;

    try {
      for (let index = 0; index < connections.length; index += 1) {
        if (stopOneByOneRef.current) {
          setOneByOneSummary({
            total: connections.length,
            completed: index,
            passed,
            failed,
            stopped: true,
          });
          break;
        }

        const connection = connections[index];
        setOneByOneCurrentConnectionId(connection.id);
        setOneByOneResults((prev) => ({
          ...prev,
          [connection.id]: { state: "testing", error: null },
        }));

        try {
          // Guard against a persisted selection drifting across provider
          // navigation: only send the model if it is one of this provider's.
          const probeModel = models.some((m) => m.id === oneByOneModel) ? oneByOneModel : null;
          const res = await fetch(`/api/providers/${connection.id}/test`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(probeModel && probeModel !== ONE_BY_ONE_DEFAULT_MODEL ? { model: probeModel } : {}),
          });
          const data = await res.json();
          const valid = !!data.valid;

          if (valid) {
            passed += 1;
          } else {
            failed += 1;
          }

          setOneByOneResults((prev) => ({
            ...prev,
            [connection.id]: {
              state: valid ? "success" : "failed",
              error: valid ? null : (data.error || null),
            },
          }));
        } catch (error) {
          failed += 1;
          setOneByOneResults((prev) => ({
            ...prev,
            [connection.id]: {
              state: "failed",
              error: error.message || "Test failed",
            },
          }));
        }

        setOneByOneSummary({
          total: connections.length,
          completed: index + 1,
          passed,
          failed,
          stopped: false,
        });

        if (index < connections.length - 1) {
          await sleep(ONE_BY_ONE_DELAY_MS);
        }
      }
    } finally {
      setOneByOneCurrentConnectionId(null);
      setOneByOneRunning(false);
      setOneByOneStopping(false);
      stopOneByOneRef.current = false;
      // The test route has just rewritten testStatus/lastError in the DB —
      // pull the fresh rows so the badges and red error text match reality.
      fetchConnections();
    }
  };

  const handleStopOneByOneTest = () => {
    if (!oneByOneRunning) return;
    stopOneByOneRef.current = true;
    setOneByOneStopping(true);
  };

  const handleDelete = async (id) => {
    setConfirmState({
      title: "Delete Connection",
      message: "Delete this connection?",
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/providers/${id}`, { method: "DELETE" });
          if (res.ok) {
            setConnections(prev => prev.filter(c => c.id !== id));
          }
        } catch (error) {
          console.log("Error deleting connection:", error);
        }
      }
    });
  };

  const handleBulkDelete = () => {
    const count = selectedConnectionIds.length;
    if (count === 0) return;
    setConfirmState({
      title: translate("Delete {count} Connections", { count }),
      message: translate("Delete {count} connections? This cannot be undone.", { count }),
      onConfirm: async () => {
        setConfirmState(null);
        let failed = 0;
        const idsToDelete = [...selectedConnectionIds];
        for (const id of idsToDelete) {
          try {
            const res = await fetch(`/api/providers/${id}`, { method: "DELETE" });
            if (!res.ok) failed += 1;
          } catch (error) {
            console.log("Error deleting connection:", error);
            failed += 1;
          }
        }
        setConnections(prev => prev.filter(c => !idsToDelete.includes(c.id)));
        setSelectedConnectionIds([]);
        if (failed > 0) notify.warning(translate("Deleted {deleted} connection(s), {failed} failed.", { deleted: idsToDelete.length - failed, failed }));
        else notify.success(translate("Deleted successfully"));
      }
    });
  };

  const handleOAuthSuccess = () => {
    // Fresh credentials supersede every stale test verdict on this page —
    // consume the red error chips/banner instead of waiting for a reload.
    setModelsTestError("");
    setModelTestResults({});
    setOneByOneResults({});
    setOneByOneSummary(null);
    fetchConnections();
    setShowOAuthModal(false);
  };

  const handleIFlowCookieSuccess = () => {
    fetchConnections();
    setShowIFlowCookieModal(false);
  };

  const handleSaveApiKey = async (formData) => {
    setAddConnectionError("");
    try {
      const res = await fetch("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerId, ...formData }),
      });

      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }

      if (res.ok) {
        // A first working credential retires the "no valid connections"-style
        // banner and the red per-model icons from the previous attempt.
        setModelsTestError("");
        setModelTestResults({});
        await refreshAfterConnectionChange();
        setShowAddApiKeyModal(false);
        return;
      }

      setAddConnectionError(data?.error || "Failed to save connection");
    } catch (error) {
      console.log("Error saving connection:", error);
      setAddConnectionError("Failed to save connection");
    }
  };

  const handleUpdateConnection = async (formData) => {
    try {
      const res = await fetch(`/api/providers/${selectedConnection.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });
      if (res.ok) {
        // Same rationale as handleOAuthSuccess: saved (possibly new)
        // credentials make prior failure chips stale.
        setModelsTestError("");
        setModelTestResults({});
        setOneByOneResults({});
        setOneByOneSummary(null);
        await fetchConnections();
        setShowEditModal(false);
      }
    } catch (error) {
      console.log("Error updating connection:", error);
    }
  };

  const handleUpdateConnectionStatus = async (id, isActive) => {
    try {
      const res = await fetch(`/api/providers/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      });
      if (res.ok) {
        setConnections(prev => prev.map(c => c.id === id ? { ...c, isActive } : c));
      }
    } catch (error) {
      console.log("Error updating connection status:", error);
    }
  };

  const handleSwapPriority = async (index1, index2) => {
    // Optimistic update state
    const newConnections = [...connections];
    [newConnections[index1], newConnections[index2]] = [newConnections[index2], newConnections[index1]];
    setConnections(newConnections);

    try {
      await Promise.all([
        fetch(`/api/providers/${newConnections[index1].id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ priority: index1 }),
        }),
        fetch(`/api/providers/${newConnections[index2].id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ priority: index2 }),
        }),
      ]);
    } catch (error) {
      console.log("Error swapping priority:", error);
      await fetchConnections();
    }
  };

  const selectedConnections = connections.filter((conn) => selectedConnectionIds.includes(conn.id));
  const allSelected = connections.length > 0 && selectedConnectionIds.length === connections.length;

  const toggleSelectConnection = (connectionId) => {
    setSelectedConnectionIds((prev) => (
      prev.includes(connectionId)
        ? prev.filter((id) => id !== connectionId)
        : [...prev, connectionId]
    ));
  };

  const toggleSelectAllConnections = () => {
    if (allSelected) {
      setSelectedConnectionIds([]);
      return;
    }
    setSelectedConnectionIds(connections.map((conn) => conn.id));
  };

  const clearSelection = () => {
    setSelectedConnectionIds([]);
    setBulkProxyPoolId("__none__");
  };

  useEffect(() => {
    setSelectedConnectionIds((prev) => prev.filter((id) => connections.some((conn) => conn.id === id)));
  }, [connections]);

  const selectedProxySummary = (() => {
    if (selectedConnections.length === 0) return "";
    const poolIds = new Set(selectedConnections.map((conn) => conn.providerSpecificData?.proxyPoolId || "__none__"));
    if (poolIds.size === 1) {
      const onlyId = [...poolIds][0];
      if (onlyId === "__none__") return "All selected currently unbound";
      const pool = proxyPools.find((p) => p.id === onlyId);
      return `All selected currently bound to ${pool?.name || onlyId}`;
    }
    return "Selected connections have mixed proxy bindings";
  })();

  const openBulkProxyModal = () => {
    if (selectedConnections.length === 0) return;
    const uniquePoolIds = [...new Set(selectedConnections.map((conn) => conn.providerSpecificData?.proxyPoolId || "__none__"))];
    setBulkProxyPoolId(uniquePoolIds.length === 1 ? uniquePoolIds[0] : "__none__");
    setShowBulkProxyModal(true);
  };

  const closeBulkProxyModal = () => {
    if (bulkUpdatingProxy) return;
    setShowBulkProxyModal(false);
  };

  const applyProxyAssignments = async (assignments) => {
    setBulkUpdatingProxy(true);
    try {
      let failed = 0;
      for (const { connectionId, proxyPoolId } of assignments) {
        try {
          const res = await fetch(`/api/providers/${connectionId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ proxyPoolId }),
          });
          if (!res.ok) failed += 1;
        } catch (e) {
          console.log("Error applying proxy for", connectionId, e);
          failed += 1;
        }
      }
      if (failed > 0) alert(`Updated with ${failed} failed request(s).`);
      await fetchConnections();
      setShowBulkProxyModal(false);
    } finally {
      setBulkUpdatingProxy(false);
    }
  };

  const handleApplySinglePool = (proxyPoolId) => {
    const targets = connections.map((c) => ({ connectionId: c.id, proxyPoolId }));
    return applyProxyAssignments(targets);
  };

  const handleApplyOneToOne = () => {
    const activePools = proxyPools.filter((p) => p.isActive === true);
    if (activePools.length === 0) {
      notify.warning("No active proxy pools available.")
      return;
    }
    const targets = connections.map((c, i) => ({
      connectionId: c.id,
      proxyPoolId: activePools[i % activePools.length].id,
    }));
    return applyProxyAssignments(targets);
  };


  const isSelected = (connectionId) => selectedConnectionIds.includes(connectionId);

  const connectionsList = (
    <div className="flex min-w-0 flex-col divide-y divide-black/[0.03] dark:divide-white/[0.03]">
      {connections
        .map((conn, index) => (
          <div key={conn.id} className="flex min-w-0 items-stretch">
            <div className="flex shrink-0 items-center pl-1 sm:pl-2">
              <input
                type="checkbox"
                checked={isSelected(conn.id)}
                onChange={() => toggleSelectConnection(conn.id)}
                className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
              />
            </div>
            <div className="flex-1 min-w-0">
              <ConnectionRow
                connection={conn}
                proxyPools={proxyPools}
                isOAuth={isOAuth}
                isFirst={index === 0}
                isLast={index === connections.length - 1}
                onMoveUp={() => handleSwapPriority(index, index - 1)}
                onMoveDown={() => handleSwapPriority(index, index + 1)}
                onToggleActive={(isActive) => handleUpdateConnectionStatus(conn.id, isActive)}
                autoPing={AUTO_PING_SETTINGS_KEYS[providerId] && conn.authType === "oauth" ? {
                  isActive: autoPing.connections[conn.id] === true || autoPing.schedules?.[conn.id]?.enabled === true,
                  reactiveOn: autoPing.connections[conn.id] === true,
                  provider: providerId,
                  scheduleOn: autoPing.schedules?.[conn.id]?.enabled === true,
                  scheduleSummary: getScheduleSlotLabels(autoPing.schedules?.[conn.id]).join(" / "),
                  onConfigure: () => setScheduleConnection(conn),
                } : null}
                onUpdateProxy={async (proxyPoolId) => {
                  try {
                    const res = await fetch(`/api/providers/${conn.id}`, {
                      method: "PUT",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ proxyPoolId: proxyPoolId || null }),
                    });
                    if (res.ok) {
                      setConnections(prev => prev.map(c =>
                        c.id === conn.id
                          ? { ...c, providerSpecificData: { ...c.providerSpecificData, proxyPoolId: proxyPoolId || null } }
                          : c
                      ));
                    }
                  } catch (error) {
                    console.log("Error updating proxy:", error);
                  }
                }}
                onEdit={() => {
                  setSelectedConnection(conn);
                  setShowEditModal(true);
                }}
                onDelete={() => handleDelete(conn.id)}
                oneByOneStatus={oneByOneResults[conn.id] || null}
              />
            </div>
          </div>
        ))}
    </div>
  );

  const activePools = proxyPools.filter((p) => p.isActive === true);

  const bulkActionModal = (
    <Modal
      isOpen={showBulkProxyModal}
      onClose={closeBulkProxyModal}
      title={`Apply Proxy (${connections.length} connections)`}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col">
          <button
            onClick={handleApplyOneToOne}
            disabled={bulkUpdatingProxy || activePools.length === 0}
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-text-muted text-[18px]">sync_alt</span>
            <span className="text-sm text-text-main">One-to-one (rotate)</span>
          </button>
          <button
            onClick={() => handleApplySinglePool(null)}
            disabled={bulkUpdatingProxy}
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-text-muted text-[18px]">link_off</span>
            <span className="text-sm text-text-main">None (unbind all)</span>
          </button>
          {proxyPools.map((pool) => (
            <button
              key={pool.id}
              onClick={() => handleApplySinglePool(pool.id)}
              disabled={bulkUpdatingProxy || pool.isActive !== true}
              className="flex items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-text-muted text-[18px]">lan</span>
              <span className="truncate text-sm text-text-main">{pool.name}</span>
              {pool.isActive !== true && (
                <span className="text-[10px] text-text-muted">(inactive)</span>
              )}
            </button>
          ))}
        </div>

        {bulkUpdatingProxy && <p className="text-xs text-text-muted">Applying...</p>}

        <Button onClick={closeBulkProxyModal} variant="ghost" fullWidth disabled={bulkUpdatingProxy}>
          Cancel
        </Button>
      </div>
    </Modal>
  );

  const handleTestModel = async (modelId) => {
    if (testingModelIds.has(modelId)) return;
    setTestingModelIds((prev) => new Set(prev).add(modelId));
    try {
      const res = await fetch("/api/models/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: `${providerStorageAlias}/${modelId}` }),
      });
      const data = await res.json();
      setModelTestResults((prev) => ({ ...prev, [modelId]: data.ok ? "ok" : "error" }));
      setModelsTestError(data.ok ? "" : (data.error || "Model not reachable"));
    } catch {
      setModelTestResults((prev) => ({ ...prev, [modelId]: "error" }));
      setModelsTestError("Network error");
    } finally {
      // The chat pipeline persists/clears the connection row's lastError
      // around the response (success cleanup is fire-and-forget) — refetch
      // shortly after so the red error text on the row tracks the test
      // result without needing a page reload.
      setTimeout(() => { fetchConnections(); }, 600);
      setTestingModelIds((prev) => { const n = new Set(prev); n.delete(modelId); return n; });
    }
  };

  const renderModelsSection = () => {
    if (isCompatible) {
      return (
        <CompatibleModelsSection
          providerStorageAlias={providerStorageAlias}
          providerDisplayAlias={providerDisplayAlias}
          modelAliases={modelAliases}
          customModels={customModels}
          copied={copied}
          onCopy={copy}
          onSetAlias={handleSetAlias}
          onDeleteAlias={handleDeleteAlias}
          onAddCustomModel={(modelId, enabled) => handleAddCustomModel(modelId, "llm", providerStorageAlias, {}, enabled)}
          onToggleCustomModel={handleToggleCustomModel}
          onDeleteCustomModel={(modelId) => handleDeleteCustomModel(modelId, "llm", providerStorageAlias)}
          onBulkCustomModels={handleBulkCustomModels}
          connections={connections}
          isAnthropic={isAnthropicCompatible}
        />
      );
    }
    // Combine hardcoded models with Kilo free models (deduplicated)
    // Exclude non-llm models (embedding, tts, etc.) — they have dedicated pages under media-providers
    const allModels = [
      ...models,
      ...kiloFreeModels.filter((fm) => !models.some((m) => m.id === fm.id)),
    ].filter((m) => { const k = getModelKind(m); return !k || k === "llm"; });
    const disabledSet = new Set(disabledModelIds);
    const displayModels = allModels.filter((m) => !disabledSet.has(m.id));
    const disabledDisplayModels = allModels.filter((m) => disabledSet.has(m.id));
    const customModelRows = getProviderCustomModelRows({
      customModels,
      modelAliases,
      providerAlias: providerStorageAlias,
      builtInModels: models,
      type: "llm",
    });
    // Fetched/imported custom models default to disabled; only enabled ones are
    // listed as active, the rest live in the Disabled section below.
    const enabledCustomModelRows = customModelRows.filter((model) => model.enabled !== false);
    const disabledCustomModelRows = customModelRows.filter((model) => model.enabled === false);

    return (
      <div className="flex flex-wrap gap-3">
        {/* Off-peak countdown strip (Qoder) — one ticking banner for the
            list; rows carry the static leaf badge. */}
        {offPeakPromotion && <div className="w-full"><OffPeakBanner promotion={offPeakPromotion} /></div>}
        {/* Custom models toolbar — bulk enable/disable (P2). Only with customs. */}
        {(enabledCustomModelRows.length + disabledCustomModelRows.length) > 0 && (
          <div className="w-full flex items-center gap-2 text-xs text-text-muted -mb-1">
            <span>
              {translate("Custom models")} ({enabledCustomModelRows.length + disabledCustomModelRows.length})
            </span>
            <span>·</span>
            <button onClick={() => handleBulkCustomModels(true)} className="text-primary hover:underline">
              {translate("Enable all")}
            </button>
            <span>·</span>
            <button onClick={() => handleBulkCustomModels(false)} className="text-text-muted hover:text-red-500 hover:underline">
              {translate("Disable all")}
            </button>
          </div>
        )}
        {/* Custom models first — only enabled ones here; disabled customs are
            listed in the Disabled section below */}
        {enabledCustomModelRows.map((model) => (
          <ModelRow
            key={`${model.source}-${model.fullModel}`}
            model={{ id: model.id, name: model.name }}
            fullModel={`${providerDisplayAlias}/${model.id}`}
            alias={model.alias}
            copied={copied}
            onCopy={copy}
            onSetAlias={() => {}}
            onDeleteAlias={() => {
              if (model.source === "custom") {
                handleDeleteCustomModel(model.id, "llm", providerStorageAlias);
              } else {
                handleDeleteAlias(model.alias);
              }
            }}
            testStatus={modelTestResults[model.id]}
            onTest={connections.length > 0 || isFreeNoAuth ? () => handleTestModel(model.id) : undefined}
            isTesting={testingModelIds.has(model.id)}
            isCustom
            isFree={false}
            caps={getCaps(`${providerId}/${model.id}`)}
            baseCaps={getBaseCaps(`${providerId}/${model.id}`)}
            onSaveCaps={(caps) => handleSaveModelCaps(model.id, caps)}
            capsPinned={isCapsPinned(model.id)}
            thinkingSuffix={resolveThinkingSuffix(model.id)}
          />
        ))}

        {displayModels.map((model) => {
          const fullModel = `${providerStorageAlias}/${model.id}`;
          const oldFormatModel = `${providerId}/${model.id}`;
          const existingAlias = Object.entries(modelAliases).find(
            ([, m]) => m === fullModel || m === oldFormatModel
          )?.[0];
          return (
            <ModelRow
              key={model.id}
              model={model}
              fullModel={`${providerDisplayAlias}/${model.id}`}
              alias={existingAlias}
              copied={copied}
              onCopy={copy}
              onSetAlias={(alias) => handleSetAlias(model.id, alias, providerStorageAlias)}
              onDeleteAlias={() => handleDeleteAlias(existingAlias)}
              testStatus={modelTestResults[model.id]}
              onTest={connections.length > 0 || isFreeNoAuth ? () => handleTestModel(model.id) : undefined}
              isTesting={testingModelIds.has(model.id)}
              isFree={model.isFree}
              onDisable={() => handleDisableModel(model.id)}
              caps={getCaps(`${providerId}/${model.id}`)}
              baseCaps={getBaseCaps(`${providerId}/${model.id}`)}
              onSaveCaps={(caps) => handleSaveModelCaps(model.id, caps)}
              capsPinned={isCapsPinned(model.id)}
              thinkingSuffix={resolveThinkingSuffix(model.id)}
            />
          );
        })}

        {/* Add model button — inline, same style as model chips */}
        <button
          onClick={() => setShowAddCustomModel(true)}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-primary/40 px-3 py-2 text-xs text-primary transition-colors hover:border-primary hover:bg-primary/5 sm:w-auto"
        >
          <span className="material-symbols-outlined text-sm">add</span>
          Add Model
        </button>

        {/* Import Cline models button — show for cline provider */}
        {providerId === "cline" && connections.some((conn) => conn.isActive !== false) && (
          <button
            onClick={handleRefreshOfficialModels}
            disabled={officialModelsRefreshing}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-blue-500/40 px-3 py-2 text-xs text-blue-600 dark:text-blue-400 transition-colors hover:border-blue-500 hover:bg-blue-500/5 sm:w-auto disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <span className="material-symbols-outlined text-sm" style={officialModelsRefreshing ? { animation: "spin 1s linear infinite" } : undefined}>
              {officialModelsRefreshing ? "progress_activity" : "download"}
            </span>
            {officialModelsRefreshing ? translate("Importing...") : translate("Import from /models")}
          </button>
        )}

        {/* Import fetched catalog button — qoder family + xiaomi-mimo */}
        {supportsCatalogImport && connections.some((conn) => conn.isActive !== false) && (
          <button
            onClick={handleImportQoderModels}
            disabled={importingQoderModels}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-blue-500/40 px-3 py-2 text-xs text-blue-600 dark:text-blue-400 transition-colors hover:border-blue-500 hover:bg-blue-500/5 sm:w-auto disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <span className="material-symbols-outlined text-sm" style={importingQoderModels ? { animation: "spin 1s linear infinite" } : undefined}>
              {importingQoderModels ? "progress_activity" : "download"}
            </span>
            {importingQoderModels
              ? translate("Fetching...")
              : translate(providerId === "xiaomi-mimo" ? "Fetch MiMo Models" : "Fetch Qoder Models")}
          </button>
        )}

        {canRefreshOfficialModels && providerId !== "cline" && (
          <button
            onClick={handleRefreshOfficialModels}
            disabled={officialModelsRefreshing || !connections.some((conn) => conn.isActive !== false)}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-blue-500/40 px-3 py-2 text-xs text-blue-600 dark:text-blue-400 transition-colors hover:border-blue-500 hover:bg-blue-500/5 sm:w-auto disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <span className="material-symbols-outlined text-sm" style={officialModelsRefreshing ? { animation: "spin 1s linear infinite" } : undefined}>
              {officialModelsRefreshing ? "progress_activity" : "refresh"}
            </span>
            {officialModelsRefreshing ? translate("Refreshing...") : translate("Refresh Official Models")}
          </button>
        )}

        {/* Suggested models from provider API — show only models not yet added */}
        {suggestedModels.length > 0 && (() => {
          const addedFullModels = new Set([
            ...Object.values(modelAliases),
            ...customModelRows.map((model) => model.fullModel),
          ]);
          const hardcodedIds = new Set(models.map((m) => m.id));
          const notAdded = suggestedModels.filter(
            (m) => !addedFullModels.has(`${providerStorageAlias}/${m.id}`) && !hardcodedIds.has(m.id)
          );
          if (notAdded.length === 0) return null;
          return (
            <div className="w-full mt-2">
              <p className="text-xs text-text-muted mb-2">Suggested free models (≥200k context):</p>
              <div className="flex flex-wrap gap-2">
                {notAdded.map((m) => (
                  <button
                    key={m.id}
                    onClick={async () => {
                      await handleAddCustomModel(m.id, "llm", providerStorageAlias);
                    }}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-black/10 dark:border-white/10 text-xs text-text-muted hover:text-primary hover:border-primary/40 hover:bg-primary/5 transition-colors"
                    title={`${m.name} · ${(m.contextLength / 1000).toFixed(0)}k ctx`}
                  >
                    <span className="material-symbols-outlined text-[13px]">add</span>
                    {m.id.split("/").pop()}
                  </button>
                ))}
              </div>
            </div>
          );
        })()}

        {/* Disabled models — restorable (built-in catalog + fetched/imported customs).
            Full ModelRow (name/caps/multiplier badges + Test + Copy), NOT bare chips:
            the point of the default "all disabled" posture is to evaluate a model
            BEFORE exposing it to clients, so a disabled row must be testable. #14-B */}
        {(disabledDisplayModels.length > 0 || disabledCustomModelRows.length > 0) && (
          <div className="w-full mt-2">
            <p className="text-xs text-text-muted mb-2">Disabled models ({disabledDisplayModels.length + disabledCustomModelRows.length}):</p>
            <div className="flex flex-wrap gap-3">
              {disabledCustomModelRows.map((model) => (
                <ModelRow
                  key={`custom-${model.fullModel}`}
                  model={{ id: model.id, name: model.name }}
                  fullModel={`${providerDisplayAlias}/${model.id}`}
                  copied={copied}
                  onCopy={copy}
                  testStatus={modelTestResults[model.id]}
                  onTest={connections.length > 0 || isFreeNoAuth ? () => handleTestModel(model.id) : undefined}
                  isTesting={testingModelIds.has(model.id)}
                  onEnable={() => handleToggleCustomModel(model.id, true)}
                  isCustom={false}
                  isFree={false}
                  caps={getCaps(`${providerId}/${model.id}`)}
                  baseCaps={getBaseCaps(`${providerId}/${model.id}`)}
                  onSaveCaps={(caps) => handleSaveModelCaps(model.id, caps)}
                  capsPinned={isCapsPinned(model.id)}
                />
              ))}
              {disabledDisplayModels.map((model) => (
                <ModelRow
                  key={model.id}
                  model={model}
                  fullModel={`${providerDisplayAlias}/${model.id}`}
                  copied={copied}
                  onCopy={copy}
                  testStatus={modelTestResults[model.id]}
                  onTest={connections.length > 0 || isFreeNoAuth ? () => handleTestModel(model.id) : undefined}
                  isTesting={testingModelIds.has(model.id)}
                  onEnable={() => handleEnableModel(model.id)}
                  isFree={model.isFree}
                  caps={getCaps(`${providerId}/${model.id}`)}
                  baseCaps={getBaseCaps(`${providerId}/${model.id}`)}
                  onSaveCaps={(caps) => handleSaveModelCaps(model.id, caps)}
                  capsPinned={isCapsPinned(model.id)}
                  thinkingSuffix={resolveThinkingSuffix(model.id)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-8">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
}

  if (!providerInfo) {
    return (
      <div className="text-center py-20">
        <p className="text-text-muted">Provider not found</p>
        <Link href="/dashboard/providers" className="text-primary mt-4 inline-block">
          Back to Providers
        </Link>
      </div>
    );
  }

  // Determine icon path: OpenAI Compatible providers use specialized icons
  const getHeaderIconPath = () => {
    if (isOpenAICompatible && providerInfo.apiType) {
      return providerInfo.apiType === "responses" ? "/providers/oai-r.png" : "/providers/oai-cc.png";
    }
    if (isAnthropicCompatible) {
      return "/providers/anthropic-m.png";
    }
    return getProviderIconSrc(providerInfo.id);
  };

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:gap-8 sm:px-0">
      {/* Header */}
      <div className="min-w-0">
        <Link
          href="/dashboard/providers"
          className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-primary transition-colors mb-4"
        >
          <span className="material-symbols-outlined text-lg">arrow_back</span>
          Back to Providers
        </Link>
        <div className="flex min-w-0 items-center gap-3 sm:gap-4">
          <div
            className="flex size-12 shrink-0 items-center justify-center rounded-lg"
            style={{ backgroundColor: `${providerInfo.color}15` }}
          >
            {headerImgError || !getHeaderIconPath() ? (
              <span className="text-sm font-bold" style={{ color: providerInfo.color }}>
                {providerInfo.textIcon || providerInfo.id.slice(0, 2).toUpperCase()}
              </span>
            ) : (
              <Image
                src={getHeaderIconPath()}
                alt={providerInfo.name}
                width={48}
                height={48}
                className="max-h-12 max-w-12 rounded-lg object-contain"
                sizes="48px"
                onError={() => {
                  markProviderIconMissing(providerInfo.id);
                  setHeaderImgError(true);
                }}
              loading="lazy"
              decoding="async"
              />
            )}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="truncate text-2xl font-semibold tracking-tight sm:text-3xl">{providerInfo.name}</h1>
              {(providerInfo.notice?.webUrl || providerInfo.notice?.apiKeyUrl || providerInfo.notice?.signupUrl || providerInfo.website) && (
                <a
                  href={providerInfo.notice?.webUrl || providerInfo.notice?.apiKeyUrl || providerInfo.notice?.signupUrl || providerInfo.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                >
                  <span className="material-symbols-outlined text-sm">open_in_new</span>
                  {providerInfo.notice?.webUrl
                    ? "Web console"
                    : providerInfo.notice?.apiKeyUrl
                      ? "Get API Key"
                      : "Sign up / Learn more"}
                </a>
              )}
              <InviteCodeChip code={providerInfo.notice?.inviteCode} />
            </div>
            {/* noAuth 免授权供应商（opencode/mimo-free/zcode-free）永远没有连接行，
                「0 connections」是噪音——直接不渲染 */}
            {!isFreeNoAuth && (
              <p className="text-text-muted">
                {connections.length === 1
                  ? translate("1 connection")
                  : translate("{n} connections").replace("{n}", String(connections.length))}
              </p>
            )}
          </div>
        </div>
      </div>

      {providerInfo.deprecated && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
          <span className="material-symbols-outlined text-[16px] text-yellow-500 mt-0.5 shrink-0">warning</span>
          <p className="text-xs text-red-600 dark:text-yellow-400 leading-relaxed">{providerInfo.deprecationNotice}</p>
        </div>
      )}

      {providerInfo.notice?.text && !providerInfo.deprecated && (
        <div className="flex flex-col gap-2 rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2 sm:flex-row sm:items-center">
          <span className="material-symbols-outlined text-[16px] text-blue-500 shrink-0">info</span>
          <p className="min-w-0 flex-1 text-xs leading-relaxed text-blue-600 dark:text-blue-400">{translate(providerInfo.notice.text)}</p>
          {providerInfo.notice.apiKeyUrl && (
            <a
              href={providerInfo.notice.apiKeyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex justify-center rounded bg-blue-500 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-blue-600 sm:py-0.5"
            >
              {translate("Get API Key →")}
            </a>
          )}
        </div>
      )}

      {isCompatible && providerNode && (
        <Card>
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold">{isAnthropicCompatible ? "Anthropic Compatible Details" : "OpenAI Compatible Details"}</h2>
              <p className="break-all text-sm text-text-muted">
                {isAnthropicCompatible ? "Messages API" : (providerNode.apiType === "responses" ? "Responses API" : "Chat Completions")} · {(providerNode.baseUrl || "").replace(/\/$/, "")}/
                {isAnthropicCompatible ? "messages" : (providerNode.apiType === "responses" ? "responses" : "chat/completions")}
              </p>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:flex sm:items-center">
              <Button
                size="sm"
                icon="add"
                onClick={() => {
                  setAddConnectionError("");
                  setShowAddApiKeyModal(true);
                }}
                className="w-full sm:w-auto"
              >
                Add API Key
              </Button>
              <Button
                size="sm"
                variant="secondary"
                icon="edit"
                onClick={() => setShowEditNodeModal(true)}
                className="w-full sm:w-auto"
              >
                Edit
              </Button>
              <Button
                size="sm"
                variant="secondary"
                icon="delete"
                onClick={async () => {
                  setConfirmState({
                    title: "Delete Compatible Node",
                    message: `Delete this ${isAnthropicCompatible ? "Anthropic" : "OpenAI"} Compatible node?`,
                    onConfirm: async () => {
                      setConfirmState(null);
                      try {
                        const res = await fetch(`/api/provider-nodes/${providerId}`, { method: "DELETE" });
                        if (res.ok) {
                          router.push("/dashboard/providers");
                        }
                      } catch (error) {
                        console.log("Error deleting provider node:", error);
                      }
                    }
                  });
                }}
                className="w-full sm:w-auto"
              >
                Delete
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* Connections */}
      {isFreeNoAuth ? (
        <NoAuthProxyCard providerId={providerId} />
      ) : (
        <Card>
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="text-lg font-semibold">{translate("Connections")}</h2>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
              {connections.length > 0 && proxyPools.length > 0 && (
                <Button
                  size="sm"
                  variant="secondary"
                  icon="lan"
                  onClick={() => setShowBulkProxyModal(true)}
                >
                  {translate("Apply Proxy")}
                </Button>
              )}
              {connections.length > 0 && (
                <>
                  {selectedConnectionIds.length > 0 && (
                    <Button
                      size="sm"
                      variant="danger"
                      icon="delete"
                      onClick={handleBulkDelete}
                    >
                      {translate("Delete Selected")} ({selectedConnectionIds.length})
                    </Button>
                  )}
                  {connections.length > 0 && models.length > 1 && (
                    <Select
                      value={oneByOneModel}
                      onChange={(e) => setOneByOneModel(e.target.value)}
                      disabled={oneByOneRunning}
                      options={[
                        { value: ONE_BY_ONE_DEFAULT_MODEL, label: translate("Provider default") },
                        ...models
                          .filter((m) => { const k = getModelKind(m); return !k || k === "llm"; })
                          .map((m) => ({ value: m.id, label: m.name || m.id })),
                      ]}
                      selectClassName="!py-2 !text-xs w-44"
                    />
                  )}
                  <Button
                    size="sm"
                    variant="secondary"
                    icon="sync"
                    onClick={handleRunOneByOneTest}
                    disabled={oneByOneRunning}
                  >
                    {oneByOneRunning ? translate("Testing Connection One-by-One...") : translate("Test Connection One-by-One")}
                  </Button>
                  {oneByOneRunning && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="stop"
                      onClick={handleStopOneByOneTest}
                      disabled={oneByOneStopping}
                    >
                      {oneByOneStopping ? translate("Stopping...") : translate("Stop")}
                    </Button>
                  )}
                </>
              )}
              {/* Strategy Controls - Differentiated by Quota Category */}
              {(() => {
                const quotaCat = getProviderQuotaCategory(providerId);

                // 1. Pack Asset Providers (CodeBuddy, Qoder)
                if (quotaCat === PROVIDER_QUOTA_TYPES.PACK_ASSET) {
                  const currentValue = earliestExpiryFirst ? "earliest" : (providerStrategy === "round-robin" ? "round-robin" : "priority");
                  return (
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-text-muted font-medium">
                          {translate("Scheduling Preference")}
                        </span>
                        <Select
                          value={currentValue}
                          onChange={(e) => handlePackOrSubStrategyChange(e.target.value)}
                          options={[
                            { value: "earliest", label: translate("Earliest Pack Expiry") },
                            { value: "round-robin", label: translate("Round Robin (Balanced)") },
                            { value: "priority", label: translate("Manual Priority (#1 → #2)") },
                          ]}
                          selectClassName="!py-1 !text-xs w-48"
                        />
                      </div>
                      {currentValue === "round-robin" && (
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs text-text-muted">{translate("Sticky:")}</span>
                          <input
                            type="number"
                            min={1}
                            value={providerStickyLimit}
                            onChange={(e) => handleStickyLimitChange(e.target.value)}
                            placeholder="1"
                            className="w-14 px-2 py-1 text-xs border border-border rounded-md bg-surface focus:outline-none focus:border-primary"
                          />
                        </div>
                      )}
                    </div>
                  );
                }

                // 2. Rolling Subscription Providers (Antigravity, GitHub, Codex, GLM)
                if (quotaCat === PROVIDER_QUOTA_TYPES.ROLLING_SUBSCRIPTION) {
                  const currentValue = earliestExpiryFirst ? "earliest" : (providerStrategy === "round-robin" ? "round-robin" : "priority");
                  return (
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-text-muted font-medium">
                          {translate("Scheduling Preference")}
                        </span>
                        <Select
                          value={currentValue}
                          onChange={(e) => handlePackOrSubStrategyChange(e.target.value)}
                          options={[
                            { value: "earliest", label: translate("Subscription Relay") },
                            { value: "round-robin", label: translate("Round Robin (Balanced)") },
                            { value: "priority", label: translate("Manual Priority (#1 → #2)") },
                          ]}
                          selectClassName="!py-1 !text-xs w-48"
                        />
                      </div>
                      {currentValue === "round-robin" && (
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs text-text-muted">{translate("Sticky:")}</span>
                          <input
                            type="number"
                            min={1}
                            value={providerStickyLimit}
                            onChange={(e) => handleStickyLimitChange(e.target.value)}
                            placeholder="1"
                            className="w-14 px-2 py-1 text-xs border border-border rounded-md bg-surface focus:outline-none focus:border-primary"
                          />
                        </div>
                      )}
                    </div>
                  );
                }

                // 3. Pure Balance Providers (DeepSeek, StepFun, OpenAI, Anthropic, etc.)
                if (quotaCat === PROVIDER_QUOTA_TYPES.PURE_BALANCE) {
                  return (
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-text-muted font-medium">
                          {translate("Scheduling Preference")}
                        </span>
                        <Select
                          value={balanceStrategy}
                          onChange={(e) => handleBalanceStrategyChange(e.target.value)}
                          options={[
                            { value: "priority", label: translate("Manual Priority (#1 → #2)") },
                            { value: "lowest-first", label: translate("Lowest Balance First") },
                            { value: "highest-first", label: translate("Highest Balance First") },
                            { value: "round-robin", label: translate("Round Robin (Balanced)") },
                          ]}
                          selectClassName="!py-1 !text-xs w-48"
                        />
                      </div>
                      {balanceStrategy === "round-robin" && (
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs text-text-muted">{translate("Sticky:")}</span>
                          <input
                            type="number"
                            min={1}
                            value={providerStickyLimit}
                            onChange={(e) => handleStickyLimitChange(e.target.value)}
                            placeholder="1"
                            className="w-14 px-2 py-1 text-xs border border-border rounded-md bg-surface focus:outline-none focus:border-primary"
                          />
                        </div>
                      )}
                    </div>
                  );
                }

                // 4. Gateway Free Providers
                if (quotaCat === PROVIDER_QUOTA_TYPES.GATEWAY_FREE) {
                  return (
                    <span className="text-xs text-text-muted bg-surface px-2.5 py-1 rounded-md border border-border">
                      {translate("Gateway Managed Auto Routing")}
                    </span>
                  );
                }

                // 5. GENERIC Fallback (Safe default for third-party / unknown / custom providers)
                const fallbackCurrentValue = earliestExpiryFirst ? "earliest" : (providerStrategy === "round-robin" ? "round-robin" : "priority");
                return (
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-text-muted font-medium">
                        {translate("Scheduling Preference")}
                      </span>
                      <Select
                        value={fallbackCurrentValue}
                        onChange={(e) => handlePackOrSubStrategyChange(e.target.value)}
                        options={[
                          { value: "earliest", label: translate("Earliest Expiry First") },
                          { value: "round-robin", label: translate("Round Robin (Balanced)") },
                          { value: "priority", label: translate("Manual Priority (#1 → #2)") },
                        ]}
                        selectClassName="!py-1 !text-xs w-48"
                      />
                    </div>
                    {fallbackCurrentValue === "round-robin" && (
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs text-text-muted">{translate("Sticky:")}</span>
                        <input
                          type="number"
                          min={1}
                          value={providerStickyLimit}
                          onChange={(e) => handleStickyLimitChange(e.target.value)}
                          placeholder="1"
                          className="w-14 px-2 py-1 text-xs border border-border rounded-md bg-surface focus:outline-none focus:border-primary"
                        />
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>

          {connections.length === 0 ? (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <div className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-primary/10 text-primary shrink-0">
                  <span className="material-symbols-outlined text-[18px]">{isOAuth ? "lock" : "key"}</span>
                </div>
                <div className="min-w-0">
                  <p className="text-sm text-text-muted">No connections yet</p>
                  {hasDualAuthModes && (
                    <p className="text-xs text-text-muted">
                      Choose {oauthConnectionLabel} or {apiKeyConnectionLabel}.
                    </p>
                  )}
                </div>
              </div>
              <div className="flex gap-2">
                {hasDualAuthModes ? (
                  <>
                    <Button size="sm" icon="lock" variant="secondary" onClick={triggerOAuthConnection}>
                      {oauthConnectionLabel}
                    </Button>
                    <Button size="sm" icon="key" onClick={triggerApiKeyConnection}>
                      {apiKeyConnectionLabel}
                    </Button>
                    {renderOAuthTransferButtons()}
                    {/* No connections yet: do not show check-in / claim credits */}
                  </>
                ) : (
                  <>
                    {!isCompatible && providerId === "iflow" && (
                      <Button size="sm" icon="cookie" variant="secondary" onClick={() => setShowIFlowCookieModal(true)}>
                        Cookie
                      </Button>
                    )}
                    {/* No connections yet: do not show check-in / claim credits */}
                    {providerId === "codex" && (
                      <Button size="sm" icon="playlist_add" variant="secondary" onClick={() => setShowBulkImportCodex(true)}>
                        {translate("Bulk Add")}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      icon="add"
                      onClick={triggerAddConnection}
                    >
                      {isCompatible ? "Add API Key" : (providerId === "iflow" ? "OAuth" : providerId === "mimo-desktop" ? (
                        <span className="inline-flex items-center gap-1">
                          {translate("Connect with Desktop Session")}
                          <Tooltip text={translate("Requires sign-in to Xiaomi MiMo Desktop app first")} position="top">
                            <span className="material-symbols-outlined text-[14px] opacity-60">info</span>
                          </Tooltip>
                        </span>
                      ) : "Add Connection")}
                    </Button>
                    {renderOAuthTransferButtons()}
                  </>
                )}
              </div>
            </div>
          ) : (
            <>
              {oneByOneSummary && (
                <div className="mb-4 rounded-lg border border-black/10 bg-black/[0.02] px-3 py-2 text-xs text-text-muted dark:border-white/10 dark:bg-white/[0.03]">
                  <div className="flex flex-wrap items-center gap-3">
                    <span>{translate("Total:")} {oneByOneSummary.total}</span>
                    <span>{translate("Completed:")} {oneByOneSummary.completed}</span>
                    <span>{translate("Passed:")} {oneByOneSummary.passed}</span>
                    <span>{translate("Failed:")} {oneByOneSummary.failed}</span>
                    {oneByOneSummary.stopped && (
                      <span className="text-amber-600 dark:text-amber-400">{translate("Stopped")}</span>
                    )}
                    {oneByOneRunning && oneByOneCurrentConnectionId && (
                      <span>{translate("Running:")} {connections.find((conn) => conn.id === oneByOneCurrentConnectionId)?.name || oneByOneCurrentConnectionId}</span>
                    )}
                  </div>
                </div>
              )}
              {connections.length > 0 && (
                <div className="mb-3 flex items-center gap-2 border-b border-black/[0.03] pb-2 dark:border-white/[0.03]">
                  <label className="flex cursor-pointer items-center gap-1.5 text-xs text-text-muted hover:text-primary">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleSelectAllConnections}
                      className="h-3.5 w-3.5 rounded border-gray-300 text-primary focus:ring-primary"
                    />
                    {translate("Select All")}
                  </label>
                </div>
              )}
              {connectionsList}
              {!isCompatible && (
                <div className="mt-4 grid grid-cols-1 gap-2 sm:flex">
                  {providerId === "iflow" && (
                    <Button
                      size="sm"
                      icon="cookie"
                      variant="secondary"
                      onClick={() => setShowIFlowCookieModal(true)}
                      title="Add connection using browser cookie"
                      className="w-full sm:w-auto"
                    >
                      Cookie
                    </Button>
                  )}
                  {providerId === "codex" && (
                    <Button
                      size="sm"
                      icon="playlist_add"
                      variant="secondary"
                      onClick={() => setShowBulkImportCodex(true)}
                      title={translate("Bulk import codex accounts from JSON")}
                      className="w-full sm:w-auto"
                    >
                      {translate("Bulk Add")}
                    </Button>
                  )}
                  {hasDualAuthModes ? (
                    <>
                      <Button
                        size="sm"
                        icon="lock"
                        variant="secondary"
                        onClick={triggerOAuthConnection}
                        className="w-full sm:w-auto"
                      >
                        {oauthConnectionLabel}
                      </Button>
                      <Button
                        size="sm"
                        icon="key"
                        onClick={triggerApiKeyConnection}
                        className="w-full sm:w-auto"
                      >
                        {apiKeyConnectionLabel}
                      </Button>
                      {renderOAuthTransferButtons("w-full sm:w-auto")}
                      {codeBuddyCheckinOn && renderCbCheckinBlock()}
                      {hasClaimCheckin && renderQoderCheckinBlock()}
                    </>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        icon="add"
                        onClick={triggerAddConnection}
                        className="w-full sm:w-auto"
                      >
                        Add
                      </Button>
                      {renderOAuthTransferButtons("w-full sm:w-auto")}
                      {hasClaimCheckin && renderQoderCheckinBlock()}
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </Card>
      )}

      {/* Models */}
      <Card>
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold">
              {"Available Models"}
            </h2>
            {providerThinkingLevels && (
              <select
                value={thinkingMode}
                onChange={(e) => handleThinkingModeChange(e.target.value)}
                title="Appends (level) suffix to copied model names"
                className="rounded-md border border-border bg-surface px-2 py-1 text-xs focus:border-primary focus:outline-none"
              >
                {providerThinkingLevels.map((opt) => (
                  <option key={opt} value={opt}>{`Thinking: ${opt.charAt(0).toUpperCase() + opt.slice(1)}`}</option>
                ))}
              </select>
            )}
          </div>
          {!isCompatible && (() => {
            const allIds = [
              ...models,
              ...kiloFreeModels.filter((fm) => !models.some((m) => m.id === fm.id)),
            ].filter((m) => { const k = getModelKind(m); return !k || k === "llm"; }).map((m) => m.id);
            const activeIds = allIds.filter((id) => !disabledModelIds.includes(id));
            // Fetched/imported models carry their own enabled flag; keep the
            // bulk buttons in sync so "Active All" doesn't skip them.
            const providerCustoms = customModels.filter(
              (m) => m?.providerAlias === providerStorageAlias && (m.kind || m.type || "llm") === "llm"
            );
            const enabledCustomIds = providerCustoms.filter((m) => m.enabled !== false).map((m) => m.id);
            const disabledCustomIds = providerCustoms.filter((m) => m.enabled === false).map((m) => m.id);
            const showEnableAll = disabledModelIds.length > 0 || disabledCustomIds.length > 0;
            const showDisableAll = activeIds.length > 0 || enabledCustomIds.length > 0;
            return (
              <div className="flex gap-2">
                {showEnableAll && (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon="restart_alt"
                    onClick={() => handleEnableAll(disabledCustomIds)}
                  >
                    Active All
                  </Button>
                )}
                {showDisableAll && (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon="block"
                    onClick={() => handleDisableAll(activeIds, enabledCustomIds)}
                  >
                    Disable All
                  </Button>
                )}
              </div>
            );
          })()}
        </div>
        {!!modelsTestError && (() => {
          const verificationUrl = extractAccountsVerificationUrl(modelsTestError);
          const displayError = formatModelTestError(modelsTestError);
          return (
            <p className="text-xs text-red-500 mb-3 break-words">
              {displayError}{" "}
              {verificationUrl && (
                <>
                  <a
                    href={verificationUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={translate("Recommended: open in an incognito window and sign in with the affected account")}
                    className="text-blue-500 underline hover:text-blue-400"
                  >
                    {translate("Verify your account")}
                  </a>
                  {" "}
                  <button
                    type="button"
                    onClick={() => copy(verificationUrl, "verification")}
                    className="text-text-muted underline hover:text-primary"
                  >
                    {copied === "verification" ? translate("Copied") : translate("Copy link")}
                  </button>
                  <span className="text-text-muted">
                    {" "}（{translate("Recommended: open in an incognito window and sign in with the affected account")}）
                  </span>
                </>
              )}
            </p>
          );
        })()}
        {renderModelsSection()}
      </Card>

      {bulkActionModal}

      {/* Modals */}
      {providerId === "kiro" ? (
        <KiroOAuthWrapper
          isOpen={showOAuthModal}
          providerInfo={providerInfo}
          onSuccess={handleOAuthSuccess}
          onClose={() => setShowOAuthModal(false)}
        />
      ) : providerId === "cursor" ? (
        <CursorAuthModal
          isOpen={showOAuthModal}
          onSuccess={handleOAuthSuccess}
          onClose={() => setShowOAuthModal(false)}
        />
      ) : providerId === "zed" ? (
        <ZedAuthModal
          isOpen={showOAuthModal}
          providerInfo={providerInfo}
          onSuccess={handleOAuthSuccess}
          onClose={() => setShowOAuthModal(false)}
        />
      ) : providerId === "gitlab" ? (
        <GitLabAuthModal
          isOpen={showOAuthModal}
          providerInfo={providerInfo}
          onSuccess={handleOAuthSuccess}
          onClose={() => setShowOAuthModal(false)}
        />
      ) : (
        <OAuthModal
          isOpen={showOAuthModal}
          provider={providerId}
          providerInfo={providerInfo}
          onSuccess={handleOAuthSuccess}
          onClose={() => setShowOAuthModal(false)}
        />
      )}
      {(providerId === "xiaomi-mimo" || providerId === "mimo-desktop") && (
        <XiaomiMimoAuthModal
          provider={providerId}
          isOpen={showXiaomiMimoModal}
          onSuccess={handleOAuthSuccess}
          onClose={() => setShowXiaomiMimoModal(false)}
        />
      )}
      {providerId === "iflow" && (
        <IFlowCookieModal
          isOpen={showIFlowCookieModal}
          onSuccess={handleIFlowCookieSuccess}
          onClose={() => setShowIFlowCookieModal(false)}
        />
      )}
      <AddApiKeyModal
        isOpen={showAddApiKeyModal}
        provider={providerId}
        providerName={providerInfo.name}
        isCompatible={isCompatible}
        isAnthropic={isAnthropicCompatible}
        authType={providerInfo?.authType}
        authHint={providerInfo?.authHint}
        website={providerInfo?.website}
        proxyPools={proxyPools}
        error={addConnectionError}
        existingNames={connections.map((c) => c.name).filter(Boolean)}
        onSave={handleSaveApiKey}
        onBulkDone={refreshAfterConnectionChange}
        onClose={() => {
          setAddConnectionError("");
          setShowAddApiKeyModal(false);
        }}
      />
      <EditConnectionModal
        isOpen={showEditModal}
        connection={selectedConnection}
        proxyPools={proxyPools}
        onSave={handleUpdateConnection}
        onClose={() => setShowEditModal(false)}
      />
      {isCompatible && (
        <EditCompatibleNodeModal
          isOpen={showEditNodeModal}
          node={providerNode}
          onSave={handleUpdateNode}
          onClose={() => setShowEditNodeModal(false)}
          isAnthropic={isAnthropicCompatible}
        />
      )}
      {!isCompatible && (
        <AddCustomModelModal
          isOpen={showAddCustomModel}
          providerAlias={providerStorageAlias}
          providerDisplayAlias={providerDisplayAlias}
          onSave={async (modelId, caps, modelType, transport) => {
            await handleAddCustomModel(modelId, modelType || "llm", providerStorageAlias, caps || {}, undefined, transport);
            setShowAddCustomModel(false);
          }}
          onClose={() => setShowAddCustomModel(false)}
        />
      )}

      {providerId === "codex" && (
        <BulkImportCodexModal
          isOpen={showBulkImportCodex}
          onClose={() => setShowBulkImportCodex(false)}
          onSuccess={fetchConnections}
        />
      )}

      {providerId === "codebuddy-cn" && (
        <CodeBuddyImportModal
          isOpen={showCodeBuddyImport}
          password={cbImportPassword}
          onClose={() => setShowCodeBuddyImport(false)}
          onSuccess={fetchConnections}
        />
      )}

      {/* Encrypted OAuth credentials transfer (all OAuth providers) */}
      <OAuthTransferModal
        isOpen={showOAuthTransfer}
        mode={oauthTransferMode}
        provider={providerId}
        providerName={providerInfo?.name}
        dashboardPassword={oauthTransferPassword}
        onClose={() => { setShowOAuthTransfer(false); setOauthTransferPassword(""); }}
        onSuccess={fetchConnections}
      />

      {/* cbcn export/import password re-auth */}
      <Modal
        isOpen={cbPw.open}
        onClose={() => setCbPw({ open: false, action: null, value: "" })}
        title={translate("Confirm Password")}
        size="sm"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setCbPw({ open: false, action: null, value: "" })}
            >
              {translate("Cancel")}
            </Button>
            <Button
              variant="primary"
              onClick={handleCbPwConfirm}
              disabled={!cbPw.value || cbPwVerifying}
            >
              {cbPwVerifying ? translate("Verifying...") : translate("Confirm")}
            </Button>
          </>
        }
      >
        <p className="text-text-muted mb-3 text-sm">
          {translate("Enter your dashboard password to export OAuth accounts (the file will be encrypted with the transfer passphrase you pick next).")}
        </p>
        <Input
          type="password"
          reveal
          autoFocus
          value={cbPw.value}
          onChange={(e) => setCbPw((p) => ({ ...p, value: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && cbPw.value) handleCbPwConfirm();
          }}
          placeholder={translate("Password")}
        />
        {cbPwError && <p className="text-xs text-red-500 mt-2">{cbPwError}</p>}
      </Modal>

      {/* AG Risk Confirmation Modal */}
      <ConfirmModal
        isOpen={showAgRiskModal}
        onClose={() => setShowAgRiskModal(false)}
        onConfirm={handleAgRiskConfirm}
        title="Risk Notice"
        message={providerInfo?.deprecationNotice}
        confirmText="I Understand, Continue"
        cancelText="Cancel"
        variant="danger"
      />

      {/* Confirm Modal */}
      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Confirm"}
        message={confirmState?.message}
        variant="danger"
      />

      {scheduleConnection && (
        <AutoPingScheduleModal
          isOpen={!!scheduleConnection}
          onClose={() => setScheduleConnection(null)}
          connection={scheduleConnection}
          reactive={autoPing.connections[scheduleConnection.id] === true}
          schedule={autoPing.schedules?.[scheduleConnection.id] || null}
          onSave={(result) => handleSaveAutoPing(scheduleConnection.id, result)}
        />
      )}
    </div>
  );
}
