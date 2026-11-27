"use client";

import { useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";
import { translate } from "@/i18n/runtime";
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

/**
 * Desktop-style OrcaTerm sign-in: the WeChat QR page opens in a new tab, and the
 * user confirms here once the scan is done. This grant includes a refresh token,
 * which the embedded WeChat widget never returns.
 */
export default function OrcaTermOAuthModal({ isOpen, onClose, onSuccess }) {
  const callbacks = useRef({ onSuccess, onClose });
  const sessionRef = useRef(null);
  const abortRef = useRef(null);
  const finishedRef = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState("loading");
  const [authorizeUrl, setAuthorizeUrl] = useState("");
  const [error, setError] = useState("");

  useEffect(() => { callbacks.current = { onSuccess, onClose }; }, [onSuccess, onClose]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const abort = new AbortController();
    abortRef.current = abort;
    finishedRef.current = false;
    let expiry;
    const fail = (err) => {
      if (abort.signal.aborted) return;
      clearTimeout(expiry);
      setError(err.message || "OrcaTerm sign-in failed");
      setStatus("error");
    };
    oauthRequest("authorize", {}, abort.signal).then((data) => {
      if (abort.signal.aborted) {
        oauthRequest("cancel", { sessionId: data.sessionId }).catch(() => {});
        return;
      }
      sessionRef.current = data;
      setAuthorizeUrl(data.authorizeUrl);
      setStatus("scan");
      expiry = setTimeout(
        () => fail(new Error("The sign-in link expired. Please refresh it.")),
        Math.max(0, data.expiresAt - Date.now()),
      );
    }).catch(fail);

    return () => {
      abort.abort();
      clearTimeout(expiry);
      const session = sessionRef.current;
      sessionRef.current = null;
      setAuthorizeUrl("");
      if (session && !finishedRef.current) oauthRequest("cancel", { sessionId: session.sessionId }).catch(() => {});
    };
  }, [isOpen, attempt]);

  const complete = async () => {
    const session = sessionRef.current;
    const abort = abortRef.current;
    if (!session || status === "exchanging") return;
    setStatus("exchanging");
    setError("");
    try {
      const result = await oauthRequest("exchange", { sessionId: session.sessionId }, abort?.signal);
      if (abort?.signal.aborted) return;
      finishedRef.current = true;
      sessionRef.current = null;
      callbacks.current.onSuccess(result.connection);
    } catch (err) {
      if (abort?.signal.aborted) return;
      // The OrcaTerm session is single-use; a failed redemption needs a new link.
      sessionRef.current = null;
      setAuthorizeUrl("");
      setError(err.message || "OrcaTerm sign-in failed");
      setStatus("error");
    }
  };

  const restart = () => {
    setStatus("loading");
    setError("");
    setAttempt((value) => value + 1);
  };

  return (
    <Modal isOpen={isOpen} title={translate("OrcaTerm WeChat Sign-In")} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-text-muted">
          {translate("Open the WeChat sign-in page, scan it, then come back and finish here. No Tencent Cloud console cookies or local browser access are required.")}
        </p>
        {status === "loading" && <p role="status">{translate("Preparing sign-in link...")}</p>}
        {authorizeUrl && (status === "scan" || status === "exchanging") && (
          <div className="flex flex-col items-center gap-3">
            <a
              href={authorizeUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white no-underline hover:bg-blue-500"
            >
              {translate("1. Open the WeChat QR page")}
            </a>
            <p className="text-xs text-text-muted">
              {translate("If the browser offers to open the OrcaTerm app after the scan, cancel it. The link is valid for five minutes and works once.")}
            </p>
            <Button variant="primary" icon="check" onClick={complete} disabled={status === "exchanging"}>
              {translate("2. I have scanned it, finish sign-in")}
            </Button>
          </div>
        )}
        {status === "exchanging" && <p role="status">{translate("Completing sign-in...")}</p>}
        {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
        <p className="text-xs text-text-muted">
          {translate("The OrcaTerm token is stored by 10Router and renewed automatically while the grant remains valid. Model access and quotas depend on your account.")}
        </p>
        <Button variant="secondary" icon="refresh" onClick={restart} disabled={status === "exchanging"}>
          {translate("New Sign-In Link")}
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
