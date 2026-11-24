"use client";

// QuWork 账号弹窗（连接卡「账号」按钮）：
//   - 显示 微信已绑定/未绑定、我的邀请码（aff_code）、邀请人、邀请统计
//   - 绑定微信：生成微信扫码链接（新标签打开）→ 扫码确认后浏览器跳到
//     llm.rrzu.com/oauth/wechat?code=…（QuWork 的页面，10Router 拦截不到）→
//     把地址栏完整地址（或 code）粘回来提交。code 一次性、约 5 分钟有效。
//   - 填写邀请码/兑换码（需先绑定微信）。
// 所有请求由服务端经该连接的代理发出。
import { useState, useEffect, useCallback } from "react";
import PropTypes from "prop-types";
import { Button, Input, Modal } from "@/shared/components";

export default function QuworkAccountModal({ isOpen, onClose, connection, onChanged }) {
  const connectionId = connection?.id;
  const [account, setAccount] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [qr, setQr] = useState(null);
  const [callback, setCallback] = useState("");
  const [code, setCode] = useState("");

  const load = useCallback(async () => {
    if (!connectionId) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/oauth/quwork/account?connectionId=${encodeURIComponent(connectionId)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "读取账号信息失败");
      setAccount(data.account);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    if (isOpen) load();
  }, [isOpen, load]);

  const post = async (path, body) => {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionId, ...body }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || "操作失败");
    return data;
  };

  const startWechat = async () => {
    setError("");
    setInfo("");
    setBusy("qr");
    try {
      const data = await post("/api/oauth/quwork/wechat-qr", {});
      setQr(data);
      setCallback("");
      window.open(data.url, "_blank", "noopener,noreferrer");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  };

  const submitBind = async () => {
    setError("");
    setInfo("");
    setBusy("bind");
    try {
      const data = await post("/api/oauth/quwork/wechat-bind", { callback: callback.trim() });
      setInfo(data.message || "微信绑定成功");
      setQr(null);
      setCallback("");
      await load();
      onChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  };

  const submitCode = async () => {
    setError("");
    setInfo("");
    setBusy("activate");
    try {
      const data = await post("/api/oauth/quwork/activate", { code: code.trim() });
      setInfo(data.message || "激活成功");
      setCode("");
      await load();
      onChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  };

  const row = (label, value) => (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-text-muted">{label}</span>
      <span className="font-medium text-text-main break-all text-right">{value}</span>
    </div>
  );

  const wechatBound = account?.wechatBound === true;

  return (
    <Modal isOpen={isOpen} title={`QuWork 账号 · ${connection?.name || connection?.displayName || ""}`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2 rounded-lg bg-bg-alt p-3">
          {loading && !account ? (
            <p className="text-sm text-text-muted">读取中…</p>
          ) : account ? (
            <>
              {row("微信", wechatBound ? "已绑定" : "未绑定")}
              {row("我的邀请码", account.affCode || "—")}
              {row("邀请人", account.inviterId || "无（未填写邀请码）")}
              {typeof account.points === "number" && row("剩余积分", account.points.toLocaleString("zh-CN", { maximumFractionDigits: 2 }))}
              {account.invite && (account.invite.count !== null || account.invite.points !== null) &&
                row("已邀请", `${account.invite.count ?? "—"} 人${account.invite.points !== null ? ` · 奖励 ${account.invite.points} 积分` : ""}`)}
            </>
          ) : (
            <p className="text-sm text-text-muted">暂无账号信息</p>
          )}
        </div>

        {account && !wechatBound && (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">绑定微信</p>
            <p className="text-xs text-text-muted leading-relaxed">
              点击按钮在新标签打开微信扫码页，用微信扫码并确认。之后浏览器会跳到 llm.rrzu.com/oauth/wechat?code=… 的页面——复制地址栏里的完整地址粘到下面提交。code 只能用一次，约 5 分钟内有效；如果该微信已绑定其他 QuWork 账号，会提示失败且不会绑定。
            </p>
            <Button onClick={startWechat} disabled={busy === "qr"} variant="secondary">
              {busy === "qr" ? "生成中…" : qr ? "重新生成扫码链接" : "绑定微信（打开扫码页）"}
            </Button>
            {qr && (
              <>
                <a href={qr.url} target="_blank" rel="noreferrer noopener" className="text-xs text-primary underline break-all">
                  扫码页没有自动打开？点这里
                </a>
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <Input label="扫码后跳转的地址（或 code）" value={callback} onChange={(e) => setCallback(e.target.value)} placeholder="https://llm.rrzu.com/oauth/wechat?code=...&state=..." />
                  </div>
                  <Button onClick={submitBind} disabled={busy === "bind" || !callback.trim()} className="whitespace-nowrap">
                    {busy === "bind" ? "绑定中…" : "提交绑定"}
                  </Button>
                </div>
              </>
            )}
          </div>
        )}

        {account && (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">填写邀请码 / 兑换码</p>
            {!wechatBound && <p className="text-xs text-amber-600 dark:text-amber-400">QuWork 要求先绑定微信才能激活邀请码/兑换码。</p>}
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Input label="邀请码 / 兑换码" value={code} onChange={(e) => setCode(e.target.value)} placeholder="输入邀请码或兑换码" maxLength={64} />
              </div>
              <Button onClick={submitCode} disabled={busy === "activate" || !code.trim()} className="whitespace-nowrap">
                {busy === "activate" ? "提交中…" : "激活"}
              </Button>
            </div>
          </div>
        )}

        {info && !error && <p className="text-sm text-green-600 dark:text-green-400">{info}</p>}
        {error && <p className="text-sm text-red-500">{error}</p>}
        <div className="flex justify-end">
          <Button onClick={load} disabled={loading} variant="ghost" size="sm">{loading ? "刷新中…" : "刷新"}</Button>
        </div>
      </div>
    </Modal>
  );
}

QuworkAccountModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  connection: PropTypes.object,
  onChanged: PropTypes.func,
};
