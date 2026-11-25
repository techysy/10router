"use client";

// 讯飞 Loomy 手机验证码直登弹窗（CreditDaddy 同源签名协议）：
// 输入手机号 → 收码 → 换 14 天 session 并直接创建 loomy 连接。
// 详情页与连接卡共用；父组件以条件挂载方式渲染（卸载即重置状态）。
import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import { translate } from "@/i18n/runtime";
import { Button, Input, Modal } from "@/shared/components";

export default function LoomySmsModal({ isOpen, onClose, onAdded }) {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [msgid, setMsgid] = useState("");
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
      const res = await fetch("/api/oauth/loomy/sms-send", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Send failed");
      setMsgid(data.msgid);
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
      const res = await fetch("/api/oauth/loomy/sms-login", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone, code, msgid }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Login failed");
      onAdded(data.connection);
      onClose();
    } catch (e) {
      setError(e.message);
      setBusy("");
    }
  };

  return (
    <Modal isOpen={isOpen} title={translate("Loomy SMS Login")} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-xs text-text-muted leading-relaxed">
          {translate("Log in with your iFlytek phone number — no Loomy client needed. The session lasts about 14 days and is added as a connection automatically.")}
        </p>
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Input label={translate("Phone Number")} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="13800138000" maxLength={11} />
          </div>
          <Button
            onClick={sendCode}
            disabled={busy === "send" || countdown > 0 || !/^1[3-9]\d{9}$/.test(phone.trim())}
            className="whitespace-nowrap"
          >
            {countdown > 0 ? `${countdown}s` : busy === "send" ? translate("Sending…") : translate("Send Code")}
          </Button>
        </div>
        {msgid && (
          <Input label={translate("SMS Code")} value={code} onChange={(e) => setCode(e.target.value)} placeholder={translate("6-digit code")} maxLength={6} />
        )}
        {error && <p className="text-sm text-red-500">{error}</p>}
        {msgid && (
          <Button onClick={login} disabled={busy === "login" || !code.trim()} fullWidth>
            {busy === "login" ? translate("Logging in…") : translate("Verify & Add Connection")}
          </Button>
        )}
      </div>
    </Modal>
  );
}

LoomySmsModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onAdded: PropTypes.func.isRequired,
};
