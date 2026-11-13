"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Button, Modal, Input } from "@/shared/components";
import { translate } from "@/i18n/runtime";

// Meoo （秒悟） paste-key connection: the OAuth popup flow cannot complete
// against production Meoo (its client only registers loopback redirect
// URIs), so the supported path is pasting the account-level control-plane
// API key (meoo_ak_…). The server verifies it and resolves the project
// service AK — see POST /api/oauth/meoo/import-apikey.
export default function MeooImportApikeyModal({ isOpen, onClose, onSuccess }) {
  const [apiKey, setApiKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  const handleClose = () => {
    if (submitting) return;
    setApiKey("");
    setError("");
    setResult(null);
    onClose();
  };

  const handleSubmit = async () => {
    setError("");
    setResult(null);
    const key = apiKey.trim();
    if (!key) return;

    setSubmitting(true);
    try {
      const res = await fetch("/api/oauth/meoo/import-apikey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: key }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || `Request failed: ${res.status}`);
        return;
      }
      setResult(data.connection || {});
      if (typeof onSuccess === "function") onSuccess();
    } catch (err) {
      setError(err.message || translate("Request failed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} title={translate("Connect Meoo with API Key")} onClose={handleClose}>
      <div className="flex flex-col gap-4">
        <p className="text-xs text-text-muted">
          在 meoo.com → 设置 → API 密钥里生成账号级密钥（meoo_ak_ 开头），粘贴到这里。
          服务器会用它自动解析项目服务密钥并保存，之后密钥失效时也会自动重新解析。
          账号下需至少有一个已开启云服务的项目。
        </p>

        <Input
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="meoo_ak_..."
          className="font-mono text-xs"
          disabled={submitting}
        />

        {error && <p className="text-xs text-red-500 break-words">{error}</p>}

        {result && (
          <div className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-green-400">
              ✓ {translate("Connected")}{result.name ? `: ${result.name}` : ""}
            </span>
            {result.projectName && (
              <span className="text-xs text-text-muted">
                {translate("Project")}: {result.projectName}
                {result.projectUrlId ? ` (${result.projectUrlId})` : ""}
              </span>
            )}
            {result.akStatus && result.akStatus !== "ok" && (
              <span className="text-xs text-yellow-400">
                项目服务密钥尚未就绪{result.akError ? `：${result.akError}` : ""}。
                在 Meoo 里建好项目并开启云服务后，可用「刷新 AK」补取。
              </span>
            )}
          </div>
        )}

        <div className="flex gap-2">
          <Button onClick={handleSubmit} fullWidth disabled={submitting || !apiKey.trim()}>
            {submitting ? translate("Connecting...") : translate("Connect")}
          </Button>
          <Button onClick={handleClose} variant="ghost" fullWidth disabled={submitting}>
            {translate("Close")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

MeooImportApikeyModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onSuccess: PropTypes.func,
};
