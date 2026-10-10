"use client";

import { useState, useEffect, useRef } from "react";
import { getStatusVariant as getConnectionStatusVariant } from "@/shared/utils/connectionStatus";
import { classifyConnectionCooldown, sameConnectionCooldown } from "@/shared/utils/connectionCooldown";
import { translate } from "@/i18n/runtime";
import { extractAccountsVerificationUrl, extractRealnameVerificationUrl } from "@/shared/utils/validationUrl";
import { translateQuotaError } from "@/shared/utils/quotaError";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import PropTypes from "prop-types";
import { Badge, Toggle, Tooltip } from "@/shared/components";
import CooldownTimer from "./CooldownTimer";

function formatExpiry(iso) {
  if (!iso) return "";
  const diffMs = new Date(iso).getTime() - Date.now();
  if (diffMs <= 0) return translate("expired");
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  // A multi-day wait must not collapse to "1d" — "1d 17h" is what the user is
  // actually deciding about. Exact multiples stay bare ("2d", never "2d 0h").
  if (days < 30) return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
  return new Date(iso).toLocaleDateString();
}

export default function ConnectionRow({ connection, proxyPools, isOAuth, isFirst, isLast, onMoveUp, onMoveDown, onToggleActive, onUpdateProxy, onEdit, onDelete, oneByOneStatus = null, autoPing = null }) {
  const [showProxyDropdown, setShowProxyDropdown] = useState(false);
  const [updatingProxy, setUpdatingProxy] = useState(false);
  const proxyDropdownRef = useRef(null);

  const proxyPoolMap = new Map((proxyPools || []).map((pool) => [pool.id, pool]));
  const boundProxyPoolId = connection.providerSpecificData?.proxyPoolId || null;
  const boundProxyPool = boundProxyPoolId ? proxyPoolMap.get(boundProxyPoolId) : null;
  const hasLegacyProxy = connection.providerSpecificData?.connectionProxyEnabled === true && !!connection.providerSpecificData?.connectionProxyUrl;
  const hasAnyProxy = !!boundProxyPoolId || hasLegacyProxy;
  const proxyDisplayText = boundProxyPool
    ? `Pool: ${boundProxyPool.name}`
    : boundProxyPoolId
      ? `Pool: ${boundProxyPoolId} (inactive/missing)`
      : hasLegacyProxy
        ? `Legacy: ${connection.providerSpecificData?.connectionProxyUrl}`
        : "";
  const autoPingTooltip = autoPing?.provider === "codex"
    ? "Auto-starts the next 5h Codex window after reset by sending a tiny gpt-5.5 request. Consumes a small amount of quota."
    : "When your 5h quota runs out, auto-sends a request the moment it resets so a new window starts right away.";

  let maskedProxyUrl = "";
  if (boundProxyPool?.proxyUrl || connection.providerSpecificData?.connectionProxyUrl) {
    const rawProxyUrl = boundProxyPool?.proxyUrl || connection.providerSpecificData?.connectionProxyUrl;
    try {
      const parsed = new URL(rawProxyUrl);
      maskedProxyUrl = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
    } catch {
      maskedProxyUrl = rawProxyUrl;
    }
  }

  const noProxyText = boundProxyPool?.noProxy || connection.providerSpecificData?.connectionNoProxy || "";

  let proxyBadgeVariant = "default";
  if (boundProxyPool?.isActive === true) {
    proxyBadgeVariant = "success";
  } else if (boundProxyPoolId || hasLegacyProxy) {
    proxyBadgeVariant = "error";
  }

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!showProxyDropdown) return;
    const handler = (e) => {
      if (proxyDropdownRef.current && !proxyDropdownRef.current.contains(e.target)) {
        setShowProxyDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showProxyDropdown]);

  const handleSelectProxy = async (poolId) => {
    setUpdatingProxy(true);
    try {
      await onUpdateProxy(poolId === "__none__" ? null : poolId);
    } finally {
      setUpdatingProxy(false);
      setShowProxyDropdown(false);
    }
  };

  const rowAuthType = connection.authType || (isOAuth ? "oauth" : "apikey");
  const isOAuthConnection = rowAuthType === "oauth";
  const isCookieConnection = rowAuthType === "cookie";
  // Label by WHAT CREDENTIALS THE ROW ACTUALLY HOLDS, not by which flow wrote
  // it last. Since the three-card split a session can only live on the Desktop
  // card, so the both-halves shape only occurs there (session + a manually
  // added sk- key). The cloud card's rows hold a key alone — an older build
  // folded the machine's Desktop session into them, which is what made that
  // card advertise "Desktop Session"; migration 005 removed those fields.
  //   session + key → two badges: "Desktop Session" + "Browser sign-in"
  //   session only  → "Desktop Session"
  //   key only      → "Browser sign-in" (oauth) / "API Key" (manual paste)
  const authMethod = connection.providerSpecificData?.authMethod;
  // The providers API strips tokens, so capability flags come from the server
  // (hasAccessToken / hasDesktopSession); the raw-token heuristics remain as a
  // fallback for callers that still hold the full row.
  const rawToken = typeof connection.accessToken === "string" ? connection.accessToken : "";
  const hasSession =
    connection.hasDesktopSession ?? Boolean(connection.providerSpecificData?.mimoPassToken);
  const hasRealKey =
    connection.hasAccessToken ??
    (rawToken.length > 0 && !rawToken.startsWith("mimo-desktop-session"));
  const isDesktopSession = authMethod === "desktop-session" || (hasSession && !hasRealKey);
  const isSessionPlusKey = hasSession && hasRealKey;
  const isBrowserOAuth = !isSessionPlusKey && !isDesktopSession && authMethod === "oauth";
  // Row icon: desktop session wins when present, then browser sign-in, then key.
  const authIcon = hasSession
    ? "computer"
    : isBrowserOAuth
      ? "login"
      : isCookieConnection
        ? "cookie"
        : isOAuthConnection
          ? "lock"
          : "key";
  // One badge per credential held — no icons inside badges (the row icon
  // already carries that meaning).
  const authLabel = isDesktopSession || isSessionPlusKey
    ? translate("Desktop Session")
    : isBrowserOAuth
      ? translate("Browser sign-in")
      : isOAuthConnection
        ? "OAuth"
        : isCookieConnection
          ? "Cookie"
          : "API Key";
  const secondaryAuthLabel = isSessionPlusKey ? translate("Browser sign-in") : null;
  // Multi-account readability: MiMo rows otherwise read as a bare
  // "6786673@xiaomi" address. Prefer an explicit name, then the Xiaomi account
  // id in a friendlier shape, then whatever identity the row carries.
  const xiaomiUid =
    connection.providerSpecificData?.mimoUserId || connection.providerSpecificData?.uid || null;
  const isXiaomi = connection.provider === "xiaomi-mimo" || connection.provider === "xiaomi-tokenplan";
  const xiaomiDisplayName = isXiaomi && xiaomiUid ? `MiMo ${xiaomiUid}` : null;

  const rawName = connection.name?.trim();
  const rawEmail = connection.email?.trim();
  const rawDisplay = connection.displayName?.trim();
  const hasCustomName = Boolean(rawName && rawName !== rawEmail && (!rawDisplay || rawName !== rawDisplay));

  const displayName = rawName
    || xiaomiDisplayName
    || rawEmail
    || rawDisplay
    || (isOAuthConnection ? "OAuth Account" : isCookieConnection ? "Cookie Account" : "API Key");

  const secondaryDisplayName = hasCustomName
    ? null
    : rawName && rawEmail && rawName !== rawEmail
      ? rawEmail
      : xiaomiDisplayName && rawEmail && rawEmail !== xiaomiDisplayName
        ? rawEmail
        : rawName && rawDisplay && rawName !== rawDisplay
          ? rawDisplay
          : null;

  // Single source of truth for the cooldown reading (issue #46). This used to
  // be recomputed twice in this file with two different filters: the value fed
  // the countdown chip sorted lock STRINGS with no expiry check, while the
  // boolean compared against Date.now() — so the chip could show a lock that had
  // already lapsed while the badge said the account was fine. One helper, one
  // answer, and the model names survive for the message below.
  //
  // Lazy initializer classifies ONCE for the first paint, so a connection that
  // mounts already-unavailable doesn't flash green for a frame before the
  // effect corrects it. The 1s interval below owns every later tick; the tick
  // bails out via sameConnectionCooldown because classification returns a fresh
  // object each call, and identity comparison would re-render a locked row
  // every second even though nothing visible changed (the countdown ticks on
  // CooldownTimer's own clock).
  const [cooldown, setCooldown] = useState(() => classifyConnectionCooldown(connection));

  useEffect(() => {
    const checkCooldown = () => {
      setCooldown((prev) => {
        const next = classifyConnectionCooldown(connection);
        return sameConnectionCooldown(prev, next) ? prev : next;
      });
    };

    checkCooldown();
    const hasAnyLock = Object.keys(connection).some((k) => k.startsWith("modelLock_") && connection[k]);
    const interval = hasAnyLock ? setInterval(checkCooldown, 1000) : null;
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [connection]);

  const { state: effectiveStatus, earliestUntil: modelLockUntil } = cooldown;
  // Only a live lock shows a countdown. "partial" means some models are
  // cooling; "unavailable" means the whole account is.
  const isCooldown = effectiveStatus === "partial" || effectiveStatus === "unavailable";
  // "partial" is a new state (#46); every other status is already a word a user
  // can read, so only the new one needs a label. "needs-reauth" (dead refresh
  // token) is the second: the raw token would render as "needs-reauth".
  const statusLabel = effectiveStatus === "needs-reauth"
    ? translate("Needs re-auth")
    : effectiveStatus === "partial" ? translate("Partial") : effectiveStatus;

  // Google VALIDATION_REQUIRED errors surface their "Verify your account" URL in
  // the message text — render it as a jump link instead of a dead red string.
  // Real-name (实名) gates (StepFun CN) carry a face-verification URL instead;
  // same user need, different page, so fall back to it with its own link text.
  const verificationUrl = connection.isActive !== false
    ? extractAccountsVerificationUrl(connection.lastError)
    : null;
  const realnameUrl = connection.isActive !== false && !verificationUrl
    ? extractRealnameVerificationUrl(connection.lastError)
    : null;
  const gateUrl = verificationUrl || realnameUrl;
  const { copied, copy } = useCopyToClipboard();

  const getStatusVariant = () => getConnectionStatusVariant(connection.isActive, effectiveStatus);

  const getOneByOneVariant = () => {
    if (!oneByOneStatus) return "default";
    if (oneByOneStatus.state === "success") return "success";
    if (oneByOneStatus.state === "failed") return "error";
    if (oneByOneStatus.state === "testing") return "primary";
    return "default";
  };

  const getOneByOneLabel = () => {
    if (!oneByOneStatus) return null;
    if (oneByOneStatus.state === "queued") return translate("queued");
    if (oneByOneStatus.state === "testing") return translate("testing");
    if (oneByOneStatus.state === "success") return translate("success");
    if (oneByOneStatus.state === "failed") return oneByOneStatus.error ? `${translate("failed")}: ${oneByOneStatus.error}` : translate("failed");
    return null;
  };

  return (
    <div className={`group flex min-w-0 flex-col gap-3 rounded-lg p-2 transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.02] sm:flex-row sm:items-center sm:justify-between ${connection.isActive === false ? "opacity-60" : ""}`}>
      <div className="flex min-w-0 flex-1 items-start gap-2 sm:items-center sm:gap-3">
        {/* Priority arrows */}
        <div className="flex shrink-0 flex-col">
          <button
            onClick={onMoveUp}
            disabled={isFirst}
            className={`p-0.5 rounded ${isFirst ? "text-text-muted/30 cursor-not-allowed" : "hover:bg-sidebar text-text-muted hover:text-primary"}`}
          >
            <span className="material-symbols-outlined text-sm">keyboard_arrow_up</span>
          </button>
          <button
            onClick={onMoveDown}
            disabled={isLast}
            className={`p-0.5 rounded ${isLast ? "text-text-muted/30 cursor-not-allowed" : "hover:bg-sidebar text-text-muted hover:text-primary"}`}
          >
            <span className="material-symbols-outlined text-sm">keyboard_arrow_down</span>
          </button>
        </div>
        <span className="material-symbols-outlined shrink-0 text-base text-text-muted">
          {authIcon}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{displayName}</p>
          {secondaryDisplayName && (
            <p className="text-xs text-text-muted truncate">{secondaryDisplayName}</p>
          )}
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 sm:gap-2">
            <Badge variant={getStatusVariant()} size="sm" dot>
              {connection.isActive === false ? translate("disabled") : (statusLabel || translate("Unknown"))}
            </Badge>
            <Badge variant="default" size="sm">
              {authLabel}
            </Badge>
            {secondaryAuthLabel && (
              <Badge variant="default" size="sm">
                {secondaryAuthLabel}
              </Badge>
            )}
            {hasAnyProxy && (
              <Badge variant={proxyBadgeVariant} size="sm">
                Proxy
              </Badge>
            )}
            {connection.earliestPackageExpiry && (
              <Badge
                variant="outline"
                size="sm"
                title={`${translate("Earliest package")}: ${connection.earliestPackageName || translate("Quota package")} (${new Date(connection.earliestPackageExpiry).toLocaleString()})`}
              >
                <span className="material-symbols-outlined text-[12px] mr-1">schedule</span>
                {formatExpiry(connection.earliestPackageExpiry)}
              </Badge>
            )}
            {isCooldown && connection.isActive !== false && !connection.lastError && <CooldownTimer until={modelLockUntil} />}
            {connection.lastError && connection.isActive !== false && (
              <span className="inline-flex items-center gap-1 max-w-full truncate text-xs text-red-500 sm:max-w-[380px]" title={translateQuotaError(connection.lastError)}>
                {isCooldown && <CooldownTimer until={modelLockUntil} inline />}
                {translateQuotaError(connection.lastError)}
              </span>
            )}
            {gateUrl && (
              <>
                <a
                  href={gateUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={translate("Recommended: open in an incognito window and sign in with the affected account")}
                  className="shrink-0 text-xs text-blue-500 underline hover:text-blue-400"
                >
                  {translate(realnameUrl ? "Complete verification" : "Verify your account")}
                </a>
                <button
                  type="button"
                  onClick={() => copy(gateUrl, "verification")}
                  title={translate("Copy link")}
                  className="shrink-0 text-xs text-text-muted hover:text-primary"
                >
                  <span className="material-symbols-outlined text-sm align-middle">
                    {copied === "verification" ? "check" : "content_copy"}
                  </span>
                </button>
              </>
            )}
            <span className="text-xs text-text-muted">#{connection.priority}</span>
            {connection.globalPriority && (
              <span className="text-xs text-text-muted">Auto: {connection.globalPriority}</span>
            )}
            {getOneByOneLabel() && (
              <Badge variant={getOneByOneVariant()} size="sm">
                {getOneByOneLabel()}
              </Badge>
            )}
          </div>
          {hasAnyProxy && (
            <div className="mt-1 flex items-center gap-2 flex-wrap">
              <span className="max-w-full truncate text-[11px] text-text-muted sm:max-w-[420px]" title={proxyDisplayText}>
                {proxyDisplayText}
              </span>
              {maskedProxyUrl && (
                <code className="max-w-full truncate rounded bg-black/5 px-1 py-0.5 font-mono text-[10px] text-text-muted dark:bg-white/5 sm:max-w-[260px]">
                  {maskedProxyUrl}
                </code>
              )}
              {noProxyText && (
                <span className="max-w-full truncate text-[11px] text-text-muted sm:max-w-[320px]" title={noProxyText}>
                  no_proxy: {noProxyText}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="flex w-full items-center justify-between gap-2 sm:w-auto sm:justify-end">
        <div className="grid flex-1 grid-cols-3 gap-1 sm:flex sm:flex-none">
          {/* Proxy button with inline dropdown */}
          {(proxyPools || []).length > 0 && (
            <div className="relative" ref={proxyDropdownRef}>
              <button
                onClick={() => setShowProxyDropdown((v) => !v)}
                className={`flex w-full flex-col items-center rounded px-2 py-1 transition-colors hover:bg-black/5 dark:hover:bg-white/5 ${hasAnyProxy ? "text-primary" : "text-text-muted hover:text-primary"}`}
                disabled={updatingProxy}
              >
                <span className="material-symbols-outlined text-[18px]">
                  {updatingProxy ? "progress_activity" : "lan"}
                </span>
                <span className="text-[10px] leading-tight">Proxy</span>
              </button>
              {showProxyDropdown && (
                <div className="absolute right-0 top-full z-50 mt-1 max-w-[78vw] min-w-[160px] rounded-lg border border-border bg-bg py-1 shadow-lg">
                  <button
                    onClick={() => handleSelectProxy("__none__")}
                    className={`w-full text-left px-3 py-1.5 text-sm hover:bg-black/5 dark:hover:bg-white/5 ${!boundProxyPoolId ? "text-primary font-medium" : "text-text-main"}`}
                  >
                    None
                  </button>
                  {(proxyPools || []).map((pool) => (
                    <button
                      key={pool.id}
                      onClick={() => handleSelectProxy(pool.id)}
                      className={`w-full text-left px-3 py-1.5 text-sm hover:bg-black/5 dark:hover:bg-white/5 ${boundProxyPoolId === pool.id ? "text-primary font-medium" : "text-text-main"}`}
                    >
                      {pool.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {autoPing && (
            <Tooltip text={autoPingTooltip}>
              <button
                onClick={() => autoPing.onToggle(!autoPing.on)}
                className={`flex w-full flex-col items-center rounded px-2 py-1 transition-colors hover:bg-black/5 dark:hover:bg-white/5 ${autoPing.on ? "text-primary" : "text-text-muted hover:text-primary"}`}
              >
                <span className="material-symbols-outlined text-[18px]">bolt</span>
                <span className="text-[10px] leading-tight">Auto-ping</span>
              </button>
            </Tooltip>
          )}
          <button onClick={onEdit} className="flex flex-col items-center rounded px-2 py-1 text-text-muted hover:bg-black/5 hover:text-primary dark:hover:bg-white/5">
            <span className="material-symbols-outlined text-[18px]">edit</span>
            <span className="text-[10px] leading-tight">Edit</span>
          </button>
          <button onClick={onDelete} className="flex flex-col items-center rounded px-2 py-1 text-red-500 hover:bg-red-500/10">
            <span className="material-symbols-outlined text-[18px]">delete</span>
            <span className="text-[10px] leading-tight">Delete</span>
          </button>
        </div>
        <Toggle
          size="sm"
          checked={connection.isActive ?? true}
          onChange={onToggleActive}
          title={(connection.isActive ?? true) ? "Disable connection" : "Enable connection"}
        />
      </div>
    </div>
  );
}

ConnectionRow.propTypes = {
  connection: PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    email: PropTypes.string,
    displayName: PropTypes.string,
    modelLockUntil: PropTypes.string,
    testStatus: PropTypes.string,
    isActive: PropTypes.bool,
    lastError: PropTypes.string,
    priority: PropTypes.number,
    globalPriority: PropTypes.number,
  }).isRequired,
  proxyPools: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    proxyUrl: PropTypes.string,
    noProxy: PropTypes.string,
    isActive: PropTypes.bool,
  })),
  isOAuth: PropTypes.bool.isRequired,
  isFirst: PropTypes.bool.isRequired,
  isLast: PropTypes.bool.isRequired,
  onMoveUp: PropTypes.func.isRequired,
  onMoveDown: PropTypes.func.isRequired,
  onToggleActive: PropTypes.func.isRequired,
  onUpdateProxy: PropTypes.func,
  onEdit: PropTypes.func.isRequired,
  onDelete: PropTypes.func.isRequired,
  oneByOneStatus: PropTypes.shape({
    state: PropTypes.string,
    error: PropTypes.string,
  }),
  autoPing: PropTypes.shape({
    on: PropTypes.bool,
    onToggle: PropTypes.func,
    provider: PropTypes.string,
  }),
};
