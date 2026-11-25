"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import Modal from "@/shared/components/Modal";
import Input from "@/shared/components/Input";
import Button from "@/shared/components/Button";
import Badge from "@/shared/components/Badge";
import Toggle from "@/shared/components/Toggle";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider, AI_PROVIDERS } from "@/shared/constants/providers";
import Select from "@/shared/components/Select";
import { translate } from "@/i18n/runtime";

export default function EditConnectionModal({ isOpen, connection, proxyPools, onSave, onClose }) {
  const [formData, setFormData] = useState({
    name: "",
    priority: 1,
    apiKey: "",
  });
  const [azureData, setAzureData] = useState({
    azureEndpoint: "",
    apiVersion: "2024-10-01-preview",
    deployment: "",
    organization: "",
  });
  const [cloudflareData, setCloudflareData] = useState({ accountId: "" });
  const [region, setRegion] = useState("");
  const [autoDetectedRegionInfo, setAutoDetectedRegionInfo] = useState(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState(null);
  const [saving, setSaving] = useState(false);
  const [privacyEnabled, setPrivacyEnabled] = useState(false);
  // 渠道级规则覆盖（issue #117）：toggle 保存时不得抹掉 psd.privacy.rules ——
  // 旧实现写死 privacy: 布尔，配置过的规则会被静默清空。文本态按 JSON 编辑。
  const [privacyRulesText, setPrivacyRulesText] = useState("");
  const [privacyError, setPrivacyError] = useState("");

  useEffect(() => {
    if (connection) {
      setFormData({
        name: connection.name || "",
        priority: connection.priority || 1,
        apiKey: "",
      });
      // Load Azure-specific data if present
      if (connection.provider === "azure" && connection.providerSpecificData) {
        setAzureData({
          azureEndpoint: connection.providerSpecificData.azureEndpoint || "",
          apiVersion: connection.providerSpecificData.apiVersion || "2024-10-01-preview",
          deployment: connection.providerSpecificData.deployment || "",
          organization: connection.providerSpecificData.organization || "",
        });
      }
      if (connection.provider === "cloudflare-ai" && connection.providerSpecificData) {
        setCloudflareData({ accountId: connection.providerSpecificData.accountId || "" });
      }
      // Privacy opt-in (issue #90 phase 3): same truth table as the engine's
      // privacyEnabledFor — true | {enabled:true} count as on. Rules ride the
      // object form and must round-trip the edit session untouched.
      const psd = connection.providerSpecificData || {};
      setPrivacyEnabled(psd.privacy === true || psd.privacy?.enabled === true);
      setPrivacyRulesText(
        psd.privacy && typeof psd.privacy === "object" && psd.privacy.rules
          ? JSON.stringify(psd.privacy.rules, null, 2)
          : "",
      );
      setPrivacyError("");
      // Load region for providers that support it (e.g. xiaomi-tokenplan)
      const providerCfg = AI_PROVIDERS?.[connection.provider];
      if (providerCfg?.regions) {
        const savedRegion = connection.providerSpecificData?.region || providerCfg.defaultRegion || providerCfg.regions[0]?.id || "";
        setRegion(savedRegion);

        // Fetch egress region recommendation for display
        fetch("/api/network/egress-region")
          .then((res) => res.json())
          .then((data) => {
            const rec = data?.recommendedRegions?.[connection.provider];
            if (rec) {
              setAutoDetectedRegionInfo({
                country: data.country || data.countryCode,
                regionId: rec,
              });
            }
          })
          .catch(() => {});
      }
      setTestResult(null);
      setValidationResult(null);
    }
  }, [connection]);

  // OAuth-capable providers may store authType "api_key" for downstream
  // compatibility even though the user signed in via OAuth / Desktop session
  // (see providerSpecificData.authMethod). Treat those as OAuth here so the
  // edit form shows the account fields instead of an "API Key" input.
  const authMethod = connection?.providerSpecificData?.authMethod;
  const isOAuth =
    connection?.authType === "oauth" ||
    authMethod === "oauth" ||
    authMethod === "desktop-session" ||
    (typeof connection?.accessToken === "string" && connection.accessToken.startsWith("mimo-desktop-session"));
  const isAzure = connection?.provider === "azure";
  const isCloudflareAi = connection?.provider === "cloudflare-ai";
  const isCompatible = connection
    ? (isOpenAICompatibleProvider(connection.provider) || isAnthropicCompatibleProvider(connection.provider))
    : false;
  const providerRegions = connection ? (AI_PROVIDERS?.[connection.provider]?.regions || null) : null;

  // Build providerSpecificData for region-aware providers
  const buildRegionSpecificData = () => {
    if (providerRegions && region) return { ...((connection?.providerSpecificData) || {}), region };
    return undefined;
  };

  const handleTest = async () => {
    if (!connection?.provider) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`/api/providers/${connection.id}/test`, { method: "POST" });
      const data = await res.json();
      setTestResult(data.valid ? "success" : "failed");
    } catch {
      setTestResult("failed");
    } finally {
      setTesting(false);
    }
  };

  const handleValidate = async () => {
    if (!connection?.provider || !formData.apiKey) return;
    setValidating(true);
    setValidationResult(null);
    try {
      const res = await fetch("/api/providers/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: connection.provider,
          apiKey: formData.apiKey,
          ...(isAzure ? { providerSpecificData: azureData } : {}),
          ...(isCloudflareAi ? { providerSpecificData: cloudflareData } : {}),
          ...(providerRegions ? { providerSpecificData: buildRegionSpecificData() } : {}),
        }),
      });
      const data = await res.json();
      setValidationResult(data.valid ? "success" : "failed");
    } catch {
      setValidationResult("failed");
    } finally {
      setValidating(false);
    }
  };

  const handleSubmit = async () => {
    if (!connection) return;
    setSaving(true);
    try {
      const updates = {
        name: formData.name,
        priority: formData.priority,
      };
      if (!isOAuth && formData.apiKey) {
        updates.apiKey = formData.apiKey;
        let isValid = validationResult === "success";
        if (!isValid) {
          try {
            setValidating(true);
            setValidationResult(null);
            const res = await fetch("/api/providers/validate", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                provider: connection.provider,
                apiKey: formData.apiKey,
                ...(isAzure ? { providerSpecificData: azureData } : {}),
                ...(isCloudflareAi ? { providerSpecificData: cloudflareData } : {}),
                ...(providerRegions ? { providerSpecificData: buildRegionSpecificData() } : {}),
              }),
            });
            const data = await res.json();
            isValid = !!data.valid;
            setValidationResult(isValid ? "success" : "failed");
          } catch {
            setValidationResult("failed");
          } finally {
            setValidating(false);
          }
        }
        if (isValid) {
          updates.testStatus = "active";
          updates.lastError = null;
          updates.lastErrorAt = null;
        }
      }
      
      // Add Azure-specific data if this is an Azure connection
      if (isAzure) {
        updates.providerSpecificData = {
          azureEndpoint: azureData.azureEndpoint,
          apiVersion: azureData.apiVersion,
          deployment: azureData.deployment,
          organization: azureData.organization,
        };
      }
      if (isCloudflareAi) {
        updates.providerSpecificData = { accountId: cloudflareData.accountId };
      }
      // Persist updated region for region-aware providers
      if (providerRegions && region) {
        updates.providerSpecificData = buildRegionSpecificData();
      }

      // Privacy opt-in (issue #90 phase 3): sent as a partial patch — the PUT
      // route deep-merges providerSpecificData, so other stored keys (phone,
      // credentialSource, proxyPoolId…) survive the roundtrip. Rules JSON is
      // validated BEFORE any write, and the object form is written whenever
      // rules exist — writing a bare `privacy: false` over a configured object
      // would wipe them in the merge (disable → save → re-enable = rules gone).
      let privacyRules = null;
      if (privacyRulesText.trim()) {
        try {
          const parsed = JSON.parse(privacyRulesText);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
          privacyRules = parsed;
        } catch (err) {
          setPrivacyError(`Privacy rules JSON invalid: ${err.message}`);
          setSaving(false);
          return;
        }
      }
      updates.providerSpecificData = {
        ...(updates.providerSpecificData || {}),
        privacy: privacyEnabled
          ? (privacyRules ? { enabled: true, rules: privacyRules } : true)
          : (privacyRules ? { enabled: false, rules: privacyRules } : false),
      };

      await onSave(updates);
    } finally {
      setSaving(false);
    }
  };

  if (!connection) return null;

  return (
    <Modal isOpen={isOpen} title="Edit Connection" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <Input
          label="Name"
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          placeholder={isOAuth ? "Account name" : "Production Key"}
        />
        {isOAuth && connection.email && (() => {
          // Xiaomi rows store a SYNTHETIC `${uid}@xiaomi` address (there is no
          // real mailbox) — labeling it "Email" is misleading. Show it as the
          // account id it actually is.
          const xiaomiUid =
            connection.providerSpecificData?.mimoUserId ||
            connection.providerSpecificData?.uid ||
            null;
          const isXiaomi = connection.provider === "xiaomi-mimo" || connection.provider === "xiaomi-tokenplan";
          const showAsUid = isXiaomi || /^\d+@xiaomi$/.test(connection.email);
          const label = showAsUid ? "UID" : "Email";
          const value = showAsUid && xiaomiUid ? xiaomiUid : connection.email;
          return (
            <div className="bg-sidebar/50 p-3 rounded-lg">
              <p className="text-sm text-text-muted mb-1">{label}</p>
              <p className="font-medium">{value}</p>
            </div>
          );
        })()}
        <Input
          label="Priority"
          type="number"
          value={formData.priority}
          onChange={(e) => setFormData({ ...formData, priority: Number.parseInt(e.target.value, 10) || 1 })}
        />

        {!isOAuth && (
          <>
            <div className="flex gap-2">
              <Input
                label="API Key"
                type="password"
                value={formData.apiKey}
                onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                placeholder="Enter new API key"
                hint="Leave blank to keep the current API key."
                className="flex-1"
              />
              <div className="pt-6">
                <Button onClick={handleValidate} disabled={!formData.apiKey || validating || saving} variant="secondary">
                  {validating ? "Checking..." : "Check"}
                </Button>
              </div>
            </div>
            {validationResult && (
              <Badge variant={validationResult === "success" ? "success" : "error"}>
                {validationResult === "success" ? "Valid" : "Invalid"}
              </Badge>
            )}
          </>
        )}

        {isAzure && (
          <div className="bg-sidebar/50 p-4 rounded-lg border border-accent/20">
            <h3 className="font-semibold mb-3 text-sm">Azure OpenAI Configuration</h3>
            <div className="flex flex-col gap-3">
              <Input
                label="Azure Endpoint"
                value={azureData.azureEndpoint}
                onChange={(e) => setAzureData({ ...azureData, azureEndpoint: e.target.value })}
                placeholder="https://your-resource.openai.azure.com"
                hint="Your Azure OpenAI resource endpoint URL"
              />
              <Input
                label="Deployment Name"
                value={azureData.deployment}
                onChange={(e) => setAzureData({ ...azureData, deployment: e.target.value })}
                placeholder="gpt-4"
                hint="The deployment name in your Azure resource"
              />
              <Input
                label="API Version"
                value={azureData.apiVersion}
                onChange={(e) => setAzureData({ ...azureData, apiVersion: e.target.value })}
                placeholder="2024-10-01-preview"
                hint="Azure OpenAI API version to use"
              />
              <Input
                label="Organization"
                value={azureData.organization}
                onChange={(e) => setAzureData({ ...azureData, organization: e.target.value })}
                placeholder="Organization ID"
                hint="Required for billing"
              />
            </div>
          </div>
        )}

        {providerRegions && (
          <div>
            <Select
              label="Region"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              options={providerRegions.map((r) => ({ value: r.id, label: r.label }))}
            />
            {autoDetectedRegionInfo && (
              <p className="text-xs text-text-muted mt-1 flex items-center gap-1">
                <span>🌐</span>
                <span>
                  {translate("Current network location ({country}) recommended region: {region}")
                    .replace("{country}", autoDetectedRegionInfo.country)
                    .replace("{region}", autoDetectedRegionInfo.regionId)}
                </span>
              </p>
            )}
          </div>
        )}

        <div className="bg-sidebar/50 p-3 rounded-lg border border-accent/10">
          <Toggle
            checked={privacyEnabled}
            onChange={(v) => { setPrivacyEnabled(v); setPrivacyError(""); }}
            label={translate("Privacy redaction (experimental)")}
            description={translate("Redact API keys and secrets in the outbound request body, restore them in the model response. Enable only for untrusted upstreams.")}
          />
          {privacyEnabled && (
            <div className="mt-2 flex flex-col gap-1">
              <label className="text-[11px] font-medium text-text-muted">
                {translate("Extra rules (JSON, opt-in)")}
              </label>
              <textarea
                value={privacyRulesText}
                onChange={(e) => { setPrivacyRulesText(e.target.value); setPrivacyError(""); }}
                rows={5}
                spellCheck={false}
                placeholder={'{\n  "email": true,\n  "connectionStrings": true,\n  "privateRanges": true,\n  "cnMobile": true,\n  "customKeywords": ["代号", "内网域名"]\n}'}
                className="w-full rounded-lg border border-border bg-bg px-2 py-1.5 font-mono text-[11px] text-text outline-none transition-colors focus:border-primary/50"
              />
              <p className="text-[10px] leading-relaxed text-text-muted/80">
                {translate("Opt-in rules on top of the default key/PEM/JWT scans: email, connectionStrings, privateRanges, cnMobile (booleans) and customKeywords (exact literals). Invalid JSON blocks saving; disabling the toggle keeps the rules.")}
              </p>
              {privacyError && (
                <p className="text-[11px] text-red-500">{privacyError}</p>
              )}
            </div>
          )}
        </div>

        {!isCompatible && !isAzure && !isCloudflareAi && (
          <div className="flex items-center gap-3">
            <Button onClick={handleTest} variant="secondary" disabled={testing}>
              {testing ? "Testing..." : "Test Connection"}
            </Button>
            {testResult && (
              <Badge variant={testResult === "success" ? "success" : "error"}>
                {testResult === "success" ? "Valid" : "Failed"}
              </Badge>
            )}
          </div>
        )}

        <div className="flex gap-2">
          <Button onClick={handleSubmit} fullWidth disabled={saving}>{saving ? "Saving..." : "Save"}</Button>
          <Button onClick={onClose} variant="ghost" fullWidth>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}

EditConnectionModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  connection: PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    email: PropTypes.string,
    priority: PropTypes.number,
    authType: PropTypes.string,
    provider: PropTypes.string,
    providerSpecificData: PropTypes.object,
  }),
  proxyPools: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
  })),
  onSave: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};

