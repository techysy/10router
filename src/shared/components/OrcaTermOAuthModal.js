"use client";

import { useEffect, useId, useRef, useState } from "react";
import PropTypes from "prop-types";
import { translate } from "@/i18n/runtime";
import { ORCATERM_CONFIG } from "open-sse/config/orcaterm.js";
import { Button, Modal } from "@/shared/components";

async function oauthRequest(action, body, signal) {
  const response = await fetch(`/api/oauth/orcaterm/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "OrcaTerm sign-in failed");
  return data;
}

export default function OrcaTermOAuthModal({ isOpen, onClose, onSuccess }) {
  const widgetId = useId();
  const widgetRef = useRef(null);
  const callbacks = useRef({ onSuccess, onClose });
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");

  useEffect(() => { callbacks.current = { onSuccess, onClose }; }, [onSuccess, onClose]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const abort = new AbortController();
    const widget = widgetRef.current;
    let session;
    let sdk;
    let expiry;
    let exchanging = false;
    let finished = false;
    const fail = (err) => {
      if (abort.signal.aborted) return;
      clearTimeout(expiry);
      setError(err.message || "OrcaTerm sign-in failed");
      setStatus("error");
    };
    const onMessage = async (event) => {
      if (
        !session || exchanging || finished ||
        event.origin !== ORCATERM_CONFIG.origin ||
        event.source !== widget?.querySelector("iframe")?.contentWindow
      ) return;
      const data = event.data;
      if (!data || data.type !== "wechat-oauth-callback") return;
      if (data.state !== session.state) return;
      if (data.error) { fail(new Error("WeChat sign-in was declined. Please try again.")); return; }
      if (typeof data.code !== "string" || !data.code) return;
      exchanging = true;
      clearTimeout(expiry);
      setStatus("exchanging");
      try {
        const result = await oauthRequest("exchange", {
          sessionId: session.sessionId, state: session.state, code: data.code,
        }, abort.signal);
        if (abort.signal.aborted) return;
        finished = true;
        callbacks.current.onSuccess(result.connection);
      } catch (err) {
        fail(err);
      }
    };
    window.addEventListener("message", onMessage);

    const showQr = () => {
      if (abort.signal.aborted || !session || !widget || !window.WxLogin) return;
      widget.replaceChildren();
      try {
        new window.WxLogin({
          self_redirect: true,
          id: widgetId,
          appid: session.appid,
          scope: session.scope,
          redirect_uri: encodeURIComponent(session.redirectUri),
          state: session.state,
          style: "black",
          href: "",
        });
        setStatus("scan");
      } catch (err) { fail(err); }
    };
    oauthRequest("authorize", {}, abort.signal).then((data) => {
      session = data;
      if (abort.signal.aborted) {
        oauthRequest("cancel", { sessionId: data.sessionId }).catch(() => {});
        return;
      }
      expiry = setTimeout(() => fail(new Error("The QR code expired. Please refresh it.")), Math.max(0, data.expiresAt - Date.now()));
      if (window.WxLogin) showQr();
      else {
        sdk = document.createElement("script");
        sdk.src = ORCATERM_CONFIG.wechatSdkUrl;
        sdk.async = true;
        sdk.onload = showQr;
        sdk.onerror = () => fail(new Error("Could not load the WeChat sign-in widget."));
        document.head.appendChild(sdk);
      }
    }).catch(fail);

    return () => {
      abort.abort();
      clearTimeout(expiry);
      window.removeEventListener("message", onMessage);
      sdk?.remove();
      widget?.replaceChildren();
      if (session && !finished) oauthRequest("cancel", { sessionId: session.sessionId }).catch(() => {});
    };
  }, [isOpen, attempt, widgetId]);

  return (
    <Modal isOpen={isOpen} title={translate("OrcaTerm WeChat Sign-In")} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-text-muted">
          {translate("Scan with WeChat to authorize OrcaTerm. No Tencent Cloud console cookies or local browser access are required.")}
        </p>
        {status === "loading" && <p role="status">{translate("Loading QR code...")}</p>}
        <div ref={widgetRef} id={widgetId} className={status === "scan" ? "flex justify-center [&_iframe]:max-w-full" : "hidden"} />
        {status === "exchanging" && <p role="status">{translate("Completing sign-in...")}</p>}
        {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
        <p className="text-xs text-text-muted">
          {translate("The OrcaTerm token is stored by 10Router and renewed automatically while the grant remains valid. Model access and quotas depend on your account.")}
        </p>
        <Button variant="secondary" icon="refresh" onClick={() => {
          setStatus("loading");
          setError("");
          setAttempt((value) => value + 1);
        }} disabled={status === "exchanging"}>
          {translate("Refresh QR Code")}
        </Button>
      </div>
    </Modal>
  );
}

OrcaTermOAuthModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onSuccess: PropTypes.func.isRequired,
};
