"use client";

// AutoClaw（智谱澳龙）国际版网页登录弹窗（Google / z.ai）。
//
// 账号面的 oauth-url 受阿里云滑块验证保护（2026-11-24 实测 enabled:true，
// 缺回执 → 400001），回执只能由用户浏览器里的 Aliyun Captcha SDK 产出，所以
// 不走通用 OAuthModal（它在服务端直接铸授权页）：
//   1. 读 /api/oauth/autoclaw/captcha-config → 启用时加载 SDK、弹出滑块；
//   2. 回执交 /api/oauth/autoclaw/oauth-start 铸授权页 → 用户点开授权；
//   3. 授权后浏览器跳到打不开的 localhost:18432 页面——复制地址栏完整地址粘回，
//      /api/oauth/autoclaw/oauth-complete 换 token 并建连接（paste-callback，
//      与 junie / croli 同形）。
// SDK 调用形态移植自 hubo1989/opencode-autoclaw-auth 的本地引导页。父组件以
// 条件挂载方式渲染（卸载即重置状态）。
import { useState, useRef, useCallback } from "react";
import PropTypes from "prop-types";
import { translate } from "@/i18n/runtime";
import { Button, Input, Modal } from "@/shared/components";

const CAPTCHA_SDK_URL = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
const CAPTCHA_ELEMENT_ID = "autoclaw-captcha-element";
const CAPTCHA_TRIGGER_ID = "autoclaw-captcha-trigger";

function loadCaptchaSdk() {
  return new Promise((resolve) => {
    if (typeof window === "undefined") return resolve(false);
    if (window.initAliyunCaptcha) return resolve(true);
    const existing = document.querySelector(`script[src="${CAPTCHA_SDK_URL}"]`);
    const done = () => resolve(!!window.initAliyunCaptcha);
    if (existing) {
      existing.addEventListener("load", done, { once: true });
      setTimeout(done, 10000);
      return undefined;
    }
    const s = document.createElement("script");
    s.src = CAPTCHA_SDK_URL;
    s.async = true;
    s.onload = done;
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
    setTimeout(done, 10000);
    return undefined;
  });
}

