import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const DEFAULT_MITM_ROUTER_BASE = "http://localhost:20128";
const DEFAULT_HEADROOM_URL = process.env.HEADROOM_URL || "http://localhost:8787";

const DEFAULT_SETTINGS = {
  cloudEnabled: false,
  tunnelEnabled: false,
  tunnelUrl: "",
  tunnelProvider: "cloudflare",
  tailscaleEnabled: false,
  tailscaleUrl: "",
  stickyRoundRobinLimit: 3,
  providerStrategies: {},
  quotaVisibility: {},
  topologyVisibility: {},
  comboStrategy: "fallback",
  comboStickyRoundRobinLimit: 1,
  comboStrategies: {},
  // Issue #10: global default for the per-combo "retry on empty" gate — when a
  // model answers 2xx with an empty content-filtered stream, fall through to the
  // next combo model. Off by default; per-combo comboStrategies[name].retryOnEmpty wins.
  comboRetryOnEmpty: false,
  // How many models ONE request may burn on empty answers (each replay re-bills
  // the full input context). Per-combo comboStrategies[name].retryOnEmptyLimit wins.
  comboRetryOnEmptyLimit: 2,
  capacityAdapter: {
    vision: { enabled: true, roundRobin: false, models: [] },
    pdf: { enabled: false, roundRobin: false, models: [] },
    audioInput: { enabled: true, roundRobin: false, models: [] },
    videoInput: { enabled: false, roundRobin: false, models: [] },
  },
  requireLogin: true,
  // Operator opted out of the dashboard-wide "log-in check is off" banner.
  // Only meaningful while requireLogin is false; PATCH requireLogin=true clears it.
  hideLoginOffBanner: false,
  // Settings → Security: poll the npm registry for new releases on our own.
  // Off = only explicit checks (see src/lib/updateCheck.js).
  autoUpdateCheck: true,
  requireApiKey: true,
  // Master switch for the per-key daily token caps (apiKeys.dailyTokenLimit).
  // Off = enforcement stops but every key keeps its configured value, so
  // turning it back on restores all caps as-is.
  dailyTokenLimitEnabled: true,
  // Server-side auto-compaction of oversized conversations (clients that do
  // not compact locally would otherwise hard-fail on "prompt is too long").
  // ON by default: the alternative is a request error. Ratio = share of the
  // effective context window at which older turns get summarized away.
  autoCompactEnabled: true,
  autoCompactRatio: 0.95,
  autoCompactKeepMessages: 8,
  apiKeyRotation: false, // experimental: HMAC secret rotation (invalidates all issued keys)
  tunnelDashboardAccess: true,
  authMode: "password",
  ssoType: "oidc",
  oidcIssuerUrl: "",
  oidcClientId: "",
  oidcClientSecret: "",
  oidcScopes: "openid profile email",
  oidcLoginLabel: "Sign in with OIDC",
  samlEntryPoint: "",
  samlIssuer: "urn:10router:sp",
  samlCert: "",
  samlLoginLabel: "Sign in with SAML SSO",
  samlAttributeEmail: "email",
  samlAttributeName: "name",
  enableObservability: false,
  observabilityMaxRecords: 1000,
  observabilityBatchSize: 20,
  observabilityFlushIntervalMs: 5000,
  observabilityMaxJsonSize: 5,
  outboundProxyEnabled: false,
  outboundProxyUrl: "",
  outboundNoProxy: "",
  mitmRouterBaseUrl: DEFAULT_MITM_ROUTER_BASE,
  dnsToolEnabled: {},
  rtkEnabled: true,
  headroomEnabled: false,
  headroomUrl: DEFAULT_HEADROOM_URL,
  headroomCompressUserMessages: false,
  cavemanEnabled: false,
  cavemanLevel: "full",
  ponytailEnabled: false,
  ponytailLevel: "full",
  pxpipeEnabled: false,
  pxpipeAutoInstall: true,
  pxpipeMinChars: 25000,
  pxpipeTimeoutMs: 15000,
  // Experimental: auto daily check-in for CodeBuddy CN accounts.
  codeBuddyCheckin: false,
  // Experimental: intl daily active-session probe (campaign credits).
  codeBuddyIntlSession: false,
  // Daily-done memo for both passes: { [connectionId]: "YYYY-MM-DD" } (local).
  // Persisted so a restart doesn't re-verify already-done accounts; entries
  // are pruned to today on every write.
  codeBuddyDailyDone: {},
  // Auto daily credit claim for Qoder & Qoder CN accounts.
  qoderCheckin: false,
  // Daily-done memo for Qoder: { [connectionId]: "YYYY-MM-DD" }
  qoderDailyDone: {},
  // Provider-wide channel blocks: { [provider]: { until, lastAt, strikes } }.
  // Set when an upstream answers with a channel-scope error (e.g. CodeBuddy
  // 11128 "unapproved channel"): the failure belongs to the channel, so every
  // account of that provider is paused together instead of being walked one by
  // one (that burst is itself the signal the upstream policy reacts to).
  channelBlocks: {},
};

