"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import { Button, Badge, Input, Modal, Select } from "@/shared/components";
import { translate } from "@/i18n/runtime";

export default function EditCompatibleNodeModal({ isOpen, node, onSave, onClose, isAnthropic }) {
  const [formData, setFormData] = useState({
    name: "",
    prefix: "",
    apiType: "chat",
    baseUrl: "https://api.openai.com/v1",
    website: "",
  });
  const [saving, setSaving] = useState(false);
  const [checkKey, setCheckKey] = useState("");
  const [checkModelId, setCheckModelId] = useState("");
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [modelsHeaderName, setModelsHeaderName] = useState("");
  const [modelsHeaderValue, setModelsHeaderValue] = useState("{apiKey}");
  const [customHeadersText, setCustomHeadersText] = useState("");
  const [customHeadersError, setCustomHeadersError] = useState("");

  const buildAuthHeaders = () => {
    if (modelsHeaderName.trim()) {
      return {
        models: {
          [modelsHeaderName.trim()]: modelsHeaderValue.trim() || "{apiKey}",
        },
      };
    }
    return null;
  };

  // #149: per-request custom headers, opt-in JSON. Empty text = no headers.
  const buildCustomHeaders = () => {
    const text = customHeadersText.trim();
    if (!text) return undefined;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(translate("Custom headers is not valid JSON"));
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(translate("Custom headers must be a {\"header\": \"value\"} object"));
    }
    for (const [k, v] of Object.entries(parsed)) {
      if (!k.trim() || typeof v !== "string") throw new Error(translate("Custom header values must be strings"));
    }
    return parsed;
  };

  useEffect(() => {
    if (node) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFormData({
        name: node.name || "",
        prefix: node.prefix || "",
        apiType: node.apiType || "chat",
        baseUrl: node.baseUrl || (isAnthropic ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1"),
        website: node.website || "",
      });
      const modelsHeader = node.authHeaders?.models;
      if (modelsHeader && typeof modelsHeader === "object") {
        const firstKey = Object.keys(modelsHeader)[0] || "";
        setModelsHeaderName(firstKey);
        setModelsHeaderValue(modelsHeader[firstKey] || "{apiKey}");
        setShowAdvanced(true);
      } else {
        setModelsHeaderName("");
        setModelsHeaderValue("{apiKey}");
        setShowAdvanced(false);
      }
      const hasCustom = node.customHeaders && Object.keys(node.customHeaders).length > 0;
      setCustomHeadersText(hasCustom ? JSON.stringify(node.customHeaders, null, 2) : "");
      setCustomHeadersError("");
    }
  }, [node, isAnthropic]);

  const apiTypeOptions = [
    { value: "chat", label: "Chat Completions" },
    { value: "responses", label: "Responses API" },
  ];

  const handleSubmit = async () => {
    if (!formData.name.trim() || !formData.prefix.trim() || !formData.baseUrl.trim()) return;
    let customHeaders;
    try {
      customHeaders = buildCustomHeaders();
      setCustomHeadersError("");
    } catch (err) {
      setCustomHeadersError(err.message);
      setShowAdvanced(true);
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: formData.name,
        prefix: formData.prefix,
        baseUrl: formData.baseUrl,
        website: formData.website.trim(),
        authHeaders: buildAuthHeaders(),
        // Empty text → null, so the route clears a removed header list.
        ...(customHeaders ? { customHeaders } : { customHeaders: null }),
      };
      if (!isAnthropic) {
        payload.apiType = formData.apiType;
      }
      await onSave(payload);
    } finally {
      setSaving(false);
    }
  };

  const handleValidate = async () => {
    setValidating(true);
    try {
      const res = await fetch("/api/provider-nodes/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: formData.baseUrl,
          apiKey: checkKey,
          type: isAnthropic ? "anthropic-compatible" : "openai-compatible",
          modelId: checkModelId.trim() || undefined,
          authHeaders: buildAuthHeaders(),
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

  if (!node) return null;

  return (
    <Modal isOpen={isOpen} title={translate(isAnthropic ? "Edit Anthropic Compatible" : "Edit OpenAI Compatible")} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <Input
          label={translate("Name")}
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          placeholder={`${isAnthropic ? "Anthropic" : "OpenAI"} Compatible (Prod)`}
          hint={translate("Required. A friendly label for this node.")}
        />
        <Input
          label={translate("Prefix")}
          value={formData.prefix}
          onChange={(e) => setFormData({ ...formData, prefix: e.target.value })}
          placeholder={isAnthropic ? "ac-prod" : "oc-prod"}
          hint={translate("Required. Used as the provider prefix for model IDs.")}
        />
        {!isAnthropic && (
          <Select
            label={translate("API Type")}
            options={apiTypeOptions}
            value={formData.apiType}
            onChange={(e) => setFormData({ ...formData, apiType: e.target.value })}
          />
        )}
        <Input
          label={translate("Base URL")}
          value={formData.baseUrl}
          onChange={(e) => setFormData({ ...formData, baseUrl: e.target.value })}
          placeholder={isAnthropic ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1"}
          hint={translate("Use the base URL (ending in /v1) for your {family}-compatible API.").replace("{family}", isAnthropic ? "Anthropic" : "OpenAI")}
        />
        <Input
          label={translate("Website (optional)")}
          value={formData.website}
          onChange={(e) => setFormData({ ...formData, website: e.target.value })}
          placeholder="https://provider.example.com"
          hint={translate("Optional. Used to fetch the provider logo (favicon) and show a console link on the detail page.")}
        />
        <div className="flex gap-2">
          <Input
            label={translate("API Key (for Check)")}
            type="password"
            value={checkKey}
            onChange={(e) => setCheckKey(e.target.value)}
            className="flex-1"
          />
          <div className="pt-6">
            <Button onClick={handleValidate} disabled={!checkKey || validating || !formData.baseUrl.trim()} variant="secondary">
              {validating ? translate("Checking...") : translate("Check")}
            </Button>
          </div>
        </div>
        <Input
          label={translate("Model ID (optional)")}
          value={checkModelId}
          onChange={(e) => setCheckModelId(e.target.value)}
          placeholder="e.g. my-model-id"
          hint={translate("If provider lacks /models endpoint, enter a model ID to validate via chat/completions instead.")}
        />

        {/* Issue #92: Advanced Custom Auth Headers (e.g. for Loomy token: {apiKey}) */}
        <div className="rounded-lg border border-border/60 bg-surface-2/30 p-3">
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex w-full items-center justify-between text-xs font-medium text-text-muted hover:text-text-main"
          >
            <span>{translate("Advanced / Custom Headers")}</span>
            <span className="material-symbols-outlined text-[16px]">
              {showAdvanced ? "expand_less" : "expand_more"}
            </span>
          </button>
          {showAdvanced && (
            <div className="mt-3 flex flex-col gap-2 pt-2 border-t border-border/40">
              <span className="text-[11px] text-text-muted">
                {translate("Custom Header for /models Discovery (e.g. iFlytek Loomy requires 'token: {apiKey}')")}
              </span>
              <div className="grid grid-cols-2 gap-2">
                <Input
                  label={translate("Header Name")}
                  placeholder="e.g. token"
                  value={modelsHeaderName}
                  onChange={(e) => setModelsHeaderName(e.target.value)}
                />
                <Input
                  label={translate("Header Value Template")}
                  placeholder="{apiKey}"
                  value={modelsHeaderValue}
                  onChange={(e) => setModelsHeaderValue(e.target.value)}
                />
              </div>
              <span className="text-[11px] text-text-muted pt-1 border-t border-border/40">
                {translate("Per-request custom headers (JSON object, optional): sent with every request to this endpoint, and can override the default auth header. Structural headers like host / content-length / connection are ignored.")}
              </span>
              <textarea
                value={customHeadersText}
                onChange={(e) => setCustomHeadersText(e.target.value)}
                placeholder={'{\n  "x-gateway-token": "abc"\n}'}
                rows={4}
                className="w-full rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-xs focus:outline-none focus:border-primary"
              />
              {customHeadersError && (
                <span className="text-[11px] text-red-500">{customHeadersError}</span>
              )}
            </div>
          )}
        </div>

        {validationResult && (
          <Badge variant={validationResult === "success" ? "success" : "error"}>
            {validationResult === "success" ? translate("Valid") : translate("Invalid")}
          </Badge>
        )}
        <div className="flex gap-2">
          <Button onClick={handleSubmit} fullWidth disabled={!formData.name.trim() || !formData.prefix.trim() || !formData.baseUrl.trim() || saving}>
            {saving ? translate("Saving...") : translate("Save")}
          </Button>
          <Button onClick={onClose} variant="ghost" fullWidth>
            {translate("Cancel")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

EditCompatibleNodeModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  node: PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    prefix: PropTypes.string,
    apiType: PropTypes.string,
    baseUrl: PropTypes.string,
    website: PropTypes.string,
    customHeaders: PropTypes.object,
  }),
  onSave: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
  isAnthropic: PropTypes.bool,
};