export default function AutoclawOAuthModal({ isOpen, onClose, onAdded }) {
  const [vendor, setVendor] = useState("google");
  const [phase, setPhase] = useState("idle"); // idle | captcha | authorize | connecting
  const [flow, setFlow] = useState(null); // { flowId, authUrl, redirectUri }
  const [callbackUrl, setCallbackUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The captcha callback fires outside React's render cycle — read the vendor
  // through a ref kept in step with the picker.
  const vendorRef = useRef("google");
  const chooseVendor = (v) => {
    vendorRef.current = v;
    setVendor(v);
  };

  const requestAuthUrl = useCallback(async (captchaVerifyParam) => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/oauth/autoclaw/oauth-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendor: vendorRef.current, captchaVerifyParam: captchaVerifyParam || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || translate("Login failed"));
      setFlow({ flowId: data.flowId, authUrl: data.authUrl, redirectUri: data.redirectUri });
      setPhase("authorize");
    } catch (e) {
      setError(e.message);
      setPhase("idle");
    } finally {
      setBusy(false);
    }
  }, []);

  const start = async () => {
    setError("");
    setBusy(true);
    try {
      const cfgRes = await fetch("/api/oauth/autoclaw/captcha-config");
      const cfg = await cfgRes.json().catch(() => ({}));
      if (!cfg?.enabled) {
        await requestAuthUrl(null);
        return;
      }
      setPhase("captcha");
      window.AliyunCaptchaConfig = window.AliyunCaptchaConfig || { region: cfg.region || "ga", prefix: cfg.prefix || "" };
      const ok = await loadCaptchaSdk();
      if (!ok || !window.initAliyunCaptcha) {
        throw new Error(translate("The AutoClaw security-check component failed to load (network or ad blocker). Reload and try again."));
      }
      window.initAliyunCaptcha({
        SceneId: cfg.sceneId,
        mode: "popup",
        element: `#${CAPTCHA_ELEMENT_ID}`,
        button: `#${CAPTCHA_TRIGGER_ID}`,
        captchaVerifyCallback: (params) => {
          const receipt = typeof params === "string"
            ? params
            : typeof params?.captchaVerifyParam === "string"
              ? params.captchaVerifyParam
              : JSON.stringify(params || {});
          requestAuthUrl(receipt);
          return { captchaResult: true };
        },
        onBizResultCallback: () => {},
        getInstance: () => {},
        slideStyle: { width: 320, height: 40 },
        language: "cn",
        onError: (err) => setError(`${translate("Security check error")}: ${err?.message || ""}`),
      });
      // The SDK needs ~2s of warm-up before the trigger opens a filled popup
      // (an early click shows an empty box — opencode-autoclaw-auth note).
      setTimeout(() => document.getElementById(CAPTCHA_TRIGGER_ID)?.click(), 2300);
      setBusy(false);
    } catch (e) {
      setError(e.message);
      setPhase("idle");
      setBusy(false);
    }
  };

  const connect = async () => {
    setError("");
    setBusy(true);
    setPhase("connecting");
    try {
      const res = await fetch("/api/oauth/autoclaw/oauth-complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flowId: flow?.flowId, callbackUrl: callbackUrl.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || translate("Login failed"));
      onAdded(data.connection);
      onClose();
    } catch (e) {
      setError(e.message);
      setPhase("authorize");
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={isOpen} title={translate("AutoClaw Login")} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-xs text-text-muted leading-relaxed">
          {translate("Sign in with your AutoClaw international account. Quit the AutoClaw desktop app first (it owns the localhost:18432 callback). After you authorize, the browser lands on a localhost:18432 page that does not load — copy the whole address from the address bar and paste it below.")}
        </p>

        {phase === "idle" && (
          <>
            <div className="flex gap-2">
              {[
                { id: "google", label: "Google" },
                { id: "zai", label: "z.ai" },
              ].map((v) => (
                <Button
                  key={v.id}
                  size="sm"
                  variant={vendor === v.id ? "primary" : "secondary"}
                  onClick={() => chooseVendor(v.id)}
                >
                  {v.label}
                </Button>
              ))}
            </div>
            <Button onClick={start} disabled={busy} fullWidth>
              {busy ? translate("Preparing…") : translate("Start sign-in")}
            </Button>
          </>
        )}

        {/* Aliyun captcha mount points (popup mode renders over the page). */}
        <div id={CAPTCHA_ELEMENT_ID} />
        <button id={CAPTCHA_TRIGGER_ID} type="button" tabIndex={-1} aria-hidden="true"
          style={{ position: "fixed", width: 1, height: 1, opacity: 0, pointerEvents: "none", overflow: "hidden" }} />

        {phase === "captcha" && (
          <p className="text-sm text-text-muted">
            {busy ? translate("Preparing…") : translate("Complete the security check in the popup to continue.")}
          </p>
        )}

        {(phase === "authorize" || phase === "connecting") && flow && (
          <>
            <a
              href={flow.authUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-1 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2 text-sm text-primary hover:bg-primary/10"
            >
              <span className="material-symbols-outlined text-base">open_in_new</span>
              {translate("Open authorization page")}
            </a>
            <Input
              label={translate("Callback URL")}
              value={callbackUrl}
              onChange={(e) => setCallbackUrl(e.target.value)}
              placeholder={`${flow.redirectUri}?code=...&state=...`}
              className="font-mono text-xs"
            />
            <Button onClick={connect} disabled={busy || !callbackUrl.trim()} fullWidth>
              {phase === "connecting" ? translate("Logging in…") : translate("Verify & Add Connection")}
            </Button>
          </>
        )}

        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
    </Modal>
  );
}

AutoclawOAuthModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onAdded: PropTypes.func.isRequired,
};
