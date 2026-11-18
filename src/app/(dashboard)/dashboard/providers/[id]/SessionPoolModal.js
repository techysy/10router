"use client";

import { useState, useEffect, useCallback } from "react";
import PropTypes from "prop-types";
import { Modal, Button, Tooltip } from "@/shared/components";
import { translate } from "@/i18n/runtime";

/**
 * 会话池管理弹窗（#150，对齐 CreditDaddy m-pool）。
 *
 * 每站点 9 个登录槽：槽 1 = 主账号分区（cookie-site-<id>），槽 2-9 = 次要账号
 * （cookie-site-<id>-sN），各槽是独立持久登录分区、互不串 Cookie。
 * 面板只做「打开 / 清除 / 重命名」；登录在壳内站点窗完成，收割自动落该槽。
 *
 * 数据源：GET /api/cookie-sites（本机 CLI token / 会话可达）。
 */
export default function SessionPoolModal({ isOpen, onClose, providerId, siteId }) {
  const [sites, setSites] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busySlot, setBusySlot] = useState(null);
  const [renaming, setRenaming] = useState(null); // { slot, value }
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/cookie-sites", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "加载失败");
      setSites(data.sites || []);
    } catch (e) {
      setError(e.message || "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      load();
    }
  }, [isOpen, load]);

  const site = sites.find((s) => s.id === siteId) || null;
  const accounts = site?.accounts || [];
  const bySlot = (n) => accounts.find((a) => a.slot === n) || null;

  const openSlot = (n) => {
    if (window.sessionPool?.login) window.sessionPool.login(siteId, n);
  };

  const clearSlot = async (n) => {
    setBusySlot(n);
    setError("");
    try {
      const res = await fetch(`/api/cookie-sites/${encodeURIComponent(siteId)}?slot=${n}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "清除失败");
      await load();
    } catch (e) {
      setError(e.message || "清除失败");
    } finally {
      setBusySlot(null);
    }
  };

  const renameSlot = async (n) => {
    const label = (renaming?.value || "").trim();
    if (!label) { setRenaming(null); return; }
    setBusySlot(n);
    setError("");
    try {
      const row = bySlot(n);
      if (row) {
        const res = await fetch(`/api/providers/${row.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: label }),
        });
        if (!res.ok) throw new Error("重命名失败");
      }
      setRenaming(null);
      await load();
    } catch (e) {
      setError(e.message || "重命名失败");
    } finally {
      setBusySlot(null);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={translate("会话池") + (site ? ` · ${site.name}` : "")} size="lg">
      <div className="flex flex-col gap-3">
        <p className="text-xs text-text-muted">{translate("每站点 9 个登录槽：各槽是独立的持久登录分区，可各自登录不同账号；换号 = 选另一槽开窗。")}</p>
        {loading && <div className="py-6 text-center text-xs text-text-muted">{translate("加载中…")}</div>}
        {error && <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-500">{error}</div>}
        {!loading && sites.length === 0 && (
          <div className="py-6 text-center text-xs text-text-muted">{translate("暂无会话池站点（当前支持 WPS 灵犀 / DuMate）。")}</div>
        )}
        {site && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {Array.from({ length: site.slots }, (_, i) => i + 1).map((n) => {
              const row = bySlot(n);
              const isRenaming = renaming?.slot === n;
              return (
                <div key={n} className="flex items-center gap-2 rounded-lg border border-border-subtle px-3 py-2">
                  <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[11px] font-semibold text-text-muted">
                    {n}
                  </span>
                  <div className="min-w-0 flex-1">
                    {isRenaming ? (
                      <input
                        autoFocus
                        defaultValue={row?.name || ""}
                        value={renaming.value}
                        onChange={(e) => setRenaming({ slot: n, value: e.target.value })}
                        onKeyDown={(e) => { if (e.key === "Enter") renameSlot(n); if (e.key === "Escape") setRenaming(null); }}
                        className="w-full rounded border border-border bg-surface px-2 py-1 text-xs focus:outline-none focus:border-primary"
                      />
                    ) : (
                      <div className="truncate text-xs text-text">
                        {row ? row.name : <span className="text-text-muted">{translate("空槽")}</span>}
                      </div>
                    )}
                    {row && <div className="text-[10px] text-text-muted">{row.testStatus || ""}</div>}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Tooltip text={translate("登录（槽 {n}）· 独立持久会话分区").replace("{n}", String(n))}>
                      <button
                        onClick={() => openSlot(n)}
                        disabled={busySlot === n}
                        className="rounded p-1.5 text-text-muted hover:bg-black/5 hover:text-primary dark:hover:bg-white/5"
                      >
                        <span className="material-symbols-outlined text-[16px]">login</span>
                      </button>
                    </Tooltip>
                    {row && (
                      <>
                        <Tooltip text={translate("重命名")}>
                          <button
                            onClick={() => { setRenaming({ slot: n, value: row.name || "" }); setError(""); }}
                            disabled={busySlot === n}
                            className="rounded p-1.5 text-text-muted hover:bg-black/5 hover:text-primary dark:hover:bg-white/5"
                          >
                            <span className="material-symbols-outlined text-[16px]">edit</span>
                          </button>
                        </Tooltip>
                        <Tooltip text={translate("清除会话 {n}").replace("{n}", String(n))}>
                          <button
                            onClick={() => clearSlot(n)}
                            disabled={busySlot === n}
                            className="rounded p-1.5 text-red-500 hover:bg-red-500/10"
                          >
                            <span className="material-symbols-outlined text-[16px]">delete</span>
                          </button>
                        </Tooltip>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>{translate("关闭")}</Button>
        </div>
      </div>
    </Modal>
  );
}

SessionPoolModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  providerId: PropTypes.string,
  siteId: PropTypes.string,
};
