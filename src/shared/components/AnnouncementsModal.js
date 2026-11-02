"use client";

import { useEffect, useMemo, useState } from "react";
import Modal from "@/shared/components/Modal";
import Button from "@/shared/components/Button";
import { GITHUB_CONFIG } from "@/shared/constants/config";
import { translate, getCurrentLocale } from "@/i18n/runtime";
import { cn } from "@/shared/utils/cn";

// Live announcement feed (repo-root announcements.json). Like donate.json it is
// read straight from `main`, so an operator can post an entry (free-model
// promos, breaking changes, "read this before upgrading") without cutting a
// release. Two clients disagreeing is acceptable here — the file IS the source
// of truth — but the fetch still degrades in this order:
//   1. GitHub raw · 2. Gitee raw mirror · 3. last good copy from localStorage.
const CACHE_KEY = "10r.announcements.cache";
const SEEN_KEY = "10r.announcements.seen";
// Anything older than this is stale enough to hide rather than show as news.
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export const ANNOUNCEMENTS_CHANGED_EVENT = "10r-announcements-changed";

function readJson(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch { /* private mode / quota — the feed still works, just uncached */ }
}

function readSeenIds() {
  const ids = readJson(SEEN_KEY, []);
  return Array.isArray(ids) ? ids : [];
}

function markSeen(ids) {
  if (!ids.length) return;
  const merged = Array.from(new Set([...readSeenIds(), ...ids]));
  writeJson(SEEN_KEY, merged);
  try {
    window.dispatchEvent(new Event(ANNOUNCEMENTS_CHANGED_EVENT));
  } catch { /* non-browser */ }
}

function normalizeFeed(raw) {
  const items = Array.isArray(raw?.items) ? raw.items : [];
  return items
    .filter((it) => it && typeof it.id === "string" && typeof it.title === "string")
    .map((it) => ({
      id: it.id,
      title: it.title,
      titleEn: typeof it.titleEn === "string" ? it.titleEn : "",
      body: typeof it.body === "string" ? it.body : "",
      bodyEn: typeof it.bodyEn === "string" ? it.bodyEn : "",
      date: typeof it.date === "string" ? it.date : "",
      level: ["feature", "promo", "info", "warning", "critical"].includes(it.level) ? it.level : "info",
      link: typeof it.link === "string" && /^https?:\/\//.test(it.link) ? it.link : "",
    }))
    .filter((it) => {
      const t = Date.parse(it.date);
      return !t || Date.now() - t <= MAX_AGE_MS;
    })
    // Display order is deterministic regardless of file order: colored levels
    // first (critical > warning > promo), info last; newest date within a group.
    .sort((a, b) => {
      const rank = { critical: 0, warning: 1, promo: 2, feature: 3, info: 4 };
      const da = rank[a.level] ?? 3;
      const db = rank[b.level] ?? 3;
      if (da !== db) return da - db;
      return (b.date || "").localeCompare(a.date || "");
    });
}

function computeUnread() {
  const cached = normalizeFeed(readJson(CACHE_KEY, null));
  const seen = new Set(readSeenIds());
  return cached.filter((it) => !seen.has(it.id)).length;
}

const SYNC_KEY = "10r.announcements.syncedAt";
const SYNC_TTL_MS = 5 * 60 * 1000;
let syncInFlight = false;

const FEED_URLS = [
  "/api/announcements",
  GITHUB_CONFIG.announcementsUrl,
  "https://fastly.jsdelivr.net/gh/techysy/10router@main/announcements.json",
  GITHUB_CONFIG.announcementsUrlFallback,
].filter(Boolean);

// The header badge must work BEFORE the modal is ever opened: unread count
// compares against the local cache, and the cache used to be written only when
// the modal opened — first-time visitors never saw the red dot. Sync the feed
// quietly on mount (TTL-throttled, same-origin API first, silent on failure).
async function syncAnnouncementsCache() {
  if (syncInFlight) return;
  if (Date.now() - Number(readJson(SYNC_KEY, 0)) < SYNC_TTL_MS) return;
  syncInFlight = true;
  try {
    for (const url of FEED_URLS) {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        writeJson(CACHE_KEY, normalizeFeed(await res.json()));
        writeJson(SYNC_KEY, Date.now());
        try {
          window.dispatchEvent(new Event(ANNOUNCEMENTS_CHANGED_EVENT));
        } catch { /* non-browser */ }
        return;
      } catch { /* try the next mirror; offline → keep the old cache */ }
    }
  } finally {
    syncInFlight = false;
  }
}

