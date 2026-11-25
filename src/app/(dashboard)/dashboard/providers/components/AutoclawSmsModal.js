"use client";

// AutoClaw（智谱澳龙）国内版手机验证码直登弹窗（Loomy / Capy 两步同形）：
// 输入 +86 手机号 → 收码 → 换 token 对并直接创建 autoclaw-cn oauth 连接。
// 国内版没有网页 OAuth 授权链接，这是唯一的登录通道。父组件以条件挂载方式
// 渲染（卸载即重置状态）。
import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import { translate } from "@/i18n/runtime";
import { Button, Input, Modal } from "@/shared/components";

const PHONE_RE = /^1[3-9]\d{9}$/;

export default function AutoclawSmsModal({ isOpen, onClose, onAdded }) {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
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
      const res = await fetch("/api/oauth/autoclaw-cn/sms-send", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: phone.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || translate("Send failed"));
      setSent(true);
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
      const res = await fetch("/api/oauth/autoclaw-cn/sms-login", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: phone.trim(), code: code.trim() }),
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
    <Modal isOpen={isOpen} title={translate("AutoClaw CN SMS Login")} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-xs text-text-muted leading-relaxed">
          {translate("Log in with your AutoClaw (智谱澳龙) China phone number — a code is sent by SMS. Quit the AutoClaw desktop app for this account first: 10Router becomes the only client refreshing its login.")}
        </p>
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Input label={translate("Phone Number")} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="13800138000" maxLength={11} />
          </div>
          <Button
            onClick={sendCode}
            disabled={busy === "send" || countdown > 0 || !PHONE_RE.test(phone.trim())}
            className="whitespace-nowrap"
          >
            {countdown > 0 ? `${countdown}s` : busy === "send" ? translate("Sending…") : translate("Send Code")}
          </Button>
        </div>
        {sent && (
          <Input label={translate("SMS Code")} value={code} onChange={(e) => setCode(e.target.value)} placeholder={translate("6-digit code")} maxLength={8} />
        )}
        {error && <p className="text-sm text-red-500">{error}</p>}
        {sent && (
          <Button onClick={login} disabled={busy === "login" || !code.trim()} fullWidth>
            {busy === "login" ? translate("Logging in…") : translate("Verify & Add Connection")}
          </Button>
        )}
      </div>
    </Modal>
  );
}

AutoclawSmsModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onAdded: PropTypes.func.isRequired,
};
