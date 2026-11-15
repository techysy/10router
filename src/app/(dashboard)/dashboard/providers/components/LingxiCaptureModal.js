"use client";

// WPS 灵犀 session-capture dialog. Two ways in side by side (no QR flow —
// WPS login has captcha/risk control we don't touch):
//   - Bookmarklet (recommended): drag the button to the bookmarks bar, open
//     lingxi.kdocs.cn, log in, click the bookmark — document.cookie posts back
//     through a one-time `ot` token and the dialog auto-completes.
//   - Paste: F12 → Console → document.cookie on a logged-in lingxi page.
//
// Mount contract: parent mounts this only while open (like DumateQrModal) —
// state resets on unmount and the ot token is minted on mount.
import { useState, useEffect, useRef } from "react";
import PropTypes from "prop-types";
import { Button, Modal } from "@/shared/components";

export default function LingxiCaptureModal({ isOpen, onClose, connectionId, onSuccess }) {
  const [paste, setPaste] = useState("");
  const [pst, setPst] = useState(null); // {p:"work"|"ok"|"err", name?, error?}
  const [ot, setOt] = useState("");
  const openedAt = useRef(0);
  const cid = connectionId || "";

  const origin = typeof location !== "undefined" ? location.origin : "";
  // Bookmarklet: opens lingxi.kdocs.cn if needed, sanity-checks the WPS login
  // cookies, then POSTs document.cookie back through the one-time `ot` token
  // (the SameSite=Lax session cookie never leaves the dashboard origin).
  const bookmarkHref = ot
    ? "javascript:(()=>{var u='" + origin + "',c='" + cid + "',t='" + ot + "';" +
      "if(!/(^|\\.)kdocs\\.cn$/.test(location.hostname)){location.href='https://lingxi.kdocs.cn/';return}" +
      "if(!/wps_sid=/.test(document.cookie)){alert('本页面还没有检测到 WPS 登录态（wps_sid）。\\n\\n请先在 lingxi.kdocs.cn 完成登录（右上角出现你的头像/账号），登录成功后再点一次书签。');" +
      "if(location.hostname!=='lingxi.kdocs.cn'){return}location.href='https://lingxi.kdocs.cn/';return}" +
      "fetch(u+'/api/oauth/lingxi/import?ot='+t+(c?'&connectionId='+c:''),{method:'POST',headers:{'Content-Type':'text/plain'},body:document.cookie})" +
      ".then(async r=>{let j={};try{j=await r.json()}catch(e){}if(j.ok){location.href=u+'/dashboard/providers/lingxi'}else{alert('导入失败：'+((j&&j.error)||('HTTP '+r.status)))}})" +
      ".catch(e=>alert('网络错误：'+e))})()"
    : "";

  // Mount-only: mint the ot token, start the connections watcher.
  useEffect(() => {
    openedAt.current = Date.now();
    fetch("/api/oauth/lingxi/import-init?connectionId=" + encodeURIComponent(cid), { method: "POST" })
      .then((r) => r.json())
      .then((j) => { if (j && j.ot) setOt(j.ot); })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Bookmarklet path: watch the connections list for a new/updated row.
  useEffect(() => {
    const iv = setInterval(async () => {
      try {
        const r = await fetch("/api/providers");
        if (!r.ok) return;
        const j = await r.json();
        const list = (j.connections || []).filter((c) => c.provider === "lingxi");
        if (cid) {
          const hit = list.find((c) => c.id === cid);
          if (hit && new Date(hit.updatedAt || 0).getTime() > openedAt.current) {
            setPst({ p: "ok", ok: true, name: hit.name });
          }
        } else {
          const hit = list.find((c) => new Date(c.createdAt || 0).getTime() > openedAt.current);
          if (hit) setPst({ p: "ok", ok: true, name: hit.name });
        }
      } catch { /* transient */ }
    }, 3000);
    return () => clearInterval(iv);
  }, [cid]);

  const close = () => {
    const ok = pst && pst.ok;
    onClose();
    if (ok) {
      if (onSuccess) onSuccess();
      else window.location.reload();
    }
  };

  const submit = async () => {
    if (!paste.trim() || (pst && pst.p === "work")) return;
    setPst({ p: "work" });
    try {
      const r = await fetch("/api/oauth/lingxi/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId: cid || undefined, cookies: paste }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "HTTP " + r.status);
      setPst({ p: "ok", ok: true, name: j.connectionName });
    } catch (e) {
      setPst({ p: "err", error: String(e && e.message || e) });
    }
  };

  return (
    <Modal isOpen={isOpen} title={cid ? "重新捕获 WPS 灵犀会话" : "捕获 WPS 灵犀会话（新建连接）"} onClose={close}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 text-sm">
          <p>
            ① 把这个按钮{" "}
            {ot ? (
              // React sanitizes javascript: hrefs — set it via ref instead.
              <a
                ref={(e) => { if (e && e.getAttribute("href") !== bookmarkHref) e.setAttribute("href", bookmarkHref); }}
                href="#"
                onClick={(e) => { e.preventDefault(); window.open("https://lingxi.kdocs.cn/", "_blank"); }}
                className="inline-flex cursor-move select-none items-center gap-1 rounded-md bg-blue-600 px-2 py-0.5 text-xs text-white no-underline hover:bg-blue-500"
              >
                捕获灵犀会话
              </a>
            ) : (
              <span className="text-xs text-text-muted">生成中…</span>
            )}{" "}
            拖到浏览器书签栏（只做一次）
          </p>
          <p>② 点一下书签 → 自动打开灵犀网页版，用 WPS 账号任意方式登录（已登录会直接进入下一步）</p>
          <p>③ 在灵犀页面再点一次书签 → Cookie 自动回传，本弹窗检测到后会自己完成保存 + 验证</p>
          <p className="text-xs text-text-muted">注：书签里的捕获令牌 10 分钟有效，过期重开弹窗换新链接；Cookie 只存本机。</p>
        </div>

        <div className="flex flex-col gap-3 border-t border-black/10 pt-3 dark:border-white/10">
          <p className="text-xs text-text-muted">
            手动方式：在{" "}
            <a href="https://lingxi.kdocs.cn/" target="_blank" rel="noreferrer" className="text-blue-500 hover:underline">
              lingxi.kdocs.cn
            </a>{" "}
            登录后按 F12 → Console，输入 <code>document.cookie</code> 回车，复制整段结果粘贴到下面（或 Cookie-Editor 导出的 JSON）：
          </p>
          <textarea
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            rows={3}
            spellCheck={false}
            placeholder="粘贴 document.cookie 的整段输出（需包含 wps_sid）"
            className="w-full rounded-lg border border-black/10 bg-transparent px-3 py-2 font-mono text-xs outline-none focus:border-blue-500 dark:border-white/10"
          />
        </div>
        {pst && pst.p === "err" && (
          <p style={{ maxWidth: 420, wordBreak: "break-word" }} className="text-xs text-red-500">{pst.error}</p>
        )}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={close}>{pst && pst.ok ? "完成" : "关闭"}</Button>
          {(!pst || !pst.ok) && (
            <Button size="sm" variant="primary" icon={pst && pst.p === "work" ? "progress_activity" : "check"} onClick={submit}>
              {pst && pst.p === "work" ? "正在验证会话…" : "粘贴验证并保存"}
            </Button>
          )}
        </div>
        {pst && pst.ok && (
          <p className="text-xs text-green-500">
            会话有效{pst.name ? `，已保存到「${pst.name}」` : ""}
          </p>
        )}
      </div>
    </Modal>
  );
}

LingxiCaptureModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  connectionId: PropTypes.string,
  onSuccess: PropTypes.func,
};