/** Unread count for the header badge; listens for in-tab updates. */
export function useUnreadAnnouncements() {
  // Lazy initializer reads localStorage once at mount; after that the count is
  // only ever updated from an event callback (storage / modal-close), never
  // synchronously in the effect body.
  const [count, setCount] = useState(computeUnread);

  useEffect(() => {
    const onChanged = () => setCount(computeUnread());
    window.addEventListener(ANNOUNCEMENTS_CHANGED_EVENT, onChanged);
    window.addEventListener("storage", onChanged);
    syncAnnouncementsCache().catch(() => {});
    return () => {
      window.removeEventListener(ANNOUNCEMENTS_CHANGED_EVENT, onChanged);
      window.removeEventListener("storage", onChanged);
    };
  }, []);

  return count;
}

export default function AnnouncementsModal({ isOpen, onClose }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    // Reset to the loading state the moment the modal opens — this is
    // synchronising state with an open/close external event, not a render
    // cascade (same pattern as DonateModal).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError("");
    setStale(false);

    (async () => {
      for (const url of FEED_URLS) {
        try {
          const res = await fetch(url, { cache: "no-store" });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const feed = normalizeFeed(await res.json());
          if (cancelled) return;
          writeJson(CACHE_KEY, feed);
          writeJson(SYNC_KEY, Date.now());
          setItems(feed);
          return;
        } catch (err) {
          if (url === FEED_URLS[FEED_URLS.length - 1]) {
            // All candidates failed — fall back to whatever we last saw.
            const cached = normalizeFeed(readJson(CACHE_KEY, null));
            if (cancelled) return;
            if (cached.length) {
              setItems(cached);
              setStale(true);
            } else {
              setError(err?.message || "Failed to load");
            }
          }
        }
      }
    })().finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [isOpen]);

  // Opening the modal is the read action: everything currently listed counts
  // as seen once it has been rendered.
  useEffect(() => {
    if (!isOpen || loading || items.length === 0) return;
    markSeen(items.map((it) => it.id));
  }, [isOpen, loading, items]);

  const body = useMemo(() => {
    if (loading && items.length === 0) {
      return (
        <div className="flex items-center justify-center py-10 text-text-muted">
          <span className="material-symbols-outlined animate-spin mr-2">progress_activity</span>
          {translate("Loading...")}
        </div>
      );
    }
    if (error && items.length === 0) {
      return <p className="py-6 text-center text-sm text-text-muted">{translate("Could not load announcements")}: {error}</p>;
    }
    if (items.length === 0) {
      return <p className="py-6 text-center text-sm text-text-muted">{translate("No announcements right now")}</p>;
    }
    return (
      <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
        {stale && (
          <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
            {translate("Showing the last cached copy — the live feed is unreachable right now.")}
          </p>
        )}
        {items.map((it) => (
          <article
            key={it.id}
            className={cn(
              "rounded-lg border p-2.5",
              it.level === "critical"
                ? "border-red-500/30 bg-red-500/5"
                : it.level === "warning"
                  ? "border-amber-500/30 bg-amber-500/5"
                  : it.level === "promo"
                    ? "border-green-500/40 bg-green-500/5"
                    : it.level === "feature"
                      ? "border-blue-500/40 bg-blue-500/5"
                      : "border-black/10 dark:border-white/10 bg-surface/50"
            )}
          >
            <div className="mb-1 flex items-start justify-between gap-2">
              <h3 className="text-[13px] font-semibold leading-5 text-text-main">
                {getCurrentLocale() === "en" && it.titleEn ? it.titleEn : it.title}
              </h3>
              {it.date && <time className="shrink-0 text-[10px] text-text-muted">{it.date}</time>}
            </div>
            {it.body && (
              <p className="whitespace-pre-line text-xs leading-relaxed text-text-muted">
                {getCurrentLocale() === "en" && it.bodyEn ? it.bodyEn : it.body}
              </p>
            )}
            {it.link && (
              <a
                href={it.link}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
              >
                {translate("Learn more")}
                <span className="material-symbols-outlined text-[14px]">open_in_new</span>
              </a>
            )}
          </article>
        ))}
      </div>
    );
  }, [loading, items, error, stale]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={translate("Announcements")}
      size="full"
      footer={
        <Button size="sm" variant="secondary" onClick={onClose}>{translate("Close")}</Button>
      }
    >
      <div className="pr-1">{body}</div>
    </Modal>
  );
}
