import pkg from "../../../package.json" with { type: "json" };

// App configuration
export const APP_CONFIG = {
  name: "10Router",
  description: "AI Infrastructure Management",
  version: pkg.version,
};

// GitHub configuration
export const GITHUB_CONFIG = {
  repoUrl: "https://github.com/techysy/10router",
  donateUrl: "https://raw.githubusercontent.com/techysy/10router/refs/heads/main/donate.json",
  // Live announcement feed (repo-root announcements.json), same trust shape as
  // donateUrl: read straight from `main` by every installed client, so posting
  // an entry is a push, not a release. Gitee raw as fallback for regions where
  // raw.githubusercontent.com is unreachable.
  announcementsUrl: "https://raw.githubusercontent.com/techysy/10router/refs/heads/main/announcements.json",
  announcementsUrlFallback: "https://gitee.com/techysy/10router/raw/main/announcements.json",
  // Per-locale changelog markdown (public/i18n/changelog/<locale>.md) fetched
  // live from the repo, with Gitee as a fallback mirror. See ChangelogModal.
  // NOTE: these are read from `main` by every installed client, so a release
  // section written here reaches users before the release exists. Author it in
  // the "Release: vX.Y.Z — 发版面校准" commit only; ChangelogModal additionally
  // caps what it renders at the newest published version (utils/changelogCap.js).
  changelogUrlBase: "https://raw.githubusercontent.com/techysy/10router/refs/heads/main/public/i18n/changelog/",
  changelogUrlFallbackBase: "https://gitee.com/techysy/10router/raw/main/public/i18n/changelog/",
};

// Updater configuration
export const UPDATER_CONFIG = {
  // Scoped, so the name can't be taken: `10router` on npm belongs to an
  // unrelated 9router fork (some-du6e) that predates this project's rename, and
  // `10router-cli` was the stopgap before the @techysy org existed. Pointing any
  // of these at the bare name would compare our version against a stranger's and
  // hand users their package to install.
  npmPackageName: "@techysy/10router",
  installCmd: "npm i -g @techysy/10router",
  installCmdLatest: "npm i -g @techysy/10router@latest --prefer-online",
  shutdownCountdownSec: 3,
  exitDelayMs: 500,
  statusPort: 20129,
  statusPollIntervalMs: 1000,
  statusLogTailLines: 8,
  installRetries: 3,
  installRetryDelayMs: 5000,
  lingerAfterDoneMs: 30000,
  waitForExitMinMs: 5000,
  waitForExitMaxMs: 20000,
  waitForExitCheckMs: 500,
  appPort: 20128,
};

// Theme configuration
export const THEME_CONFIG = {
  storageKey: "theme",
  defaultTheme: "system", // "light" | "dark" | "brutal" | "system"
};

// Subscription
export const SUBSCRIPTION_CONFIG = {
  price: 1.0,
  currency: "USD",
  interval: "month",
  planName: "Pro Plan",
};

// API endpoints
export const API_ENDPOINTS = {
  users: "/api/users",
  providers: "/api/providers",
  payments: "/api/payments",
  auth: "/api/auth",
};

export const CONSOLE_LOG_CONFIG = {
  maxLines: 200,
  pollIntervalMs: 1000,
};

// Client-side store TTL: how long fetched data stays fresh before re-fetching
export const CLIENT_STORE_TTL_MS = 60000;

// Quota auto-ping: keep 5h windows warm by sending a tiny request right after reset.
export const QUOTA_AUTOPING_CONFIG = {
  tickIntervalMs: 60000,                // scheduler tick
  pingLeadMs: 5000,                     // fire once reset passes (within tolerance)
  refreshAheadMs: 300000,               // refetch usage when within 5min of reset
  failureCooldownMs: 900000,            // avoid failed ping spam while upstream/auth is unhealthy
  providers: {
    claude: {
      settingsKey: "claudeAutoPing",    // preserve existing settings contract
      quotaKey: "session (5h)",         // quota key returned by usage handler
      pingModel: "claude-haiku-4-5-20251001",
      pingText: "hi",
      pingMaxTokens: 1,
    },
    codex: {
      settingsKey: "codexAutoPing",
      quotaKey: "session",
      pingWhenResetAtSlides: true,
      resetAtDriftMs: 30000,
      minPingIntervalMs: 600000,
      skipWhenBlockingQuotaExhausted: true,
      // gpt-5.6-terra is the lightweight model for auto-pinging Codex 5h reset window.
      pingModel: "gpt-5.6-terra",
      pingText: "hi",
      pingInstructions: "Reply with OK.",
      pingReasoningEffort: "none",
    },
  },
};

// Re-export from providers.js for backward compatibility
export {
  FREE_PROVIDERS,
  OAUTH_PROVIDERS,
  APIKEY_PROVIDERS,
  WEB_COOKIE_PROVIDERS,
  AI_PROVIDERS,
  AUTH_METHODS,
} from "./providers.js";

// Re-export from models.js for backward compatibility
export {
  PROVIDER_MODELS,
  AI_MODELS,
} from "./models.js";
