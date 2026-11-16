"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { Modal, Button, Input } from "@/shared/components";
import { translate } from "@/i18n/runtime";

/**
 * DeepAI Code browser sign-in modal (panel-native, no desktop app).
 *
 * DeepAI issues its long-lived API key through the desktop app's
 * desktop_auth flow: the browser signs in with Google/Apple and DeepAI
 * redirects to http://127.0.0.1:<port>/auth-callback?code=... — a dead
 * address by design, since only the code in the address bar matters.
 * The user pastes that address here; the server exchanges the code and
 * creates the connection (POST /api/oauth/deepai/exchange). Protocol
 * reference: open-sse/shared/deepai/auth.js.
 *
 * A manual API-key paste is kept as a secondary path for users who
 * already hold a key.
 */
export default function DeepaiAuthModal({ isOpen, onSuccess, onClose }) {
  const [authUrl, setAuthUrl] = useState("");
  const [pasted, setPasted] = useState("");
  const [name, setName] = useState("");
  const [manualKey, setManualKey] = useState("");
  const [showManual, setShowManual] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isOpen) return;
    // Fresh one-time state (32 lowercase hex) + a plausible callback
    // port for every opening; the port is never listened on.
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const state = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    const port = 20000 + Math.floor(Math.random() * 40000);
    setAuthUrl(`https://api.deepai.org/deepai_code/desktop_auth/?state=${state}&port=${port}`);
    setPasted("");
    setName("");
    setManualKey("");
    setShowManual(false);
    setBusy(false);
    setError("");
  }, [isOpen]);

  const finishWithCode = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/oauth/deepai/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: pasted, name: name.trim() || undefined }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Failed to create the DeepAI connection");
      onSuccess?.();
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const finishWithKey = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "deepai",
          apiKey: manualKey.trim(),
          name: name.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Failed to save connection");
      onSuccess?.();
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={translate("Connect DeepAI Code")}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-text-muted">
          {translate("Sign in with Google or Apple in your browser — no desktop app, no key to copy.")}
        </p>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">{translate("1. Open the DeepAI sign-in page")}</span>
          <div>
            <Button
              variant="secondary"
              icon="open_in_new"
              onClick={() => window.open(authUrl, "_blank", "noopener")}
            >
              {translate("Open sign-in page")}
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">{translate("2. Paste the callback address")}</span>
          <p className="text-xs text-text-muted">
            {translate(
              "After signing in, the browser jumps to an address that cannot load (127.0.0.1) — that is expected. Copy the whole address from the address bar and paste it here.",
            )}
          </p>
          <Input
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder={translate("Paste the callback address (or just the code)")}
          />
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">{translate("Connection name (optional)")}</span>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="DeepAI <username>"
          />
        </div>

        {error && <p className="text-sm text-red-500">{error}</p>}

        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {translate("Cancel")}
          </Button>
          <Button onClick={finishWithCode} disabled={busy || !pasted.trim()}>
            {busy ? translate("Connecting…") : translate("Finish connection")}
          </Button>
        </div>

        <div className="border-t border-border pt-3">
          <button
            type="button"
            className="text-xs text-text-muted underline"
            onClick={() => setShowManual((v) => !v)}
          >
            {translate("Already have an API key? Paste it instead")}
          </button>
          {showManual && (
            <div className="mt-2 flex flex-col gap-2">
              <Input
                value={manualKey}
                onChange={(e) => setManualKey(e.target.value)}
                placeholder={translate("Paste your DeepAI API key (UUID)")}
              />
              <div className="flex justify-end">
                <Button variant="secondary" onClick={finishWithKey} disabled={busy || !manualKey.trim()}>
                  {translate("Save key")}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

DeepaiAuthModal.propTypes = {
  isOpen: PropTypes.bool,
  onSuccess: PropTypes.func,
  onClose: PropTypes.func,
};
