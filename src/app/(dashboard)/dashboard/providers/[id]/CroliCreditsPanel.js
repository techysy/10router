"use client";

import { useEffect, useState } from "react";
import { Button, ConfirmModal, Modal, Toggle } from "@/shared/components";

export default function CroliCreditsPanel({ connections = [], initialAutoCheckin = false }) {
  const [open, setOpen] = useState(false);
  const [autoCheckin, setAutoCheckin] = useState(initialAutoCheckin === true);
  const [autoConfirm, setAutoConfirm] = useState(false);
  const [autoBusy, setAutoBusy] = useState(false);
  const [loading, setLoading] = useState({});
  const [results, setResults] = useState({});
  const [errors, setErrors] = useState({});
  const [notice, setNotice] = useState("");
  const [copyState, setCopyState] = useState("");

  useEffect(() => setAutoCheckin(initialAutoCheckin === true), [initialAutoCheckin]);

  async function readTasks(connection) {
    setLoading((prev) => ({ ...prev, [connection.id]: true }));
    setErrors((prev) => ({ ...prev, [connection.id]: "" }));
    try {
      const query = new URLSearchParams({ connectionId: connection.id });
      const response = await fetch(`/api/croli/tasks?${query}`, { cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `Croli returned ${response.status}`);
      setResults((prev) => ({ ...prev, [connection.id]: result }));
    } catch (error) {
      setErrors((prev) => ({ ...prev, [connection.id]: error.message || "Croli task read failed" }));
    } finally { setLoading((prev) => ({ ...prev, [connection.id]: false })); }
  }

  function openDetails() {
    setOpen(true);
    for (const connection of connections) void readTasks(connection);
  }

  async function checkIn(connection) {
    setLoading((prev) => ({ ...prev, [connection.id]: true }));
    setErrors((prev) => ({ ...prev, [connection.id]: "" }));
    setNotice("");
    try {
      const response = await fetch("/api/croli/checkin", { method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connectionId: connection.id }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Croli returned ${response.status}`);
      const result = Array.isArray(data.results) ? data.results.find((item) => item.connectionId === connection.id) : null;
      if (result) setResults((prev) => ({ ...prev, [connection.id]: result }));
      const amount = Number(result?.claimedAmount) || 0;
      setNotice(amount > 0 ? `Ledger confirmed ${amount.toLocaleString()} new credits for ${connection.email || "this account"}.`
        : `Check complete for ${connection.email || "this account"}; no new credits were confirmed.`);
    } catch (error) {
      setErrors((prev) => ({ ...prev, [connection.id]: error.message || "Croli check-in failed" }));
    } finally { setLoading((prev) => ({ ...prev, [connection.id]: false })); }
  }

  function toggleAuto(enabled) {
    // Enable is gated behind a styled confirm (not native confirm() — the
    // Electron shell renders that as a raw OS dialog); disabling is direct.
    if (enabled) { setAutoConfirm(true); return; }
    void setAuto(false);
  }

  async function setAuto(enabled) {
    setAutoBusy(true);
    try {
      const response = await fetch("/api/croli/auto-checkin", { method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `Croli returned ${response.status}`);
      setAutoCheckin(result.enabled === true);
    } catch (error) { setErrors((prev) => ({ ...prev, _settings: error.message || "Could not update auto check-in" })); }
    finally { setAutoBusy(false); }
  }

  async function invite(connection) {
    setLoading((prev) => ({ ...prev, [`invite:${connection.id}`]: true }));
    setErrors((prev) => ({ ...prev, [connection.id]: "" }));
    try {
      const response = await fetch("/api/croli/invite-code", { method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connectionId: connection.id }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `Croli returned ${response.status}`);
      setResults((prev) => ({ ...prev, [connection.id]: { ...prev[connection.id], invite: result.invite } }));
      setNotice(`Invite link ready for ${connection.email || "this account"}. The existing code was preserved.`);
    } catch (error) { setErrors((prev) => ({ ...prev, [connection.id]: error.message || "Could not read invite code" })); }
    finally { setLoading((prev) => ({ ...prev, [`invite:${connection.id}`]: false })); }
  }

  async function copyInvite(connection, invite) {
    try {
      await navigator.clipboard.writeText(invite.link);
      setCopyState(connection.id);
      setNotice(`Invite link copied for ${connection.email || "this account"}.`);
    } catch { setErrors((prev) => ({ ...prev, [connection.id]: "Clipboard unavailable; select and copy the link below." })); }
  }

  const when = (value) => value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Not checked yet";
  const taskStatus = (task) => task.note || (task.status === "claimable" ? "Croli marks reward claimable" : task.status === "done" ? "Claimed" : "Not completed");

  return (
    <>
      <div className="flex flex-wrap items-center gap-2" data-croli-actions="true">
        <Button size="sm" icon="redeem" variant="secondary" onClick={openDetails}>Credits and tasks</Button>
      </div>
      <Modal isOpen={open} onClose={() => setOpen(false)} title="Croli credits and tasks" size="xl">
        <div className="flex flex-col gap-4" style={{ maxHeight: "62dvh", overflowY: "auto" }} data-croli-details="true">
          <p className="text-xs text-text-muted">Status comes from Croli. Opening or refreshing this view never claims a reward.</p>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
            <Toggle checked={autoCheckin} onChange={toggleAuto} disabled={autoBusy} label="Automatic daily check-in"
              description="Claims check-in and Croli-marked milestones only. No generated conversations or imports." />
            <Button size="sm" variant="secondary" onClick={() => connections.forEach((connection) => void readTasks(connection))}>Refresh status</Button>
          </div>
          {notice && <p role="status" className="text-xs text-text-muted">{notice}</p>}
          {errors._settings && <p role="alert" className="text-xs text-red-500">{errors._settings}</p>}
          {connections.length === 0 && <p className="text-sm text-text-muted">No Croli connections are configured.</p>}
          {connections.map((connection) => {
            const row = results[connection.id];
            const inviteLoading = loading[`invite:${connection.id}`];
            return (
              <section key={connection.id} className="border-b border-border pb-4" data-croli-connection={connection.id}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold">{connection.email || connection.displayName || connection.name || "Croli account"}</h3>
                    <p className="text-xs text-text-muted">Wallet balance: {typeof row?.balance === "number" ? row.balance.toLocaleString() : "Not available"} credits</p>
                  </div>
                  <Button size="sm" icon="calendar_today" variant="secondary" disabled={loading[connection.id] || connection.isActive === false} onClick={() => checkIn(connection)}>
                    {loading[connection.id] ? "Checking…" : "Check in / claim ready rewards"}
                  </Button>
                </div>
                <p className="mt-1 text-[11px] text-text-muted">Last checked: {when(row?.at)}</p>
                {errors[connection.id] && <p role="alert" className="mt-2 text-xs text-red-500">{errors[connection.id]}</p>}
                {loading[connection.id] && !row && <p className="mt-2 text-xs text-text-muted">Loading Croli status…</p>}
                <div className="mt-2 flex flex-col gap-1">
                  {(row?.items || []).map((task) => (
                    <div key={`${task.task}-${task.taskId || ""}`} className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs">
                      <span className="font-medium">{task.label}</span>
                      <span className={task.status === "failed" ? "text-red-500" : task.status === "claimable" ? "text-green-600" : "text-text-muted"}>{taskStatus(task)}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-3 border-t border-border pt-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-medium">Invite link</span>
                    {row?.invite?.link
                      ? <Button size="sm" variant="secondary" onClick={() => copyInvite(connection, row.invite)}>{copyState === connection.id ? "Copied" : "Copy invite link"}</Button>
                      : <Button size="sm" variant="secondary" disabled={inviteLoading || connection.isActive === false} onClick={() => invite(connection)}>{inviteLoading ? "Loading…" : "Get this account's invite link"}</Button>}
                  </div>
                  {row?.invite?.link && <input readOnly aria-label={`Invite link for ${connection.email || connection.name || "Croli account"}`} value={row.invite.link}
                    onFocus={(event) => event.target.select()} className="mt-2 w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-xs" />}
                  <p className="mt-1 text-[11px] text-text-muted">This reads the signed-in account&apos;s own code with rotation disabled; it does not redeem or bind another account.</p>
                </div>
              </section>
            );
          })}
        </div>
      </Modal>
      <ConfirmModal
        isOpen={autoConfirm}
        onClose={() => setAutoConfirm(false)}
        onConfirm={async () => { setAutoConfirm(false); await setAuto(true); }}
        variant="primary"
        title="Enable automatic Croli check-in?"
        message="Automatic Croli check-in can claim daily check-in and milestones Croli marks claimable. It will not create chats, import sessions, or report installation activity."
      />
    </>
  );
}
