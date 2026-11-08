// Named "model combo profiles" for the CLI-tools cards (issue #17): a saved
// snapshot of the Claude card's form — the env block that /api/cli-tools/
// claude-settings writes into ~/.claude/settings.json, plus the Exa toggle and
// the context-window override. Stored under the `cliToolProfiles` settings key
// (server-side, so NAS / Tailscale / tunnel clients of one instance share the
// same list — the localStorage endpoint presets do not).
//
// Pure logic, no Node imports: the API route owns settings IO, and
// ClaudeToolCard reuses matchProfileByEnv client-side to mark the profile the
// on-disk settings currently equal.

export const MAX_PROFILES = 20;
export const MAX_PROFILE_NAME = 40;

// Exactly what the Claude card's Apply can produce (mirrors RESET_ENV_KEYS in
// /api/cli-tools/claude-settings minus API_TIMEOUT_MS, which the form never
// writes). Anything else in a submitted env is dropped, so a tampered request
// cannot smuggle arbitrary keys into settings.json.
const ALLOWED_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
];

const MAX_ENV_VALUE = 512;

/** Validate + normalize one profile submission. { ok, profile } | { ok, error }. */
export function sanitizeProfileInput(body) {
  const name = String(body?.name ?? "").trim();
  if (!name) return { ok: false, error: "Profile name is required" };
  if (name.length > MAX_PROFILE_NAME) {
    return { ok: false, error: `Profile name is limited to ${MAX_PROFILE_NAME} characters` };
  }

  const rawEnv = body?.env;
  if (!rawEnv || typeof rawEnv !== "object" || Array.isArray(rawEnv)) {
    return { ok: false, error: "Invalid env object" };
  }
  const env = {};
  for (const key of ALLOWED_ENV_KEYS) {
    const value = rawEnv[key];
    if (value === undefined || value === null) continue;
    const str = String(value).trim();
    if (!str) continue;
    if (str.length > MAX_ENV_VALUE) {
      return { ok: false, error: `Env value for ${key} is too long` };
    }
    env[key] = str;
  }
  if (!env.ANTHROPIC_BASE_URL) {
    return { ok: false, error: "A profile must target a base URL" };
  }
  // Same normalization the settings writer applies, so switching a profile
  // later cannot produce a /v1-less base URL — and trailing slashes stripped
  // first, or "http://host:20128/" would grow a "//v1".
  if (!env.ANTHROPIC_BASE_URL.endsWith("/v1")) {
    env.ANTHROPIC_BASE_URL = `${env.ANTHROPIC_BASE_URL.replace(/\/+$/, "")}/v1`;
  }

  const maxContextTokens = String(body?.maxContextTokens ?? "").trim();
  if (maxContextTokens && !/^\d{1,7}$/.test(maxContextTokens)) {
    return { ok: false, error: "maxContextTokens must be a number" };
  }

  return {
    ok: true,
    profile: {
      name,
      env,
      exaMcpEnabled: body?.exaMcpEnabled === true,
      maxContextTokens,
    },
  };
}

/**
 * Insert or replace in the profile list. Pass `id` to update an existing
 * entry (createdAt kept); omit it to create one. `newId`/`now` are injectable
 * for tests. Returns { profiles, profile } or { error } without mutating.
 */
export function upsertProfile(profiles, profile, { id, newId, now } = {}) {
  const list = Array.isArray(profiles) ? profiles : [];
  const stamp = now ? now() : Date.now();

  if (id) {
    const index = list.findIndex((p) => p?.id === id);
    if (index === -1) return { error: "Profile not found" };
    const next = list.slice();
    next[index] = { ...list[index], ...profile, id, createdAt: list[index].createdAt, updatedAt: stamp };
    return { profiles: next, profile: next[index] };
  }

  if (list.length >= MAX_PROFILES) {
    return { error: `At most ${MAX_PROFILES} profiles can be saved` };
  }
  const created = { ...profile, id: newId ? newId() : `prof-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, createdAt: stamp, updatedAt: stamp };
  return { profiles: [...list, created], profile: created };
}

/** Drop one profile by id. Returns { profiles, removed } — no-op when absent. */
export function removeProfile(profiles, id) {
  const list = Array.isArray(profiles) ? profiles : [];
  const next = list.filter((p) => p?.id !== id);
  return { profiles: next, removed: next.length !== list.length };
}

// What "the current settings equal this profile" means: endpoint, key and the
// four model slots — the fields a switch would rewrite. Profiles saved before
// Fable joined the whitelist (2026-11, #102) carry no FABLE key, so they stop
// auto-matching a settings file that has one until re-saved once.
const MATCH_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
];

export function matchProfileByEnv(profile, env = {}) {
  if (!profile?.env) return false;
  return MATCH_ENV_KEYS.every((key) => (profile.env[key] || "") === (env[key] || ""));
}
