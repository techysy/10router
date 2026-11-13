"use client";

// DuMate (百度搭子) login dialog. Two tabs:
//   - QR login (recommended): server-side Baidu passport QR flow — no browser
//     is spawned anywhere. Polls /api/oauth/dumate/qr-status; on "success" the
//     connection is already created/updated and tested.
//   - Other methods (fallback): a bookmarklet that runs on passport.baidu.com
//     and posts document.cookie back through a one-time `ot` token, or a plain
//     document.cookie / exported-JSON paste.
import { useState, useEffect, useRef } from "react";
import PropTypes from "prop-types";
import { Button, Modal } from "@/shared/components";

const STATUS_MSG = {
  starting: "正在生成二维码…",
  waiting: "请用百度 App / 百度网盘 App / 百度智能云 App 扫描二维码",
  scanned: "已扫码，请在手机上确认登录",
  confirming: "已确认，正在完成登录…",
  authorized: "登录成功，正在保存并换 DuMate token…",
  saving: "登录成功，正在保存并换 DuMate token…",
  success: "登录成功，连接已更新",
  expired: "二维码已过期",
  cancelled: "已取消",
  error: "扫码登录失败",
};
const TERMINAL = ["success", "expired", "error", "cancelled"];

export default function DumateQrModal({ isOpen, onClose, connectionId, onSuccess }) {
  const [st, setSt] = useState(null);          // last qr-status payload
  const [sid, setSid] = useState(null);
  const [er, setEr] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [tab, setTab] = useState("qr");
  const [paste, setPaste] = useState("");
  const [pst, setPst] = useState(null);        // {p:"work"|"ok"|"err", ...}
  const [ot, setOt] = useState("");
  const openedAt = useRef(0);
  const cid = connectionId || "";

  const origin = typeof location !== "undefined" ? location.origin : "";
  // Bookmarklet: opens passport.baidu.com if needed, sanity-checks the login
  // cookies, then POSTs document.cookie back through the one-time `ot` token
  // (the SameSite=Lax session cookie never leaves the dashboard origin).
  const bookmarkHref = ot
    ? "javascript:(()=>{var u='" + origin + "',c='" + cid + "',t='" + ot + "';" +
      "if(!/(^|\\.)passport\\.baidu\\.com$/.test(location.hostname)){location.href='https://passport.baidu.com/';return}" +
      "if(!/BDUSS(_BFESS)?=/.test(document.cookie)){alert('本页面还没有检测到百度登录态。\\n\\n请先在 passport.baidu.com 完成登录（页面右上角应显示你的账号），登录成功后再点一次书签。\\n\\n如果你是在 wappass 或其他百度子域登录的，请在本页重新登录一次。');return}" +
      "if(!/(STOKEN|PTOKEN|UBI)(_BFESS)?=/.test(document.cookie)){alert('百度登录态不完整（缺 STOKEN/PTOKEN/UBI）。\\n\\n请在本页退出后重新登录一次，登录成功后再点书签。');return}" +
      "fetch(u+'/api/oauth/dumate/import?ot='+t+(c?'&connectionId='+c:''),{method:'POST',headers:{'Content-Type':'text/plain'},body:document.cookie})" +
      ".then(async r=>{let j={};try{j=await r.json()}catch(e){}if(j.ok){location.href=u+'/dashboard/providers/dumate'}else{alert('导入失败：'+((j&&j.error)||('HTTP '+r.status)))}})" +
      ".catch(e=>alert('网络错误：'+e))})()"
    : "";

  const start = async () => {
    setEr(null);
    setSt({ status: "starting" });
    setSid(null);
    try {
      const r = await fetch("/api/oauth/dumate/qr-start?connectionId=" + encodeURIComponent(cid), { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
      setSt(j);
      setSid(j.sid);
    } catch (e) {
      setSt({ status: "error" });
      setEr(e.message || String(e));
    }
  };

  useEffect(() => {
    if (!isOpen) return undefined;
    openedAt.current = Date.now();
    setTab("qr");
    setPst(null);
    setPaste("");
    setOt("");
    start();
    fetch("/api/oauth/dumate/import-init", { method: "POST" })
      .then((r) => r.json())
      .then((j) => { if (j && j.ot) setOt(j.ot); })
      .catch(() => {});
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // QR session polling
  useEffect(() => {
    if (!sid) return undefined;
    let alive = true;
    const t = setInterval(async () => {
      setNow(Date.now());
      try {
        const r = await fetch("/api/oauth/dumate/qr-status?sid=" + sid, { cache: "no-store" });
        const j = await r.json().catch(() => ({}));
        if (!alive) return;
        if (!r.ok) {
          setSt({ status: "error" });
          setEr(j.error || "HTTP " + r.status);
          clearInterval(t);
          return;
        }
        setSt(j);
        if (j.error) setEr(j.error);
        if (TERMINAL.includes(j.status)) clearInterval(t);
      } catch { /* transient poll failure — next tick retries */ }
    }, 1500);
    return () => { alive = false; clearInterval(t); };
  }, [sid]);

  // Bookmarklet path: watch the connections list for a new/updated row
  useEffect(() => {
    if (!isOpen) return undefined;
    const iv = setInterval(async () => {
      try {
        const r = await fetch("/api/providers");
        if (!r.ok) return;
        const j = await r.json();
        const list = (j.connections || []).filter((c) => c.provider === "dumate");
        if (cid) {
          const hit = list.find((c) => c.id === cid);
          if (hit && new Date(hit.updatedAt || 0).getTime() > openedAt.current) {
            setPst({ p: "ok", ok: true, name: hit.name, exp: hit.earliestPackageExpiry });
          }
        } else {
          const hit = list.find((c) => new Date(c.createdAt || 0).getTime() > openedAt.current);
          if (hit) setPst({ p: "ok", ok: true, name: hit.name, exp: hit.earliestPackageExpiry });
        }
      } catch { /* transient */ }
    }, 3000);
    return () => clearInterval(iv);
  }, [isOpen, cid]);

  const close = () => {
    const w = st && st.status;
    if (sid && w && !TERMINAL.includes(w)) {
      fetch("/api/oauth/dumate/qr-cancel?sid=" + sid, { method: "POST" }).catch(() => {});
    }
    setSid(null);
    setSt(null);
    setEr(null);
    onClose();
    if (w === "success" || (pst && pst.ok)) {
      if (onSuccess) onSuccess();
      else window.location.reload();
    }
  };

  const submit = async () => {
    if (!paste.trim() || (pst && pst.p === "work")) return;
    setPst({ p: "work" });
    try {
      const r = await fetch("/api/oauth/dumate/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId: cid || undefined, cookies: paste }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || "HTTP " + r.status);
      setPst({ p: "ok", ok: true, name: j.connectionName, exp: j.tokenExpiresAt });
    } catch (e) {
      setPst({ p: "err", error: String(e && e.message || e) });
    }
  };

  const w = st && st.status;
  const left = st && st.expiresAt ? Math.max(0, Math.round((st.expiresAt - now) / 1000)) : null;
  const mmss = left == null ? "" : Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0");
  const busy = ["starting", "authorized", "saving", "confirming"].includes(w);
  const fin = ["expired", "error", "cancelled"].includes(w);
  const tabcls = (k) =>
    "rounded-md px-2.5 py-1 text-xs " + (tab === k ? "bg-blue-600/15 text-blue-500 font-medium" : "text-text-muted hover:text-text-base");

  return (
    <Modal isOpen={isOpen} title={cid ? "重新登录 DuMate" : "登录 DuMate（新建连接）"} onClose={close}>
      <div className="flex flex-col gap-4">
        <div className="flex gap-2">
          <button type="button" className={tabcls("qr")} onClick={() => setTab("qr")}>二维码登录（推荐）</button>
          <button type="button" className={tabcls("man")} onClick={() => setTab("man")}>其他方式</button>
        </div>

        {tab === "qr" && (
          <div className="flex flex-col items-center gap-4">
            {/* QR PNG is a 1-bit transparent image — always render on white */}
            <div
              style={{ width: 232, height: 232, padding: 8, background: "#fff" }}
              className="flex items-center justify-center rounded-lg border border-black/10 dark:border-white/10"
            >
              {st && st.qr && !fin && w !== "success" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={st.qr}
                  alt="百度扫码登录二维码"
                  style={{ width: "100%", height: "100%", objectFit: "contain", opacity: w === "scanned" || w === "confirming" ? 0.3 : 1 }}
                />
              ) : (
                <span
                  style={{ fontSize: 48 }}
                  className={"material-symbols-outlined text-text-muted" + (busy ? " animate-spin" : "")}
                >
                  {w === "success" ? "check_circle" : fin ? "qr_code_2" : "progress_activity"}
                </span>
              )}
            </div>
            <div className="flex flex-col items-center gap-1 text-center">
              <p className={"text-sm font-medium" + (w === "success" ? " text-green-500" : w === "error" ? " text-red-500" : "")}>
                {STATUS_MSG[w] || ""}
              </p>
              {w === "waiting" && left != null && (
                <p className="text-xs text-text-muted">
                  二维码 {mmss} 后过期。登录成功后会自动保存{cid ? "到这条连接" : "为新连接"}，之后登录态过期会在后台自动续期。
                </p>
              )}
              {w === "success" && st.tokenExpiresAt && (
                <p className="text-xs text-text-muted">DuMate token 到期：{new Date(st.tokenExpiresAt).toLocaleString()}</p>
              )}
              {er && <p style={{ maxWidth: 360, wordBreak: "break-word" }} className="text-xs text-red-500">{er}</p>}
            </div>
            <div className="flex gap-2">
              {fin && <Button size="sm" variant="primary" icon="refresh" onClick={start}>刷新二维码</Button>}
              <Button size="sm" variant={w === "success" ? "primary" : "ghost"} onClick={close}>
                {w === "success" ? "完成" : "关闭"}
              </Button>
            </div>
          </div>
        )}

        {tab === "man" && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2 text-sm">
              <p>
                ① 把这个按钮{" "}
                {ot ? (
                  // React sanitizes javascript: hrefs — set it via ref instead.
                  <a
                    ref={(e) => { if (e && e.getAttribute("href") !== bookmarkHref) e.setAttribute("href", bookmarkHref); }}
                    href="#"
                    onClick={(e) => { e.preventDefault(); window.open("https://passport.baidu.com/", "_blank"); }}
                    className="inline-flex cursor-move select-none items-center gap-1 rounded-md bg-blue-600 px-2 py-0.5 text-xs text-white no-underline hover:bg-blue-500"
                  >
                    连接 DuMate
                  </a>
                ) : (
                  <span className="text-xs text-text-muted">生成中…</span>
                )}{" "}
                拖到浏览器书签栏（只做一次；点它可直接打开登录页）
              </p>
              <p>② 点一下书签 → 自动打开百度通行证页，用密码 / 短信 / 百度 App 任意方式登录（已登录会直接进入下一步）</p>
              <p>③ 在通行证页再点一次书签 → 登录态自动回传，本弹窗检测到后会自己完成</p>
              <p className="text-xs text-text-muted">注：书签里的登录令牌 10 分钟有效，过期重开弹窗换新链接</p>
            </div>
            <div className="flex flex-col gap-2 border-t border-black/10 pt-3 dark:border-white/10">
              <p className="text-xs text-text-muted">
                手动方式：在{" "}
                <a href="https://passport.baidu.com/" target="_blank" rel="noreferrer" className="text-blue-500 hover:underline">
                  passport.baidu.com
                </a>{" "}
                登录后按 F12 → Console，输入 <code>document.cookie</code> 回车，复制整段结果粘贴到下面：
              </p>
              <textarea
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
                rows={3}
                spellCheck={false}
                placeholder="粘贴 document.cookie 的整段输出（或 Cookie-Editor 导出的 JSON）"
                className="w-full rounded-lg border border-black/10 bg-transparent px-3 py-2 font-mono text-xs outline-none focus:border-blue-500 dark:border-white/10"
              />
            </div>
            {pst && pst.p === "err" && (
              <p style={{ maxWidth: 420, wordBreak: "break-word" }} className="text-xs text-red-500">{pst.error}</p>
            )}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={close}>{pst && pst.ok ? "完成" : "取消"}</Button>
              {(!pst || !pst.ok) && (
                <Button size="sm" variant="primary" icon={pst && pst.p === "work" ? "progress_activity" : "check"} onClick={submit}>
                  {pst && pst.p === "work" ? "正在登录并验证…" : "粘贴验证并保存"}
                </Button>
              )}
            </div>
            {pst && pst.ok && (
              <p className="text-xs text-green-500">
                登录成功{pst.name ? `，已保存到「${pst.name}」` : ""}{pst.exp ? `，token 到期 ${new Date(pst.exp).toLocaleString()}` : ""}
              </p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

DumateQrModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  connectionId: PropTypes.string,
  onSuccess: PropTypes.func,
};