async function readRaw() {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM settings WHERE id = 1`);
  return row ? parseJson(row.data, {}) : {};
}

// Merge raw settings with defaults; backward-compat for missing keys
export function mergeWithDefaults(raw) {
  const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  for (const [key, defVal] of Object.entries(DEFAULT_SETTINGS)) {
    if (merged[key] === undefined) {
      if (
        key === "outboundProxyEnabled" &&
        typeof merged.outboundProxyUrl === "string" &&
        merged.outboundProxyUrl.trim()
      ) {
        merged[key] = true;
      } else {
        merged[key] = defVal;
      }
    }
  }
  return merged;
}

export async function getSettings() {
  const raw = await readRaw();
  return mergeWithDefaults(raw);
}

// Atomic read-merge-write inside transaction (prevents losing concurrent updates)
export async function updateSettings(updates) {
  const db = await getAdapter();
  let next;
  db.transaction(function () {
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    const current = row ? parseJson(row.data, {}) : {};
    next = { ...current, ...updates };
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [stringifyJson(next)],
    );
  });
  return mergeWithDefaults(next);
}

// Atomic read-modify-write inside a transaction: `mutator` receives the current
// raw settings and returns the patch to apply (or null/undefined for no-op).
// Needed when the patch depends on existing values (e.g. one key of an object
// map) — reading via getSettings() first and then passing the whole map to
// updateSettings() would overwrite concurrent writes made in between.
async function mutateSettings(mutator) {
  const db = await getAdapter();
  let next = null;
  let current = null;
  db.transaction(function () {
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    current = row ? parseJson(row.data, {}) : {};
    const patch = mutator(current);
    if (!patch) return;
    next = { ...current, ...patch };
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [stringifyJson(next)],
    );
  });
  return mergeWithDefaults(next || current || {});
}

export async function isCloudEnabled() {
  const settings = await getSettings();
  return settings.cloudEnabled === true;
}

/**
 * Read the channel block for one provider (null when absent/expired).
 * A stale entry (window already over) still contributes its `strikes` for
 * escalation bookkeeping, so callers get the raw record and decide.
 */
export async function getChannelBlock(provider) {
  const settings = await getSettings();
  return settings.channelBlocks?.[provider] || null;
}

/**
 * Persist a channel block for a provider. The merge happens inside the
 * transaction (mutateSettings), so two providers tripping their breakers
 * concurrently cannot drop each other's block.
 */
export async function setChannelBlock(provider, block) {
  await mutateSettings((current) => ({
    channelBlocks: { ...(current.channelBlocks || {}), [provider]: block },
  }));
  return block;
}

/** Remove a provider's channel block (called once it has expired/succeeded). */
export async function clearChannelBlock(provider) {
  await mutateSettings((current) => {
    if (!(provider in (current.channelBlocks || {}))) return null;
    const blocks = { ...current.channelBlocks };
    delete blocks[provider];
    return { channelBlocks: blocks };
  });
  return null;
}

export async function getCloudUrl() {
  const settings = await getSettings();
  return (
    settings.cloudUrl ||
    process.env.CLOUD_URL ||
    process.env.NEXT_PUBLIC_CLOUD_URL ||
    ""
  );
}

export async function exportSettings() {
  return await readRaw();
}
