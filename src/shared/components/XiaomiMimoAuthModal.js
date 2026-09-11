"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import { Modal, Button } from "@/shared/components";
import { translate } from "@/i18n/runtime";

/**
 * Xiaomi MiMo Auth Modal
 *
 * Xiaomi MiMo supports both auth modes, so this modal is only reached from the
 * "Connect with OAuth" path — the API-key path uses the standard Add API Key modal.
 *
 * Credentials come from Xiaomi MiMo Desktop's own local profile:
 *   - the sk- API key from ~/.local/share/mimocode/auth.json
 *   - the account-session passToken from Desktop's cookie store (read server-side,
 *     never sent to the browser) which unlocks the Desktop-exclusive Preview models.
 * When neither is present we fall back to the browser ECDH sign-in flow.
 */
export default function XiaomiMimoAuthModal({ isOpen, onSuccess, onClose }) {
  const [phase, setPhase] = useState("detecting"); // detecting | found | not-found | importing
  const [detectResult, setDetectResult] = useState(null);
  const [desktopLocked, setDesktopLocked] = useState(false);
  const [error, setError] = useState(null);
  const [oauthUrl, setOauthUrl] = useState(null);
  const [manualUrl, setManualUrl] = useState(null);
  const [oauthState, setOauthState] = useState(null);
  const [authCode, setAuthCode] = useState("");
  const [submittingCode, setSubmittingCode] = useState(false);

  const detect = async () => {
    setPhase("detecting");
    setError(null);
    setDetectResult(null);
    setOauthUrl(null);
    setManualUrl(null);
    setAuthCode("");
    setDesktopLocked(false);

    const res = await fetch("/api/oauth/xiaomi-mimo/auto-import");
    const data = await res.json();
    if (data.found && data.apiKey) {
      setDetectResult(data);
      setPhase("found");
    } else {
      setPhase("not-found");
      setDesktopLocked(Boolean(data.desktopLocked));
      setError(translate(data.error || "Xiaomi MiMo Desktop credentials not found on this machine."));
    }
  };

  // Auto-detect local credentials when modal opens
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    (async () => {
      setPhase("detecting");
      setError(null);
      setDetectResult(null);
      setOauthUrl(null);
      setManualUrl(null);
      setAuthCode("");
      setDesktopLocked(false);

      try {
        const res = await fetch("/api/oauth/xiaomi-mimo/auto-import");
        const data = await res.json();
        if (cancelled) return;

        if (data.found && data.apiKey) {
          setDetectResult(data);
          setPhase("found");
        } else {
          setPhase("not-found");
          setDesktopLocked(Boolean(data.desktopLocked));
          setError(translate(data.error || "Xiaomi MiMo Desktop credentials not found on this machine."));
        }
      } catch {
        if (!cancelled) {
          setPhase("not-found");
          setError(translate("Failed to read local Xiaomi MiMo Desktop credentials."));
        }
      }
    })();

    return () => { cancelled = true; };
  }, [isOpen]);

  // Import the auto-detected key. The Desktop session passToken is intentionally
  // not sent from here — the import route reads it from Desktop's profile itself.
  const handleImport = async () => {
    if (!detectResult?.apiKey) return;
    setPhase("importing");
    setError(null);

    try {
      const res = await fetch("/api/oauth/xiaomi-mimo/api-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: detectResult.apiKey,
          uid: detectResult.uid,
          baseUrl: detectResult.baseUrl,
        }),
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(translate(data.error || "Import failed"));
      }

      onSuccess?.(data.connection);
      onClose();
    } catch (err) {
      setPhase("found");
      setError(err.message);
    }
  };

  // Start browser OAuth fallback
  const handleStartOAuth = async () => {
    setError(null);
    setAuthCode("");
    try {
      const state = crypto.randomUUID();
      const res = await fetch(`/api/oauth/xiaomi-mimo/authorize?state=${state}`);
      const data = await res.json();
      if (data.authorizeUrl) {
        setOauthUrl(data.authorizeUrl);
        setManualUrl(data.manualUrl || null);
        setOauthState(data.state);
        window.open(data.authorizeUrl, "_blank", "width=600,height=700");
      } else {
        throw new Error(translate(data.error || "Failed to start OAuth"));
      }
    } catch (err) {
      setError(err.message);
    }
  };

  // Finish a completed session: the server applies the sk- key and creates the
  // connection, so the credential itself never passes through the browser.
  const finishExchange = async (state) => {
    const exRes = await fetch("/api/oauth/xiaomi-mimo/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state }),
    });
    const exData = await exRes.json();
    if (!exData.success) {
      throw new Error(translate(exData.error || "Exchange failed"));
    }
    onSuccess?.(exData.connection);
    onClose();
  };

  // Submit a pasted authorization code. The platform's page shows a code instead of
  // calling our localhost redirect; that code is the very same encrypted payload the
  // callback would carry, so the server decrypts it against the pending session. It
  // carries no state either, so the response reports which session it opened.
  const handleSubmitCode = async () => {
    const code = authCode.trim();
    if (!code) {
      setError(translate("Paste the authorization code first."));
      return;
    }
    setSubmittingCode(true);
    setError(null);
    try {
      const res = await fetch("/api/oauth/xiaomi-mimo/submit-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok || data.status !== "done") {
        throw new Error(translate(data.error || "Could not read that code."));
      }
      await finishExchange(data.state || oauthState);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmittingCode(false);
    }
  };

  // Poll OAuth result, then exchange it for a connection
  const handlePollOAuth = async () => {
    if (!oauthState) return;
    setError(null);
    try {
      const res = await fetch(`/api/oauth/xiaomi-mimo/poll-status?state=${oauthState}`);
      const data = await res.json();

      if (data.status === "done" && data.result) {
        await finishExchange(oauthState);
      } else if (data.status === "error") {
        throw new Error(translate(data.error || "OAuth failed"));
      } else {
        setError(translate("Authorization not completed yet. Finish in the browser, then click Check Again."));
      }
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <Modal isOpen={isOpen} title={translate("Connect Xiaomi MiMo")} onClose={onClose}>
      <div className="flex flex-col gap-4">
        {/* Detecting */}
        {phase === "detecting" && (
          <div className="text-center py-6">
            <div className="size-16 mx-auto mb-4 rounded-full bg-primary/10 flex items-center justify-center">
              <span className="material-symbols-outlined text-3xl text-primary animate-spin">
                progress_activity
              </span>
            </div>
            <h3 className="text-lg font-semibold mb-2">{translate("Reading local credentials...")}</h3>
            <p className="text-sm text-text-muted">
              {translate("Checking Xiaomi MiMo Desktop's local profile (auth.json + cookie store)")}
            </p>
          </div>
        )}

        {/* Found — one-click import */}
        {phase === "found" && detectResult && (
          <>
            <div className="bg-green-50 dark:bg-green-900/20 p-3 rounded-lg border border-green-200 dark:border-green-800">
              <div className="flex gap-2">
                <span className="material-symbols-outlined text-green-600 dark:text-green-400">check_circle</span>
                <div className="text-sm text-green-800 dark:text-green-200">
                  <p className="font-medium">{translate("Xiaomi MiMo Desktop credentials found!")}</p>
                  <p className="mt-1 opacity-80">
                    {translate("UID")}: {detectResult.uid || "—"} · {translate("Source")}:{" "}
                    {detectResult.source?.split(/[\\/]/).pop()}
                  </p>
                  <p className="mt-1 opacity-80">
                    {detectResult.hasDesktopSession
                      ? translate("Desktop account session detected — Preview models will be available.")
                      : detectResult.desktopLocked
                        ? translate("Desktop is running and is holding its credential store — quit it to unlock the Preview models (the API key alone covers the cloud models).")
                        : translate("No Desktop account session found — the API key alone is enough for the cloud models.")}
                  </p>
                </div>
              </div>
            </div>

            {error && (
              <div className="bg-red-50 dark:bg-red-900/20 p-3 rounded-lg border border-red-200 dark:border-red-800">
                <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
              </div>
            )}

            <div className="flex gap-2">
              <Button onClick={handleImport} fullWidth>
                {translate("Connect with Local Credentials")}
              </Button>
              <Button onClick={onClose} variant="ghost" fullWidth>
                {translate("Cancel")}
              </Button>
            </div>
          </>
        )}

        {/* Importing */}
        {phase === "importing" && (
          <div className="text-center py-6">
            <div className="size-16 mx-auto mb-4 rounded-full bg-primary/10 flex items-center justify-center">
              <span className="material-symbols-outlined text-3xl text-primary animate-spin">
                progress_activity
              </span>
            </div>
            <h3 className="text-lg font-semibold mb-2">{translate("Connecting...")}</h3>
          </div>
        )}

        {/* Not found — offer OAuth fallback */}
        {phase === "not-found" && (
          <>
            <div className="bg-amber-50 dark:bg-amber-900/20 p-3 rounded-lg border border-amber-200 dark:border-amber-800">
              <div className="flex gap-2 items-start">
                <span className="material-symbols-outlined text-amber-600 dark:text-amber-400">info</span>
                <div className="text-sm text-amber-800 dark:text-amber-200">
                  <p className="font-medium">
                    {desktopLocked ? translate("Quit Xiaomi MiMo Desktop and retry") : translate("Local credentials not found")}
                  </p>
                  <p className="mt-1 opacity-80">{error}</p>
                  <p className="mt-2 opacity-80">
                    {desktopLocked
                      ? translate("The desktop app keeps an exclusive lock on its credential store while it runs.")
                      : translate("Make sure Xiaomi MiMo Desktop is installed and you are signed in, then retry.")}{" "}
                    {translate("Or sign in via browser below.")}
                  </p>
                </div>
              </div>
            </div>

            {!oauthUrl ? (
              <div className="flex gap-2">
                <Button
                  onClick={() => { detect().catch(() => setPhase("not-found")); }}
                  variant="outline"
                  fullWidth
                >
                  {translate("Retry Local Detect")}
                </Button>
                <Button onClick={handleStartOAuth} fullWidth>
                  {translate("Sign in via Browser")}
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="bg-blue-50 dark:bg-blue-900/20 p-3 rounded-lg border border-blue-200 dark:border-blue-800">
                  <p className="text-sm text-blue-800 dark:text-blue-200">
                    {translate("Browser opened. Complete the Xiaomi sign-in there.")}
                  </p>
                  <p className="text-sm text-blue-800 dark:text-blue-200 mt-1 opacity-80">
                    {translate("The page may show an authorization code — paste it below. If it came back automatically instead, click")}{" "}
                    <strong>{translate("Check Again")}</strong>.
                  </p>
                </div>

                {error && (
                  <div className="bg-red-50 dark:bg-red-900/20 p-3 rounded-lg border border-red-200 dark:border-red-800">
                    <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
                  </div>
                )}

                {/* Recovery: a code that will not decrypt means the sign-in attempt is
                    stale, so re-issuing one must be one click away, not a dead end. */}
                {error && (
                  <Button onClick={handleStartOAuth} variant="outline" fullWidth>
                    {translate("Sign in via Browser")}
                  </Button>
                )}

                <div>
                  <label className="block text-sm font-medium mb-2">{translate("Authorization Code")}</label>
                  <textarea
                    value={authCode}
                    onChange={(e) => setAuthCode(e.target.value)}
                    placeholder={translate("Paste the authorization code shown in the browser")}
                    rows={3}
                    className="w-full px-3 py-2 text-sm font-mono border border-border rounded-lg bg-background focus:outline-none focus:border-primary resize-none"
                  />
                  <p className="text-xs text-text-muted mt-1">
                    {translate("The code is a long string (100+ characters) — copy it whole, using the Copy button on the sign-in page.")}
                  </p>
                  {manualUrl && (
                    // The platform's own code-display page: the same request as the popup,
                    // except it renders the code for copying instead of handing it to a
                    // listener. The fallback when the popup or the localhost hand-off
                    // does not show a code at all.
                    <a
                      href={manualUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-block text-xs text-primary hover:underline mt-2"
                    >
                      {translate("Open the code page")}
                    </a>
                  )}
                </div>

                <div className="flex gap-2">
                  <Button
                    onClick={handleSubmitCode}
                    disabled={submittingCode || !authCode.trim()}
                    fullWidth
                  >
                    {submittingCode ? translate("Checking...") : translate("Submit Code")}
                  </Button>
                  <Button onClick={handlePollOAuth} variant="outline" fullWidth>
                    {translate("Check Again")}
                  </Button>
                </div>
                <Button onClick={onClose} variant="ghost" fullWidth>
                  {translate("Cancel")}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

XiaomiMimoAuthModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onSuccess: PropTypes.func,
  onClose: PropTypes.func.isRequired,
};
