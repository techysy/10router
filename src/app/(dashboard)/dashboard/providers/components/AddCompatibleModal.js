"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import { Badge, Button, Input, Modal, Select } from "@/shared/components";
import { translate } from "@/i18n/runtime";

const VARIANT_CONFIG = {
  openai: {
    title: "Add OpenAI Compatible",
    type: "openai-compatible",
    defaultBaseUrl: "https://api.openai.com/v1",
    namePlaceholder: "OpenAI Compatible (Prod)",
    prefixPlaceholder: "oc-prod",
    baseUrlHint: "Use the base URL (ending in /v1) for your OpenAI-compatible API.",
    modelIdPlaceholder: "e.g. gpt-4, claude-3-opus",
    errorLabel: "OpenAI Compatible",
    hasApiType: true,
  },
  anthropic: {
    title: "Add Anthropic Compatible",
    type: "anthropic-compatible",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    namePlaceholder: "Anthropic Compatible (Prod)",
    prefixPlaceholder: "ac-prod",
    baseUrlHint: "Use the base URL (ending in /v1) for your Anthropic-compatible API. The system will append /messages.",
    modelIdPlaceholder: "e.g. claude-3-opus",
    errorLabel: "Anthropic Compatible",
    hasApiType: false,
  },
};

const API_TYPE_OPTIONS = [
  { value: "chat", label: "Chat Completions" },
  { value: "responses", label: "Responses API" },
];

function AddCompatibleModal({ variant, isOpen, onClose, onCreated }) {
  const config = VARIANT_CONFIG[variant];
  const initialFormData = () => ({
    name: "",
    prefix: "",
    ...(config.hasApiType ? { apiType: "chat" } : {}),
    baseUrl: config.defaultBaseUrl,
    website: "",
  });

  const [formData, setFormData] = useState(initialFormData);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
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
    return undefined;
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

  // openai: reset baseUrl when apiType changes; anthropic: reset checks when opened
  useEffect(() => {
    if (config.hasApiType) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFormData((prev) => ({ ...prev, baseUrl: config.defaultBaseUrl }));
    } else if (isOpen) {
      setValidationResult(null);
      setCheckKey("");
      setCheckModelId("");
      setSubmitError("");
      setShowAdvanced(false);
      setModelsHeaderName("");
      setModelsHeaderValue("{apiKey}");
    }
  }, [config.hasApiType ? formData.apiType : isOpen]);

  const handleSubmit = async () => {
    if (!formData.name.trim() || !formData.prefix.trim() || !formData.baseUrl.trim()) return;
    let customHeaders;
    try {
      customHeaders = buildCustomHeaders();
      setCustomHeadersError("");
    } catch (err) {
      setSubmitError(err.message);
      setShowAdvanced(true);
      return;
    }
    setSubmitting(true);
    setSubmitError("");
    try {
      const res = await fetch("/api/provider-nodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formData.name,
          prefix: formData.prefix,
          ...(config.hasApiType ? { apiType: formData.apiType } : {}),
          baseUrl: formData.baseUrl,
          type: config.type,
          website: formData.website.trim(),
          authHeaders: buildAuthHeaders(),
          ...(customHeaders ? { customHeaders } : {}),
        }),
      });
      const data = await res.json();
      if (res.ok) {
        onCreated(data.node);
        setFormData(initialFormData());
        setCheckKey("");
        setValidationResult(null);
        setSubmitError("");
        setShowAdvanced(false);
        setModelsHeaderName("");
        setModelsHeaderValue("{apiKey}");
        setCustomHeadersText("");
        setCustomHeadersError("");
      } else {
        setSubmitError(data?.error || translate("Failed to create provider"));
      }
    } catch (error) {
      console.log(`Error creating ${config.errorLabel} node:`, error);
      setSubmitError(translate("Network error creating provider"));
    } finally {
      setSubmitting(false);
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
          type: config.type,
          modelId: checkModelId.trim() || undefined,
          authHeaders: buildAuthHeaders(),
        }),
      });
      const data = await res.json();
      setValidationResult(data);
    } catch {
      setValidationResult({ valid: false, error: translate("Network error") });
    } finally {
      setValidating(false);
    }
  };

  const renderValidationResult = () => {
    if (!validationResult) return null;
    const { valid, error, method } = validationResult;
    if (valid) {
      return (
        <>
          <Badge variant="success">{translate("Valid")}</Badge>
          {method === "chat" && (
            <span className="text-sm text-text-muted">{translate("via inference test")}</span>
          )}
        </>
      );
    }
    return (
      <div className="flex flex-col gap-1">
        <Badge variant="error">{translate("Invalid")}</Badge>
        {error && <span className="text-sm text-red-500">{error}</span>}
      </div>
    );
  };

  return (
    <Modal isOpen={isOpen} title={translate(config.title)} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <Input
          label={translate("Name")}
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          placeholder={config.namePlaceholder}
          hint={translate("Required. A friendly label for this node.")}
        />
        <Input
          label={translate("Prefix")}
          value={formData.prefix}
          onChange={(e) => setFormData({ ...formData, prefix: e.target.value })}
          placeholder={config.prefixPlaceholder}
          hint={translate("Required. Used as the provider prefix for model IDs.")}
        />
        {config.hasApiType && (
          <Select
            label={translate("API Type")}
            options={API_TYPE_OPTIONS}
            value={formData.apiType}
            onChange={(e) => setFormData({ ...formData, apiType: e.target.value })}
          />
        )}
        <Input
          label={translate("Base URL")}
          value={formData.baseUrl}
          onChange={(e) => setFormData({ ...formData, baseUrl: e.target.value })}
          placeholder={config.defaultBaseUrl}
          hint={translate(config.baseUrlHint)}
        />
        <Input
          label={translate("Website (optional)")}
          value={formData.website}
          onChange={(e) => setFormData({ ...formData, website: e.target.value })}
          placeholder="https://provider.example.com"
          hint={translate("Optional. Used to fetch the provider logo (favicon) and show a console link on the detail page.")}
        />
        <Input
          label={translate("API Key (for Check)")}
          type="password"
          value={checkKey}
          onChange={(e) => setCheckKey(e.target.value)}
        />
        <Input
          label={translate("Model ID (optional)")}
          value={checkModelId}
          onChange={(e) => setCheckModelId(e.target.value)}
          placeholder={config.modelIdPlaceholder}
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

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Button
            onClick={handleValidate}
            disabled={!checkKey || validating || !formData.baseUrl.trim()}
            variant="secondary"
            className="w-full sm:w-auto"
          >
            {validating ? translate("Checking...") : translate("Check")}
          </Button>
          {renderValidationResult()}
        </div>
        {submitError && (
          <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-500">
            {submitError}
          </div>
        )}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            onClick={handleSubmit}
            fullWidth
            disabled={
              !formData.name.trim() ||
              !formData.prefix.trim() ||
              !formData.baseUrl.trim() ||
              submitting
            }
          >
            {submitting ? translate("Creating...") : translate("Create")}
          </Button>
          <Button onClick={onClose} variant="ghost" fullWidth>
            {translate("Cancel")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

AddCompatibleModal.propTypes = {
  variant: PropTypes.oneOf(["openai", "anthropic"]).isRequired,
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onCreated: PropTypes.func.isRequired,
};

export default AddCompatibleModal;
