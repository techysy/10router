"use client";

import { useRef, useState } from "react";
import PropTypes from "prop-types";
import { Button, Input, Modal } from "@/shared/components";
import { translate } from "@/i18n/runtime";

const TRANSFER_FORMAT = "10router-oauth-secure-v1";

/**
 * Encrypted OAuth credentials transfer modal (generic — every OAuth provider).
 *
 * Export: passphrase (+confirm) → POST /api/oauth/transfer/export with the
 * already-confirmed dashboard password → download the encrypted blob.
 * Import: pick the transfer file (envelope JSON) + passphrase → POST
 * /api/oauth/transfer/import → per-account summary. Wrong passphrase fails
 * closed server-side (GCM tag).
 */
export default function OAuthTransferModal({ isOpen, mode, provider, providerName, dashboardPassword, onClose, onSuccess }) {
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [fileName, setFileName] = useState("");
  const [blob, setBlob] = useState(null);
  const fileRef = useRef(null);

  const reset = () => {
    setPassphrase("");
    setConfirm("");
    setBusy(false);
    setError("");
    setResult(null);
    setFileName("");
    setBlob(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const handleClose = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const headers = { "Content-Type": "application/json", "x-9r-password": dashboardPassword || "" };

  const handleExport = async () => {
    setError("");
    if (passphrase.length < 4) {
      setError(translate("Passphrase must be at least 4 characters"));
      return;
    }
    if (passphrase !== confirm) {
      setError(translate("Passphrases do not match"));
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/oauth/transfer/export", {
        method: "POST",
        headers,
        body: JSON.stringify({ provider, passphrase }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `Request failed: ${res.status}`);
      const blobJson = JSON.stringify(data.blob, null, 2);
      const url = URL.createObjectURL(new Blob([blobJson], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `oauth-${provider}-transfer-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setResult({ exported: data.count });
    } catch (e) {
      setError(e.message || translate("Export failed"));
    } finally {
      setBusy(false);
    }
  };

  const onFilePicked = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setError("");
    setResult(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || ""));
        if (parsed?.format !== TRANSFER_FORMAT) {
          setError(translate("Unrecognized transfer file (expected an encrypted OAuth transfer)"));
          setBlob(null);
          return;
        }
        setBlob(parsed);
      } catch (err) {
        setError(`${translate("Invalid JSON")}: ${err.message}`);
        setBlob(null);
      }
    };
    reader.onerror = () => setError(translate("Failed to read file"));
    reader.readAsText(file);
  };

  const handleImport = async () => {
    setError("");
    setResult(null);
    if (!blob) {
      setError(translate("Pick a transfer file first"));
      return;
    }
    if (!passphrase) {
      setError(translate("Transfer passphrase required"));
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/oauth/transfer/import", {
        method: "POST",
        headers,
        body: JSON.stringify({ provider, passphrase, blob }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 401 && /passphrase/i.test(data?.error || "")) {
          throw new Error(translate("Wrong passphrase"));
        }
        throw new Error(data?.error || `Request failed: ${res.status}`);
      }
      setResult(data);
      if (typeof onSuccess === "function") onSuccess();
    } catch (e) {
      setError(e.message || translate("Import failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      title={
        mode === "export"
          ? translate("Export OAuth accounts")
          : translate("Import OAuth accounts")
      }
      onClose={handleClose}
    >
      <div className="flex flex-col gap-4">
        <p className="text-xs text-text-muted">
          {translate("Provider")}: <span className="font-medium text-text-main">{providerName || provider}</span>
        </p>

        {mode === "export" ? (
          <>
            <div className="flex gap-2">
              <Input
                type="password"
                label={translate("Transfer passphrase")}
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder="••••••••"
              />
              <Input
                type="password"
                label={translate("Confirm passphrase")}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="••••••••"
              />
            </div>
            <p className="text-xs text-text-muted">
              {translate("The file is encrypted with this passphrase — it is required again at import, and cannot be recovered.")}
            </p>
            {error && <p className="text-xs text-red-500">{error}</p>}
            {result && (
              <p className="text-xs text-green-600">
                {translate("Export complete")} — {result.exported} {translate("accounts exported")}
              </p>
            )}
            <Button onClick={handleExport} disabled={busy} fullWidth>
              {translate("Export encrypted file")}
            </Button>
          </>
        ) : (
          <>
            <Input
              label={translate("Transfer file")}
              value={fileName}
              readOnly
              placeholder={translate("Pick a transfer file first")}
              className="cursor-pointer"
              onClick={() => fileRef.current?.click()}
            />
            <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={onFilePicked} />
            <Input
              type="password"
              label={translate("Transfer passphrase")}
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="••••••••"
            />
            {error && <p className="text-xs text-red-500">{error}</p>}
            {result && (
              <div className="text-xs text-text-muted">
                <p>
                  {translate("Import complete")}: {result.imported || 0} {translate("imported")}, {result.updated || 0}{" "}
                  {translate("updated")}
                  {(result.failed || 0) > 0 ? `, ${result.failed} ${translate("failed")}` : ""}
                </p>
              </div>
            )}
            <Button onClick={handleImport} disabled={busy} fullWidth>
              {translate("Import connections")}
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}

OAuthTransferModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  mode: PropTypes.oneOf(["export", "import"]).isRequired,
  provider: PropTypes.string.isRequired,
  providerName: PropTypes.string,
  dashboardPassword: PropTypes.string,
  onClose: PropTypes.func.isRequired,
  onSuccess: PropTypes.func,
};
