"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import { Modal, Button } from "@/shared/components";
import { translate } from "@/i18n/runtime";
import { uuid } from "@/shared/utils/uuid";

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
export default function XiaomiMimoAuthModal({ provider, isOpen, onSuccess, onClose }) {
  // Which Xiaomi card this modal was opened for: `xiaomi-mimo` (cloud models) or
  // `mimo-desktop` (account-session models). Every endpoint below is addressed by
  // provider id, so the connection lands under the card the user actually opened.
  const providerId = provider === "mimo-desktop" ? "mimo-desktop" : "xiaomi-mimo";
  // The Desktop card is the only one that reads the local Desktop profile. The
  // cloud card bills the API, so its modal goes straight to browser authorization
  // (or the separate Add API Key dialog). Running the Desktop import there used to
  // show "quit MiMo Desktop"/credential-lock text on a card that has nothing to do
  // with the Desktop app.
  const isDesktopCard = providerId === "mimo-desktop";
  const [phase, setPhase] = useState("detecting"); // detecting | found | not-found | importing
  // The cloud card has exactly one screen, so its phase is DERIVED rather than
  // stored: a stored value could survive a card switch and leak the Desktop UI
  // ("quit MiMo Desktop" and the credential-lock notice) onto a cloud card.
  const effectivePhase = isDesktopCard ? phase : "cloud";
  const [detectResult, setDetectResult] = useState(null);
  const [desktopLocked, setDesktopLocked] = useState(false);
  const [error, setError] = useState(null);
  const [errorCode, setErrorCode] = useState(null);
  const [errorDetails, setErrorDetails] = useState("");
  const [oauthUrl, setOauthUrl] = useState(null);
  const [manualUrl, setManualUrl] = useState(null);
  const [oauthState, setOauthState] = useState(null);
  const [authCode, setAuthCode] = useState("");
  const [submittingCode, setSubmittingCode] = useState(false);
  // 服务端登录代理（对照上游 910db749）：headless 部署无需本机装 MiMo Desktop。
  const [serverLoginRegion, setServerLoginRegion] = useState("cn");
  const [serverLoginPhase, setServerLoginPhase] = useState("idle"); // idle | starting | logging-in | saving
  const [serverLoginError, setServerLoginError] = useState(null);

  const detect = async () => {
    setPhase("detecting");
    setError(null);
    setErrorCode(null);
    setErrorDetails("");
    setDetectResult(null);
    setOauthUrl(null);
    setManualUrl(null);
    setAuthCode("");
    setDesktopLocked(false);

    const res = await fetch(`/api/oauth/xiaomi-mimo/auto-import`);
    const data = await res.json();
    // `found` includes session-only (Desktop QR login without auth.json).
    if (data.found) {
      setDetectResult(data);
      setPhase("found");
    } else {
      setPhase("not-found");
      setDesktopLocked(Boolean(data.desktopLocked));
      setErrorCode(data.code || null);
      setErrorDetails(data.details || "");
      setError(translate(data.error || "Xiaomi MiMo Desktop credentials not found on this machine."));
    }
  };

  // Auto-detect local credentials when modal opens
  useEffect(() => {
    if (!isOpen) return;
    // Cloud card: never touch the Desktop profile. `effectivePhase` is already
    // "cloud", so nothing to transition to — just skip the import machinery.
    if (!isDesktopCard) return;
    let cancelled = false;

    (async () => {
      setPhase("detecting");
      setError(null);
      setErrorCode(null);
      setErrorDetails("");
      setDetectResult(null);
      setOauthUrl(null);
      setManualUrl(null);
      setAuthCode("");
      setDesktopLocked(false);

      try {
        const res = await fetch(`/api/oauth/xiaomi-mimo/auto-import`);
        const data = await res.json();
        if (cancelled) return;

        // found covers BOTH full credentials (apiKey + session) and session-only
        // (Desktop QR login, no auth.json) — only the apiKey check here would
        // misroute the latter to the not-found branch.
        if (data.found) {
          setDetectResult(data);
          setPhase("found");
        } else {
          setPhase("not-found");
          setDesktopLocked(Boolean(data.desktopLocked));
          setErrorCode(data.code || null);
          setErrorDetails(data.details || "");
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
  }, [isOpen, isDesktopCard]);

  // Quiet re-check: the user may sign into MiMo Desktop WHILE this modal sits
  // on the "not found" screen — the original detect only ran once on open, so
  // the modal stayed stale until a full page refresh. Poll silently (no
  // spinner flicker) and flip via the full detect() only when credentials
  // actually appeared.
  useEffect(() => {
    if (!isOpen || !isDesktopCard || phase !== "not-found") return;
    const t = setInterval(async () => {
      try {
        const res = await fetch(`/api/oauth/xiaomi-mimo/auto-import`);
        const data = await res.json();
        if (data.found) detect();
      } catch { /* transient — keep the current screen */ }
    }, 4000);
    return () => clearInterval(t);
  }, [isOpen, phase, isDesktopCard]);

  // Import the auto-detected credentials. Session-only (no auth.json sk- key but
  // a readable Desktop account session) is a first-class path: the session alone
  // unlocks the Desktop-exclusive Preview models. The Desktop session passToken is
  // intentionally not sent from here — the import route reads it from Desktop's
  // profile itself.
  const handleImport = async () => {
    const sessionOnly = Boolean(detectResult?.sessionOnly);
    if (!detectResult?.apiKey && !sessionOnly) return;
    setPhase("importing");
    setError(null);

    try {
      const res = await fetch(`/api/oauth/xiaomi-mimo/api-key`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: detectResult.apiKey || undefined,
          uid: detectResult.uid,
          baseUrl: detectResult.baseUrl,
          sessionOnly,
          provider: providerId,
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

  // 服务端登录代理：start 取回同源登录页路径并弹窗，status 轮询到 passToken
  // 后直接保存连接（凭据只落在服务端 jar，浏览器拿到的就是最终身份一次）。
  const MIMO_REGIONS = { cn: "CN 中国", sgp: "SGP 新加坡", ams: "AMS 阿姆斯特丹", ru: "RU 俄罗斯", in: "IN 印度" };
  const handleServerLogin = async () => {
    setServerLoginError(null);
    setServerLoginPhase("starting");
    try {
      const res = await fetch(`/api/oauth/xiaomi-mimo/login/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ region: serverLoginRegion }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(translate(data.error || "Failed to start the login proxy"));
      }
      setServerLoginPhase("logging-in");
      window.open(data.pageUrl, "_blank", "width=480,height=760");

      const deadline = Date.now() + 10 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2500));
        let sdata;
        try {
          const sres = await fetch(`/api/oauth/xiaomi-mimo/login/status?state=${encodeURIComponent(data.state)}`);
          if (sres.status === 404) continue; // session expired — keep polling till deadline
          sdata = await sres.json();
        } catch {
          continue; // transient network blip — keep polling
        }
        if (sdata.status === "done") {
          setServerLoginPhase("saving");
          const saveRes = await fetch(`/api/oauth/xiaomi-mimo/api-key`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              provider: "mimo-desktop",
              sessionOnly: true,
              region: sdata.region,
              mimoPassToken: sdata.passToken,
              mimoUserId: sdata.userId,
              mimoCUserId: sdata.cUserId,
            }),
          });
          const saveData = await saveRes.json();
          if (!saveRes.ok || !saveData.success) {
            throw new Error(translate(saveData.error || "Failed to save the captured session"));
          }
          setServerLoginPhase("idle");
          onSuccess?.(saveData.connection);
          onClose();
          return;
        }
        if (sdata.status === "error") {
          throw new Error(translate(sdata.error || "Login failed"));
        }
      }
      throw new Error(translate("Login window timed out — try again."));
    } catch (err) {
      setServerLoginError(err.message);
      setServerLoginPhase("idle");
    }
  };

  // Start browser OAuth fallback
  const handleStartOAuth = async () => {
    setError(null);
    setAuthCode("");
    try {
      // The server refuses an authorize call without a client state, and this
      // runs in the browser: `crypto.randomUUID` does not exist in an insecure
      // context (plain http:// on a LAN address), so use the safe helper.
      const state = uuid();
      const res = await fetch(`/api/oauth/${providerId}/authorize?state=${state}`);
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
    const exRes = await fetch(`/api/oauth/${providerId}/exchange`, {
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
      const res = await fetch(`/api/oauth/${providerId}/submit-code`, {
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
      const res = await fetch(`/api/oauth/${providerId}/poll-status?state=${oauthState}`);
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

  // Browser-authorization block: the code-entry UI used after "Sign in via
  // Browser" starts a flow. The CLOUD card only — the Desktop card has no browser
  // path at all, since its models are reachable only through the account session.
  const renderBrowserAuth = () => (
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
          className="w-full px-3 py-2 text-sm font-mono border border-border rounded-lg bg-surface focus:outline-none focus:border-primary resize-none"
        />
        <p className="text-xs text-text-muted mt-1">
          {translate("The code is a long string (100+ characters) — copy it whole, using the Copy button on the sign-in page.")}
        </p>
        {manualUrl && (
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
    </div>
  );

  return (
    <Modal isOpen={isOpen} title={translate("Connect Xiaomi MiMo")} onClose={onClose}>
      <div className="flex flex-col gap-4">
        {/* Cloud card (`xiaomi-mimo`): browser authorization only. The Desktop
            session import belongs to the MiMo Desktop card, so none of the
            credential-lock / "quit the desktop app" guidance applies here. */}
        {effectivePhase === "cloud" && (
          <>
            <div className="bg-blue-50 dark:bg-blue-900/20 p-3 rounded-lg border border-blue-200 dark:border-blue-800">
              <div className="flex gap-2 items-start">
                <span className="material-symbols-outlined text-blue-600 dark:text-blue-400">info</span>
                <div className="text-sm text-blue-800 dark:text-blue-200">
                  <p className="font-medium">{translate("Cloud models — sign in with the browser")}</p>
                  <p className="mt-1 opacity-80">
                    {translate("This card bills the cloud API, so it uses the browser authorization or an sk- API key. Desktop credits belong to the MiMo Desktop card.")}
                  </p>
                </div>
              </div>
            </div>

            {error && (
              <div className="bg-red-50 dark:bg-red-900/20 p-3 rounded-lg border border-red-200 dark:border-red-800">
                <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
              </div>
            )}

            {!oauthUrl ? (
              <Button onClick={handleStartOAuth} fullWidth>
                {translate("Sign in via Browser")}
              </Button>
            ) : (
              renderBrowserAuth()
            )}
          </>
        )}

        {/* Detecting */}
        {effectivePhase === "detecting" && (
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
        {effectivePhase === "found" && detectResult && (
          <>
            <div className="bg-green-50 dark:bg-green-900/20 p-3 rounded-lg border border-green-200 dark:border-green-800">
              <div className="flex gap-2">
                <span className="material-symbols-outlined text-green-600 dark:text-green-400">check_circle</span>
                <div className="text-sm text-green-800 dark:text-green-200">
                  <p className="font-medium">
                    {detectResult.sessionOnly
                      ? translate("Xiaomi MiMo Desktop session detected!")
                      : translate("Xiaomi MiMo Desktop credentials found!")}
                  </p>
                  <p className="mt-1 opacity-80">
                    {translate("UID")}: {detectResult.uid || "—"} · {translate("Source")}:{" "}
                    {detectResult.source?.split(/[\\/]/).pop()}
                  </p>
                  <p className="mt-1 opacity-80">
                    {detectResult.hasDesktopSession
                      ? translate("Desktop account session detected — the Desktop models will be available.")
                      : detectResult.desktopLocked
                        ? translate("Desktop is running and is holding its credential store — quit it to unlock the Desktop models.")
                        : translate("No desktop account session found — sign in to MiMo Desktop, then retry.")}
                  </p>
                </div>
              </div>
            </div>

            {error && (
              <div className="bg-red-50 dark:bg-red-900/20 p-3 rounded-lg border border-red-200 dark:border-red-800">
                <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
              </div>
            )}

            {/* This card's models are reachable only through the Desktop account
                session, so point at the sibling card rather than offering a
                browser sign-in that would not unlock anything here. */}
            {detectResult.sessionOnly && (
              <div className="bg-blue-50 dark:bg-blue-900/20 p-3 rounded-lg border border-blue-200 dark:border-blue-800">
                <div className="flex gap-2 items-start">
                  <span className="material-symbols-outlined text-blue-600 dark:text-blue-400">lightbulb</span>
                  <div className="text-sm text-blue-800 dark:text-blue-200">
                    <p className="font-medium">{translate("Want the metered models too?")}</p>
                    <p className="mt-1 opacity-80">
                      {translate("This card covers the Desktop models. The metered and subscription-plan models are on the MiMo card — open that card there.")}
                    </p>
                  </div>
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <Button onClick={handleImport} fullWidth>
                {detectResult.sessionOnly
                  ? translate("Connect with Desktop Session")
                  : translate("Connect with Local Credentials")}
              </Button>
              {/* Deliberately no browser-authorization button here: browser
                  sign-in and the sk- key both belong to the MiMo card, and an
                  sk- key cannot reach this card's account-service route. */}
              <Button onClick={onClose} variant="ghost" fullWidth>
                {translate("Cancel")}
              </Button>
            </div>
          </>
        )}

        {/* Importing */}
        {effectivePhase === "importing" && (
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
        {effectivePhase === "not-found" && (
          <>
            <div className="bg-amber-50 dark:bg-amber-900/20 p-3 rounded-lg border border-amber-200 dark:border-amber-800">
              <div className="flex gap-2 items-start">
                <span className="material-symbols-outlined text-amber-600 dark:text-amber-400">info</span>
                <div className="text-sm text-amber-800 dark:text-amber-200">
                  <p className="font-medium">
                    {desktopLocked ? translate("Quit Xiaomi MiMo Desktop and retry") : translate("Local credentials not found")}
                  </p>
                  {/* Localized sentence built from the backend code — the raw
                      English `error` string is only a last-resort fallback for
                      codes this build does not know yet. */}
                  <p className="mt-1 opacity-80">
                    {errorCode === "DESKTOP_LOCKED"
                      ? translate("The desktop app keeps an exclusive lock on its credential store while it runs.")
                      : errorCode === "AUTH_FILE_MISSING"
                        ? translate("Make sure Xiaomi MiMo Desktop is installed and you are signed in, then retry.")
                        : error}
                  </p>
                  {errorDetails && (
                    <details className="mt-1 opacity-70">
                      <summary className="cursor-pointer">{translate("Checked paths")}</summary>
                      <pre className="mt-1 whitespace-pre-wrap break-all text-[10px]">{errorDetails}</pre>
                    </details>
                  )}
                  <p className="mt-2 opacity-80">{translate("Make sure MiMo Desktop is signed in on this machine.")}</p>
                </div>
              </div>
            </div>

            {/* Retry is the only move here — this card has no browser fallback
                (that path belongs to the MiMo card). */}
            <Button
              onClick={() => { detect().catch(() => setPhase("not-found")); }}
              variant="outline"
              fullWidth
            >
              {translate("Retry Local Detect")}
            </Button>

            {/* 服务端登录代理（对照上游 910db749）：不装 Desktop 也能登录——
                服务端反代 account.xiaomi.com 并在服务端 jar 捕获 passToken。
                需要 dashboard 登录态；non-CN 集群自动探测本地代理出口。 */}
            <div className="border-t border-border pt-3 mt-1">
              <p className="text-sm font-medium mb-2">{translate("Or sign in via the server (headless / NAS)")}</p>
              <label className="text-xs text-text-muted mb-1 block">{translate("Account region")}</label>
              <select
                value={serverLoginRegion}
                onChange={(e) => setServerLoginRegion(e.target.value)}
                disabled={serverLoginPhase !== "idle"}
                className="w-full mb-2 px-3 py-2 rounded-lg border border-border bg-surface text-sm"
              >
                {Object.entries(MIMO_REGIONS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
              <Button onClick={handleServerLogin} disabled={serverLoginPhase !== "idle"} fullWidth>
                {serverLoginPhase === "starting"
                  ? translate("Starting login proxy...")
                  : serverLoginPhase === "logging-in"
                    ? translate("Waiting for the login window...")
                    : serverLoginPhase === "saving"
                      ? translate("Saving the captured session...")
                      : translate("Sign in via Server Proxy")}
              </Button>
              {serverLoginPhase === "logging-in" && (
                <p className="text-xs opacity-70 mt-1">{translate("Complete the Xiaomi sign-in in the popup window; this dialog continues automatically.")}</p>
              )}
              {serverLoginError && (
                <p className="text-sm text-red-600 dark:text-red-400 mt-1">{serverLoginError}</p>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

XiaomiMimoAuthModal.propTypes = {
  provider: PropTypes.string,
  isOpen: PropTypes.bool.isRequired,
  onSuccess: PropTypes.func,
  onClose: PropTypes.func.isRequired,
};
