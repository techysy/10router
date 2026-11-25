"use client";

// Capy 邮箱验证码登录弹窗（官方桌面端同款 Clerk Native API 通道）：
// 输入 Capy 账号邮箱 → 收码 → 验证并验证模型访问后创建 oauth 连接。
// 线程跑在账号已登记的在线设备上；连接存 rotating clientJwt 供持续 mint。
import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import { translate } from "@/i18n/runtime";
import { Button, Input, Modal } from "@/shared/components";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function CapyLoginModal({ isOpen, onClose, onAdded }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [flowId, setFlowId] = useState("");
  const [countdown, setCountdown] = useState(0);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (countdown <= 0) return undefined;
    const t = setInterval(() => setCountdown((c) => c - 1), 1000);
    return () => clearInterval(t);
  }, [countdown]);

  const sendCode = async () => {
    setError("");
    setBusy("send");
    try {
      const res = await fetch("/api/oauth/capy/code-send", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || translate("Send failed"));
      setFlowId(data.flowId);
      setCountdown(60);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  };

  const login = async () => {
    setError("");
    setBusy("login");
    try {
      const res = await fetch("/api/oauth/capy/code-login", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ flowId, code: code.trim(), email: email.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || translate("Login failed"));
      onAdded(data.connection);
      onClose();
    } catch (e) {
      setError(e.message);
      setBusy("");
    }
  };

  return (
    <Modal isOpen={isOpen} title={translate("Capy Login")} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-xs text-text-muted leading-relaxed">
          {translate("Log in with your Capy account email — a code is sent to your inbox (same channel as the Capy desktop app). Threads run on your connected Capy device.")}
        </p>
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Input label={translate("Email")} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" type="email" />
          </div>
          <Button
            onClick={sendCode}
            disabled={busy === "send" || countdown > 0 || !EMAIL_RE.test(email.trim())}
            className="whitespace-nowrap"
          >
            {countdown > 0 ? `${countdown}s` : busy === "send" ? translate("Sending…") : translate("Send Code")}
          </Button>
        </div>
        {flowId && (
          <Input label={translate("Email Code")} value={code} onChange={(e) => setCode(e.target.value)} placeholder={translate("6-digit code")} maxLength={6} />
        )}
        {error && <p className="text-sm text-red-500">{error}</p>}
        {flowId && (
          <Button onClick={login} disabled={busy === "login" || !code.trim()} fullWidth>
            {busy === "login" ? translate("Logging in…") : translate("Verify & Add Connection")}
          </Button>
        )}
      </div>
    </Modal>
  );
}

CapyLoginModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onAdded: PropTypes.func.isRequired,
};
