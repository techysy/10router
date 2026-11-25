"use client";

// QuWork 登录弹窗：
//   1) 手机号 + 短信：点「人机验证并发送验证码」→ 打开 /api/oauth/quwork/captcha
//      滑块页（阿里云验证码，QuWork 桌面端同配置）→ 验证成功经 postMessage 回传
//      token → 服务端带 token 发短信 → 输入验证码完成登录。
//   2) 粘贴 token：llm_token（必填，推理）+ 账号 access token（选填，积分/签到）。
// 请求由服务端发出；QuWork 网关只放行中国大陆 IP（否则 405），海外部署请在
// 设置中配置全局出站代理或在连接上配置代理。
import { useState, useEffect, useRef, useCallback } from "react";
import PropTypes from "prop-types";
import { Button, Input, Modal } from "@/shared/components";

const PHONE_RE = /^1\d{10}$/;

export default function QuworkLoginModal({ isOpen, onClose, onAdded }) {
  const [tab, setTab] = useState("sms");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [captcha, setCaptcha] = useState("");
  const [manualCaptcha, setManualCaptcha] = useState(false);
  const [sent, setSent] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [llmToken, setLlmToken] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const phoneRef = useRef(phone);
  useEffect(() => {
    phoneRef.current = phone;
  }, [phone]);

  useEffect(() => {
    if (countdown <= 0) return undefined;
    const t = setInterval(() => setCountdown((c) => c - 1), 1000);
    return () => clearInterval(t);
  }, [countdown]);

  const sendCode = useCallback(async (captchaToken) => {
    setError("");
    setInfo("");
    setBusy("send");
    try {
      const res = await fetch("/api/oauth/quwork/sms-send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phoneRef.current.trim(), captcha: captchaToken }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "发送失败");
      setSent(true);
      setCountdown(60);
      setInfo("验证码已发送，请查看短信");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return undefined;
    const onMsg = (ev) => {
      if (ev.origin !== window.location.origin) return;
      if (ev.data?.type !== "quwork-captcha" || !ev.data?.token) return;
      setCaptcha(ev.data.token);
      sendCode(ev.data.token);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [isOpen, sendCode]);

  const openCaptcha = () => {
    setError("");
    const w = window.open("/api/oauth/quwork/captcha", "quwork-captcha", "width=460,height=620");
    if (!w) {
      setManualCaptcha(true);
      setError("弹窗被浏览器拦截：请允许弹窗，或在新标签打开验证页后把验证结果粘贴到下方");
    }
  };

  const login = async () => {
    setError("");
    setBusy("login");
    try {
      const res = await fetch("/api/oauth/quwork/sms-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phone.trim(), code: code.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "登录失败");
      onAdded(data.connection);
      onClose();
    } catch (e) {
      setError(e.message);
      setBusy("");
    }
  };

  const importToken = async () => {
    setError("");
    setBusy("import");
    try {
      const res = await fetch("/api/oauth/quwork/import-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ llmToken: llmToken.trim(), accessToken: accessToken.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "导入失败");
      if (data.warning) window.alert(data.warning);
      onAdded(data.connection);
      onClose();
    } catch (e) {
      setError(e.message);
      setBusy("");
    }
  };

  const tabBtn = (id, label) => (
    <button
      type="button"
      onClick={() => { setTab(id); setError(""); }}
      className={`flex-1 rounded-md px-3 py-1.5 text-sm transition-colors ${tab === id ? "bg-primary text-white" : "text-text-muted hover:bg-black/5 dark:hover:bg-white/5"}`}
    >
      {label}
    </button>
  );

  return (
    <Modal isOpen={isOpen} title="QuWork 登录" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div className="flex gap-1 rounded-lg bg-bg-alt p-1">
          {tabBtn("sms", "手机号 + 短信")}
          {tabBtn("token", "粘贴 Token")}
        </div>

        {tab === "sms" ? (
          <>
            <p className="text-xs text-text-muted leading-relaxed">
              输入 QuWork 账号手机号，点击按钮完成弹出的滑块验证后自动发送短信验证码。登录后保存 llm_token（推理）与账号 token（积分/签到，自动续期）。
            </p>
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Input label="手机号" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="13800000000" maxLength={11} />
              </div>
              <Button
                onClick={openCaptcha}
                disabled={busy === "send" || countdown > 0 || !PHONE_RE.test(phone.trim())}
                className="whitespace-nowrap"
              >
                {countdown > 0 ? `${countdown}s` : busy === "send" ? "发送中…" : sent ? "重新发送" : "人机验证并发送验证码"}
              </Button>
            </div>
            {manualCaptcha && (
              <div className="flex flex-col gap-2">
                <a href="/api/oauth/quwork/captcha" target="_blank" rel="noreferrer" className="text-xs text-primary underline">在新标签打开滑块验证页</a>
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <Input label="验证结果（从验证页复制）" value={captcha} onChange={(e) => setCaptcha(e.target.value)} placeholder="粘贴验证页显示的结果" />
                  </div>
                  <Button onClick={() => sendCode(captcha.trim())} disabled={!captcha.trim() || !PHONE_RE.test(phone.trim()) || busy === "send"} className="whitespace-nowrap">
                    发送验证码
                  </Button>
                </div>
              </div>
            )}
            {sent && (
              <Input label="短信验证码" value={code} onChange={(e) => setCode(e.target.value)} placeholder="短信验证码" maxLength={8} />
            )}
            {info && !error && <p className="text-sm text-green-600 dark:text-green-400">{info}</p>}
            {error && <p className="text-sm text-red-500">{error}</p>}
            {sent && (
              <Button onClick={login} disabled={busy === "login" || !code.trim()} fullWidth>
                {busy === "login" ? "登录中…" : "登录并添加连接"}
              </Button>
            )}
          </>
        ) : (
          <>
            <p className="text-xs text-text-muted leading-relaxed">
              llm_token 即 QuWork 模型 API Key（桌面端 ~/.qurwork-desktop-dsh/.dsh/.credentials.yaml 的 QURIVS_LLM_API_KEY，或登录响应 llm_token）。access token 是登录响应的 token 字段，填了才能显示积分、自动签到。
            </p>
            <Input label="llm_token（必填）" type="password" value={llmToken} onChange={(e) => setLlmToken(e.target.value)} placeholder="llm_token" />
            <Input label="access token（选填）" type="password" value={accessToken} onChange={(e) => setAccessToken(e.target.value)} placeholder="token" />
            {error && <p className="text-sm text-red-500">{error}</p>}
            <Button onClick={importToken} disabled={busy === "import" || !llmToken.trim()} fullWidth>
              {busy === "import" ? "校验中…" : "校验并添加连接"}
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}

QuworkLoginModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onAdded: PropTypes.func.isRequired,
};
