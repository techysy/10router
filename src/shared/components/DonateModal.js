"use client";

import { useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import PropTypes from "prop-types";
import { GITHUB_CONFIG } from "@/shared/constants/config";
import { translate } from "@/i18n/runtime";

// GitHub has no URL that stars a repo in one authenticated click (star is a
// POST with a session CSRF token), so "one-click Star" opens the repo page —
// signed-in users are one more click from the button they already know.
// The login?return_to form skips the sign-in wall for logged-out users.
const STAR_URL = `https://github.com/login?return_to=${encodeURIComponent(GITHUB_CONFIG.repoUrl)}`;

export default function DonateModal({ isOpen, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const modalRef = useRef(null);

  useEffect(() => {
    if (!isOpen || data) return;
    setLoading(true);
    setError("");
    fetch(GITHUB_CONFIG.donateUrl, { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json) => setData(json))
      .catch((err) => setError(err.message || "Failed to load"))
      .finally(() => setLoading(false));
  }, [isOpen, data]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (modalRef.current && !modalRef.current.contains(e.target)) onClose();
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen, onClose]);

  if (!isOpen || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <div
        ref={modalRef}
        className="relative w-full bg-surface border border-black/10 dark:border-white/10 rounded-xl shadow-2xl animate-in fade-in zoom-in-95 duration-200 max-w-3xl flex flex-col max-h-[85vh]"
      >
        <div className="flex items-center justify-between p-3 border-b border-black/5 dark:border-white/5">
          <h2 className="text-lg font-semibold text-text-main flex items-center gap-2">
            <span className="material-symbols-outlined text-pink-500">volunteer_activism</span>
            {translate(data?.title || "Support 10Router")}
          </h2>
          <div className="flex items-center gap-2">
            <a
              href={STAR_URL}
              target="_blank"
              rel="noopener noreferrer"
              title="Star 10Router on GitHub (signs you in first if needed)"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-white bg-brand-500 hover:bg-brand-600 transition-colors"
            >
              <span className="material-symbols-outlined text-[16px]">star</span>
              <span>Star</span>
            </a>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-text-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              aria-label="Close"
            >
              <span className="material-symbols-outlined text-[20px]">close</span>
            </button>
          </div>
        </div>

        <div className="p-6 overflow-y-auto flex-1">
          {loading && (
            <div className="flex items-center justify-center py-10 text-text-muted">
              <span className="material-symbols-outlined animate-spin mr-2">progress_activity</span>
              Loading...
            </div>
          )}
          {error && (
            <div className="text-red-500 py-4">Failed to load donate info: {error}</div>
          )}
          {!loading && !error && data && (
            <>
              {data.message && (
                <p className="text-text-muted text-sm mb-2 text-center">{translate(data.message)}</p>
              )}
              {data.note && (
                // Backer credit hint: the note rides on donate.json (read live
                // from main, same as the rest of the payload) so the wording can
                // be tuned without a release.
                <p className="flex items-center justify-center gap-1.5 text-xs text-warning mb-6 text-center">
                  <span className="material-symbols-outlined text-[14px] shrink-0">edit_note</span>
                  <span>{translate(data.note)}</span>
                </p>
              )}
              {!data.note && data.message && <div className="mb-4" />}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {data.channels?.map((ch) => (
                  <DonateChannelCard key={ch.id} channel={ch} />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

function DonateChannelCard({ channel }) {
  const { label, description, icon, color, url, qr } = channel;
  // A QR that fails to load must say so: an <img> hidden on error leaves an
  // empty card with no hint that a scan code was expected. The fallback also
  // links the image itself so the code is still reachable.
  const [qrFailed, setQrFailed] = useState(false);
  const content = (
    <>
      <div
        className="w-12 h-12 rounded-full flex items-center justify-center mb-3"
        style={{ backgroundColor: `${color}20`, color }}
      >
        <span className="material-symbols-outlined text-[26px]">{icon}</span>
      </div>
      <div className="font-semibold text-text-main mb-1">{translate(label)}</div>
      {description && (
        <div className="text-xs text-text-muted mb-3 text-center">{translate(description)}</div>
      )}
      {qr && !qrFailed && (
        <img
          src={qr}
          alt={`${label} QR`}
          className="w-full max-w-[180px] aspect-square object-contain rounded-lg bg-white p-1"
          loading="lazy"
          decoding="async"
          onError={() => setQrFailed(true)}
        />
      )}
      {qr && qrFailed && (
        // Only http(s) is clickable — a WeChat Pay QR carries wxp://…, which a
        // browser cannot open, so that one stays a plain, honest notice.
        /^https?:\/\//.test(qr) ? (
          <a
            href={qr}
            target="_blank"
            rel="noopener noreferrer"
            className="flex w-full max-w-[180px] aspect-square items-center justify-center rounded-lg border border-dashed border-black/15 dark:border-white/15 px-2 text-center text-xs text-text-muted hover:text-text-main"
          >
            {translate("QR code unavailable — open image")}
          </a>
        ) : (
          <div className="flex w-full max-w-[180px] aspect-square items-center justify-center rounded-lg border border-dashed border-black/15 dark:border-white/15 px-2 text-center text-xs text-text-muted">
            {translate("QR code unavailable right now")}
          </div>
        )
      )}
    </>
  );

  return (
    <div className="flex flex-col items-center p-4 rounded-xl border border-black/10 dark:border-white/10 bg-surface/50 hover:border-pink-500/40 transition-colors">
      {content}
      {/* The QR IS the entry point for scan-to-pay cards — a second "Open"
          button under it double-offers and makes card bottoms ragged. Only
          link-only channels (Sponsors, AiFaDian) get the button, so all four
          cards end on exactly one action. QR-failed keeps the in-card notice
          as the single fallback surface. */}
      {url && !qr && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-5 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-medium text-white hover:opacity-90 transition-opacity"
          style={{ backgroundColor: color }}
        >
          {translate("Open")}
          <span className="material-symbols-outlined text-[16px]">open_in_new</span>
        </a>
      )}
    </div>
  );
}

DonateModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
};
