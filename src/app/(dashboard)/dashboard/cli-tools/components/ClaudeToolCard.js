"use client";

import { useMemo, useState, useEffect, useRef } from "react";
import { Card, Button, ModelSelectModal, ManualConfigModal, Tooltip, Toggle } from "@/shared/components";
import Image from "next/image";
import BaseUrlSelect from "./BaseUrlSelect";
import ApiKeySelect from "./ApiKeySelect";
import { matchKnownEndpoint } from "./cliEndpointMatch";
import { matchProfileByEnv } from "@/lib/cliToolProfiles";
import { translate } from "@/i18n/runtime";

const CLOUD_URL = process.env.NEXT_PUBLIC_CLOUD_URL;

// Context window presets. UI shows the round number; the value written is nudged
// down 2K to stay safely under the upstream hard cap.
const CONTEXT_OPTIONS = [
  { label: "Default", value: "" },
  { label: "200K", value: "198000" },
  { label: "300K", value: "298000" },
  { label: "500K", value: "498000" },
  { label: "1M", value: "998000" },
];

export default function ClaudeToolCard({
  tool,
  isExpanded,
  onToggle,
  activeProviders,
  modelMappings,
  onModelMappingChange,
  baseUrl,
  hasActiveProviders,
  apiKeys,
  cloudEnabled,
  initialStatus,
  tunnelEnabled,
  tunnelPublicUrl,
  tailscaleEnabled,
  tailscaleUrl,
}) {
  const [claudeStatus, setClaudeStatus] = useState(initialStatus || null);
  const [checkingClaude, setCheckingClaude] = useState(false);
  const [applying, setApplying] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [message, setMessage] = useState(null);
  const [showInstallGuide, setShowInstallGuide] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [currentEditingAlias, setCurrentEditingAlias] = useState(null);
  const [selectedApiKey, setSelectedApiKey] = useState("");
  const [modelAliases, setModelAliases] = useState({});
  const [showManualConfigModal, setShowManualConfigModal] = useState(false);
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [ccFilterNaming, setCcFilterNaming] = useState(false);
  const [exaMcpEnabled, setExaMcpEnabled] = useState(false);
  const [maxContextTokens, setMaxContextTokens] = useState("");
  // Named combo profiles (issue #17): the whole form saved server-side and
  // switched with one click. profileId is the user's explicit pick; when they
  // have not picked one, the profile the on-disk settings currently equal is
  // matched for display (save/delete then target it too).
  const [profiles, setProfiles] = useState([]);
  const [profileId, setProfileId] = useState("");
  const [profileName, setProfileName] = useState("");
  const profileNameRef = useRef(null);
  const hasInitializedModels = useRef(false);

  const getConfigStatus = () => {
    if (!claudeStatus?.installed) return null;
    const currentUrl = claudeStatus.settings?.env?.ANTHROPIC_BASE_URL;
    if (!currentUrl) return "not_configured";
    if (matchKnownEndpoint(currentUrl, { tunnelPublicUrl, tailscaleUrl, cloudUrl: cloudEnabled ? CLOUD_URL : null })) return "configured";
    return "other";
  };

  const configStatus = getConfigStatus();

  useEffect(() => {
    if (apiKeys?.length > 0 && !selectedApiKey) {
      setSelectedApiKey(apiKeys[0].key);
    }
  }, [apiKeys, selectedApiKey]);

  useEffect(() => {
    if (initialStatus) {
      setClaudeStatus(initialStatus);
      setExaMcpEnabled(!!initialStatus.exaMcpEnabled);
    }
  }, [initialStatus]);

  useEffect(() => {
    const v = claudeStatus?.settings?.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
    setMaxContextTokens(v || "");
  }, [claudeStatus?.settings?.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS]);

  useEffect(() => {
    if (isExpanded) {
      if (!claudeStatus) checkClaudeStatus();
      fetchModelAliases();
      // Profiles must load here, not in the toggle handler: the dedicated
      // [toolId] page mounts the card ALREADY expanded, so a click-based load
      // never fires and the dropdown stays "no saved profiles" forever.
      fetchProfiles();
    }
  }, [isExpanded]);

  useEffect(() => {
    fetch("/api/settings").then(r => r.json()).then(data => {
      setCcFilterNaming(!!data.ccFilterNaming);
    }).catch(() => {});
  }, []);

  const handleCcFilterNamingToggle = async (value) => {
    setCcFilterNaming(value);
    await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ccFilterNaming: value }),
    }).catch(() => {});
  };

  const fetchModelAliases = async () => {
    try {
      const res = await fetch("/api/models/alias");
      const data = await res.json();
      if (res.ok) setModelAliases(data.aliases || {});
    } catch (error) {
      console.log("Error fetching model aliases:", error);
    }
  };

  const fetchProfiles = async () => {
    try {
      const res = await fetch("/api/cli-tools/claude-profiles");
      if (!res.ok) return;
      const data = await res.json();
      setProfiles(Array.isArray(data.profiles) ? data.profiles : []);
    } catch (error) {
      console.log("Error fetching combo profiles:", error);
    }
  };

  const matchedProfileId = useMemo(() => {
    if (profileId || profiles.length === 0 || !claudeStatus?.settings?.env) return "";
    return profiles.find((p) => matchProfileByEnv(p, claudeStatus.settings.env))?.id || "";
  }, [profiles, claudeStatus, profileId]);
  const effectiveProfileId = profileId || matchedProfileId;
  const effectiveProfile = profiles.find((p) => p.id === effectiveProfileId) || null;

  useEffect(() => {
    if (claudeStatus?.installed && !hasInitializedModels.current) {
      hasInitializedModels.current = true;
      const env = claudeStatus.settings?.env || {};

      tool.defaultModels.forEach((model) => {
        if (model.envKey) {
          const value = env[model.envKey] || model.defaultValue || "";
          // Only sync initial values from file once
          if (value) {
            onModelMappingChange(model.alias, value);
          }
        }
      });
      // Only set selectedApiKey if it exists in apiKeys list
      const tokenFromFile = env.ANTHROPIC_AUTH_TOKEN;
      if (tokenFromFile && apiKeys?.some(k => k.key === tokenFromFile)) {
        setSelectedApiKey(tokenFromFile);
      }
    }
  }, [claudeStatus, apiKeys, tool.defaultModels, onModelMappingChange]);

  const checkClaudeStatus = async () => {
    setCheckingClaude(true);
    try {
      const res = await fetch("/api/cli-tools/claude-settings");
      const data = await res.json();
      setClaudeStatus(data);
      setExaMcpEnabled(!!data.exaMcpEnabled);
    } catch (error) {
      setClaudeStatus({ installed: false, error: error.message });
    } finally {
      setCheckingClaude(false);
    }
  };

  const getEffectiveBaseUrl = () => {
    const url = customBaseUrl || baseUrl;
    return url.endsWith("/v1") ? url : `${url}/v1`;
  };

  const getDisplayUrl = () => {
    const url = customBaseUrl || baseUrl;
    return url.endsWith("/v1") ? url : `${url}/v1`;
  };

  // The env block Apply writes — also what a saved combo profile snapshots.
  const buildEnvFromForm = () => {
    const env = { ANTHROPIC_BASE_URL: getEffectiveBaseUrl() };

    // Get key from dropdown, fallback to first key or sk_10router for localhost
    const keyToUse = selectedApiKey?.trim()
      || (apiKeys?.length > 0 ? apiKeys[0].key : null)
      || (!cloudEnabled ? "sk_10router" : null);

    if (keyToUse) {
      env.ANTHROPIC_AUTH_TOKEN = keyToUse;
    }

    tool.defaultModels.forEach((model) => {
      const targetModel = modelMappings[model.alias];
      if (targetModel && model.envKey) env[model.envKey] = targetModel;
    });
    if (maxContextTokens) {
      env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = maxContextTokens;
    }
    return env;
  };

  const postClaudeSettings = async (env, exa = exaMcpEnabled, ctx = maxContextTokens) => {
    const res = await fetch("/api/cli-tools/claude-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env, exaMcpEnabled: exa, maxContextTokens: ctx }),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
  };

  const handleApplySettings = async () => {
    setApplying(true);
    setMessage(null);
    try {
      const env = buildEnvFromForm();
      const { ok, data } = await postClaudeSettings(env);
      if (ok) {
        setMessage({ type: "success", text: "Settings applied successfully!" });
        setClaudeStatus(prev => ({ ...prev, hasBackup: true, settings: { ...prev?.settings, env }, exaMcpEnabled }));
      } else {
        setMessage({ type: "error", text: data.error || "Failed to apply settings" });
      }
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setApplying(false);
    }
  };

  const handleResetSettings = async () => {
    setRestoring(true);
    setMessage(null);
    try {
      const res = await fetch("/api/cli-tools/claude-settings", { method: "DELETE" });
      const data = await res.json();
      if (res.ok) {
        setMessage({ type: "success", text: "Settings reset successfully!" });
        tool.defaultModels.forEach((model) => onModelMappingChange(model.alias, model.defaultValue || ""));
        setSelectedApiKey("");
        setExaMcpEnabled(false);
        setMaxContextTokens("");
        setProfileId("");
      } else {
        setMessage({ type: "error", text: data.error || "Failed to reset settings" });
      }
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    } finally {
      setRestoring(false);
    }
  };

  const openModelSelector = (alias) => {
    setCurrentEditingAlias(alias);
    setModalOpen(true);
  };

  // ----- Combo profiles (issue #17) -----

  // Refill the form from a profile. The applied payload goes to the writer
  // straight from the profile (not from state, which re-renders async); the
  // form refill is so the next manual Apply keeps writing the same thing.
  const fillFormFromProfile = (profile) => {
    const env = profile.env || {};
    setCustomBaseUrl(String(env.ANTHROPIC_BASE_URL || "").replace(/\/v1$/, ""));
    tool.defaultModels.forEach((model) => {
      onModelMappingChange(model.alias, model.envKey ? env[model.envKey] || "" : "");
    });
    const token = env.ANTHROPIC_AUTH_TOKEN;
    setSelectedApiKey(token && apiKeys?.some((k) => k.key === token) ? token : "");
    setMaxContextTokens(profile.maxContextTokens || "");
    setExaMcpEnabled(profile.exaMcpEnabled === true);
  };

  const handleSelectProfile = async (id) => {
    setProfileId(id);
    const profile = profiles.find((p) => p.id === id);
    if (!profile) return;
    setProfileName(profile.name);
    fillFormFromProfile(profile);
    setMessage(null);
    try {
      const { ok, data } = await postClaudeSettings(profile.env, profile.exaMcpEnabled, profile.maxContextTokens);
      if (ok) {
        setClaudeStatus(prev => ({
          ...prev,
          hasBackup: true,
          settings: { ...(prev?.settings || {}), env: profile.env },
          exaMcpEnabled: profile.exaMcpEnabled === true,
        }));
        setMessage({ type: "success", text: translate(`Switched to profile "{name}" — restart Claude Code to pick it up`).replace("{name}", profile.name) });
      } else {
        setMessage({ type: "error", text: data.error || translate("Failed to apply profile") });
      }
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    }
  };

  // Save targets the name in the box (CC-Switch semantics): a name that
  // already exists updates that profile, a new name saves a new one. An empty
  // box updates the selected/matched profile keeping its own name — with
  // nothing selected there is nothing to call it, so ask for a name. Anchoring
  // on the NAME (not on which profile the on-disk settings equal) is what
  // keeps repeated saves of one combo from piling up duplicate entries.
  const handleSaveProfile = async () => {
    setMessage(null);
    const trimmed = profileName.trim();
    const target = trimmed
      ? profiles.find((p) => p.name === trimmed)
      : effectiveProfile;
    if (!target && !trimmed) {
      setMessage({ type: "error", text: translate("Enter a profile name to save") });
      profileNameRef.current?.focus();
      return;
    }
    try {
      const res = await fetch("/api/cli-tools/claude-profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: target?.id || undefined,
          name: target && !trimmed ? target.name : trimmed,
          env: buildEnvFromForm(),
          exaMcpEnabled,
          maxContextTokens,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ type: "error", text: data.error || translate("Failed to save profile") });
        return;
      }
      const saved = data.profile;
      setProfiles((prev) => [...prev.filter((p) => p.id !== saved.id), saved]);
      setProfileId(saved.id);
      setProfileName(saved.name);
      setMessage({
        type: "success",
        text: target
          ? translate(`Profile "{name}" updated`).replace("{name}", saved.name)
          : translate(`Saved profile "{name}"`).replace("{name}", saved.name),
      });
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    }
  };

  const handleDeleteProfile = async () => {
    if (!effectiveProfileId) return;
    setMessage(null);
    try {
      const res = await fetch(`/api/cli-tools/claude-profiles?id=${encodeURIComponent(effectiveProfileId)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ type: "error", text: data.error || translate("Failed to delete profile") });
        return;
      }
      setProfiles((prev) => prev.filter((p) => p.id !== effectiveProfileId));
      setProfileId("");
      setMessage({ type: "success", text: translate("Profile deleted") });
    } catch (error) {
      setMessage({ type: "error", text: error.message });
    }
  };

  const handleModelSelect = (model) => {
    if (currentEditingAlias) onModelMappingChange(currentEditingAlias, model.value);
  };

  // Generate settings.json content for manual copy
  const getManualConfigs = () => {
    const keyToUse = (selectedApiKey && selectedApiKey.trim())
      ? selectedApiKey
      : (!cloudEnabled ? "sk_10router" : "<API_KEY_FROM_DASHBOARD>");
    const env = { ANTHROPIC_BASE_URL: getEffectiveBaseUrl(), ANTHROPIC_AUTH_TOKEN: keyToUse };
    tool.defaultModels.forEach((model) => {
      const targetModel = modelMappings[model.alias];
      if (targetModel && model.envKey) env[model.envKey] = targetModel;
    });
    if (maxContextTokens) {
      env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = maxContextTokens;
    }

    return [
      {
        filename: "~/.claude/settings.json",
        content: JSON.stringify({ hasCompletedOnboarding: true, env }, null, 2),
      },
    ];
  };

  return (
    <Card padding="xs" className="overflow-hidden">
      <div className="flex items-start justify-between gap-3 hover:cursor-pointer sm:items-center" onClick={onToggle}>
        <div className="flex min-w-0 items-center gap-3">
          <div className="size-8 flex items-center justify-center shrink-0">
            <Image src="/providers/claude.png" alt={tool.name} width={32} height={32} className="size-8 object-contain rounded-lg" sizes="32px" onError={(e) => { e.target.style.display = "none"; }} loading="lazy" decoding="async" />
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h3 className="font-medium text-sm">{tool.name}</h3>
              {configStatus === "configured" && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-green-500/10 text-green-600 dark:text-green-400 rounded-full">Connected</span>}
              {configStatus === "not_configured" && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 rounded-full">Not configured</span>}
              {configStatus === "other" && <span className="px-1.5 py-0.5 text-[10px] font-medium bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded-full">Other</span>}
            </div>
            <p className="text-xs text-text-muted truncate">{tool.description}</p>
          </div>
        </div>
        <span className={`material-symbols-outlined text-text-muted text-[20px] transition-transform ${isExpanded ? "rotate-180" : ""}`}>expand_more</span>
      </div>

      {isExpanded && (
        <div className="mt-4 pt-4 border-t border-border flex flex-col gap-4">
          {checkingClaude && (
            <div className="flex items-center gap-2 text-text-muted">
              <span className="material-symbols-outlined animate-spin">progress_activity</span>
              <span>Checking Claude CLI...</span>
            </div>
          )}

          {!checkingClaude && claudeStatus && !claudeStatus.installed && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-3 p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
                <div className="flex items-start gap-3">
                  <span className="material-symbols-outlined text-yellow-500">warning</span>
                  <div className="flex-1">
                    <p className="font-medium text-yellow-600 dark:text-yellow-400">Claude CLI not detected locally</p>
                    <p className="text-sm text-text-muted">Manual configuration is still available if 10router is deployed on a remote server.</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 pl-9">
                  <Button variant="secondary" size="sm" onClick={() => setShowManualConfigModal(true)} className="!bg-yellow-500/20 !border-yellow-500/40 !text-yellow-700 dark:!text-yellow-300 hover:!bg-yellow-500/30">
                    <span className="material-symbols-outlined text-[18px] mr-1">content_copy</span>
                    Manual Config
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setShowInstallGuide(!showInstallGuide)}>
                    <span className="material-symbols-outlined text-[18px] mr-1">{showInstallGuide ? "expand_less" : "help"}</span>
                    {showInstallGuide ? "Hide" : "How to Install"}
                  </Button>
                </div>
              </div>
              {showInstallGuide && (
                <div className="p-4 bg-surface border border-border rounded-lg">
                  <h4 className="font-medium mb-3">Installation Guide</h4>
                  <div className="space-y-3 text-sm">
                    <div>
                      <p className="text-text-muted mb-1">macOS / Linux / Windows:</p>
                      <code className="block px-3 py-2 bg-black/5 dark:bg-white/5 rounded font-mono text-xs">npm install -g @anthropic-ai/claude-code</code>
                    </div>
                    <p className="text-text-muted">After installation, run <code className="px-1 bg-black/5 dark:bg-white/5 rounded">claude</code> to verify.</p>
                  </div>
                </div>
              )}
            </div>
          )}

          {!checkingClaude && claudeStatus?.installed && (
            <>
              <div className="flex flex-col gap-2">
                {/* Combo profiles (issue #17): the whole form as named snapshots;
                    picking one writes ~/.claude/settings.json immediately. */}
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">{translate("Profiles")}</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <select
                      value={effectiveProfileId}
                      onChange={(e) => handleSelectProfile(e.target.value)}
                      disabled={profiles.length === 0}
                      className="min-w-0 flex-1 sm:flex-none px-2 py-2 bg-surface rounded border border-border text-xs focus:outline-none focus:ring-1 focus:ring-primary/50 sm:py-1.5 disabled:opacity-50"
                    >
                      <option value="">{profiles.length ? translate("Switch profile…") : translate("No saved profiles")}</option>
                      {profiles.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                    <input
                      type="text"
                      ref={profileNameRef}
                      value={profileName}
                      onChange={(e) => setProfileName(e.target.value)}
                      placeholder={effectiveProfile ? translate(`Rename "{name}"…`).replace("{name}", effectiveProfile.name) : translate("Profile name")}
                      className="min-w-0 flex-1 sm:w-40 sm:flex-none pl-2 pr-2 py-2 bg-surface rounded border border-border text-xs focus:outline-none focus:ring-1 focus:ring-primary/50 sm:py-1.5"
                    />
                  </div>
                  <div className="flex gap-1.5">
                    <button
                      onClick={handleSaveProfile}
                      disabled={!hasActiveProviders}
                      className="rounded border border-border bg-surface px-2 py-2 text-xs transition-colors sm:py-1.5 hover:border-primary disabled:opacity-50"
                      title={effectiveProfile ? translate("Update the selected profile with the current form") : translate("Save the current settings as a profile")}
                    >
                      <span className="material-symbols-outlined text-[14px] align-middle">{effectiveProfile ? "sync" : "save"}</span>
                    </button>
                    {effectiveProfile && (
                      <button
                        onClick={handleDeleteProfile}
                        className="rounded border border-border bg-surface px-2 py-2 text-xs transition-colors sm:py-1.5 hover:border-red-500 hover:text-red-500"
                        title={translate("Delete the selected profile")}
                      >
                        <span className="material-symbols-outlined text-[14px] align-middle">delete</span>
                      </button>
                    )}
                  </div>
                </div>

                {/* Endpoint (selector) */}
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Select Endpoint</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <BaseUrlSelect
                    value={customBaseUrl || getDisplayUrl()}
                    onChange={setCustomBaseUrl}
                    requiresExternalUrl={tool.requiresExternalUrl}
                    tunnelEnabled={tunnelEnabled}
                    tunnelPublicUrl={tunnelPublicUrl}
                    tailscaleEnabled={tailscaleEnabled}
                    tailscaleUrl={tailscaleUrl}
                  />
                </div>

                {/* Current configured */}
                {claudeStatus?.settings?.env?.ANTHROPIC_BASE_URL && (
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                    <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Current</span>
                    <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                    <span className="min-w-0 truncate rounded bg-surface/40 px-2 py-2 text-xs text-text-muted sm:py-1.5">
                      {claudeStatus.settings.env.ANTHROPIC_BASE_URL}
                    </span>
                  </div>
                )}

                {/* API Key */}
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">API Key</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <ApiKeySelect value={selectedApiKey} onChange={setSelectedApiKey} apiKeys={apiKeys} cloudEnabled={cloudEnabled} />
                </div>

                {/* Model Mappings */}
                {tool.defaultModels.map((model) => (
                  <div key={model.alias} className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                    <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">{model.name}</span>
                    <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                    <div className="relative w-full min-w-0">
                      <input type="text" value={modelMappings[model.alias] || ""} onChange={(e) => onModelMappingChange(model.alias, e.target.value)} placeholder="provider/model-id" className="w-full min-w-0 pl-2 pr-7 py-2 bg-surface rounded border border-border text-xs focus:outline-none focus:ring-1 focus:ring-primary/50 sm:py-1.5" />
                      {modelMappings[model.alias] && <button onClick={() => onModelMappingChange(model.alias, "")} className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 text-text-muted hover:text-red-500 rounded transition-colors" title="Clear"><span className="material-symbols-outlined text-[14px]">close</span></button>}
                    </div>
                    <button onClick={() => openModelSelector(model.alias)} disabled={!hasActiveProviders} className={`w-full sm:w-auto rounded border px-2 py-2 text-xs transition-colors sm:py-1.5 whitespace-nowrap sm:shrink-0 ${hasActiveProviders ? "bg-surface border-border text-text-main hover:border-primary cursor-pointer" : "opacity-50 cursor-not-allowed border-border"}`}>Select Model</button>
                  </div>
                ))}

                {/* Context Window */}
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Context window</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <select value={maxContextTokens} onChange={(e) => setMaxContextTokens(e.target.value)} className="w-full min-w-0 px-2 py-2 bg-surface rounded border border-border text-xs focus:outline-none focus:ring-1 focus:ring-primary/50 sm:py-1.5">
                    {CONTEXT_OPTIONS.map((opt) => (
                      <option key={opt.label} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>

                {/* CC Filter Naming */}
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Filter naming</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <div className="flex items-center gap-1.5 select-none">
                    <Toggle size="sm" checked={ccFilterNaming} onChange={handleCcFilterNamingToggle} />
                    <span className="text-xs text-text-muted">Filter naming requests</span>
                    <Tooltip text="Intercepts Claude Code's topic-naming requests and returns a fake response locally, saving API tokens.">
                      <span className="material-symbols-outlined text-text-muted text-[14px] cursor-help">info</span>
                    </Tooltip>
                  </div>
                </div>

                {/* Exa MCP — ~/.claude.json mcpServers (not settings.json) */}
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8rem_auto_1fr_auto] sm:items-center sm:gap-2">
                  <span className="text-xs font-semibold text-text-main sm:text-right sm:text-sm">Web Search</span>
                  <span className="material-symbols-outlined hidden text-text-muted text-[14px] sm:inline">arrow_forward</span>
                  <div className="flex items-center gap-1.5 select-none">
                    <Toggle size="sm" checked={exaMcpEnabled} onChange={setExaMcpEnabled} />
                    <span className="text-xs text-text-muted">Exa MCP</span>
                    <Tooltip text="Injects Exa MCP into ~/.claude.json so non-Claude models gain web search. Restart Claude Code after Apply.">
                      <span className="material-symbols-outlined text-text-muted text-[14px] cursor-help">info</span>
                    </Tooltip>
                  </div>
                </div>
              </div>

              {message && (
                <div className={`flex items-center gap-2 px-2 py-1.5 rounded text-xs ${message.type === "success" ? "bg-green-500/10 text-green-600" : "bg-red-500/10 text-red-600"}`}>
                  <span className="material-symbols-outlined text-[14px]">{message.type === "success" ? "check_circle" : "error"}</span>
                  <span>{message.text}</span>
                </div>
              )}

              <div className="grid grid-cols-1 gap-2 sm:flex sm:items-center">
                <Button variant="primary" size="sm" onClick={handleApplySettings} disabled={!hasActiveProviders} loading={applying}>
                  <span className="material-symbols-outlined text-[14px] mr-1">save</span>Apply
                </Button>
                <Button variant="outline" size="sm" onClick={handleResetSettings} disabled={!claudeStatus?.has10Router} loading={restoring}>
                  <span className="material-symbols-outlined text-[14px] mr-1">restore</span>Reset
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setShowManualConfigModal(true)}>
                  <span className="material-symbols-outlined text-[14px] mr-1">content_copy</span>Manual Config
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {modalOpen && (
        <ModelSelectModal isOpen={modalOpen} onClose={() => setModalOpen(false)} onSelect={handleModelSelect} selectedModel={currentEditingAlias ? modelMappings[currentEditingAlias] : null} activeProviders={activeProviders} modelAliases={modelAliases} title={`Select model for ${currentEditingAlias}`} />
      )}

      <ManualConfigModal
        isOpen={showManualConfigModal}
        onClose={() => setShowManualConfigModal(false)}
        title="Claude CLI - Manual Configuration"
        configs={getManualConfigs()}
      />
    </Card>
  );
}
