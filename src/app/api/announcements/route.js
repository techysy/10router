import { GITHUB_CONFIG } from "@/shared/constants/config.js";
import bundledAnnouncements from "../../../../announcements.json" with { type: "json" };

// 10 minutes cache TTL for remote feed fetch
const CACHE_TTL_MS = 10 * 60 * 1000;

// Module-level cache surviving hot-reload within the same Node process
const memoryCache = (global.__announcementsCache ??= {
  feed: bundledAnnouncements,
  fetchedAt: 0,
});

let fetchInFlight = false;

function normalizeFeed(data) {
  if (!data || typeof data !== "object") return null;
  const items = Array.isArray(data.items) ? data.items : [];
  return {
    ...data,
    items,
  };
}

async function fetchRemoteFeed() {
  if (fetchInFlight) return;
  fetchInFlight = true;
  try {
    const candidateUrls = [
      GITHUB_CONFIG.announcementsUrl,
      // jsDelivr CDN mirrors GitHub raw, fast and accessible in Mainland China
      "https://fastly.jsdelivr.net/gh/techysy/10router@main/announcements.json",
      "https://cdn.jsdelivr.net/gh/techysy/10router@main/announcements.json",
      GITHUB_CONFIG.announcementsUrlFallback,
    ].filter(Boolean);

    for (const url of candidateUrls) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);
        const res = await fetch(url, {
          cache: "no-store",
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!res.ok) continue;
        const json = await res.json();
        const norm = normalizeFeed(json);
        if (norm && norm.items.length > 0) {
          memoryCache.feed = norm;
          memoryCache.fetchedAt = Date.now();
          return;
        }
      } catch {
        // try next candidate mirror
      }
    }
  } finally {
    fetchInFlight = false;
  }
}

export async function GET(request) {
  const forceCheck = request ? new URL(request.url).searchParams.get("check") === "1" : false;
  const isStale = Date.now() - memoryCache.fetchedAt > CACHE_TTL_MS;

  if (forceCheck) {
    await fetchRemoteFeed();
  } else if (isStale) {
    // Non-blocking background refresh: return current feed immediately and refresh asynchronously
    fetchRemoteFeed().catch(() => {});
  }

  // Always return 200 with valid feed (fallback to bundled announcements if remote fails)
  return Response.json(memoryCache.feed || bundledAnnouncements, {
    headers: {
      "Cache-Control": "public, max-age=60",
    },
  });
}
