// AtomCode OAuth — broker-mediated browser login, no local callback.
//
// The authorization callback terminates on acs.atomgit.com, never on this
// machine, so the flow is poll-based:
//   GET {broker}/auth/login?provider=atomgit -> {login_url, state}
//   user opens login_url
//   GET {broker}/auth/check?state=...        -> {valid: boolean}   (poll)
//   GET {broker}/auth/token?state=...        -> token bundle       (fetch)
//   POST {broker}/oauth/refresh              -> rotated bundle
//
// Refresh rotates the refresh token. The broker may omit refresh_token /
// expires_in / user; merge only non-empty fields so an omission never erases a
// live credential.

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import {
  ATOMCODE_BROKER_CHECK_PATH,
  ATOMCODE_BROKER_LOGIN_PATH,
  ATOMCODE_BROKER_PROVIDER,
  ATOMCODE_BROKER_REFRESH_PATH,
  ATOMCODE_BROKER_TOKEN_PATH,
  ATOMCODE_REQUEST_TIMEOUT_MS,
  atomcodeBrokerBase,
} from "./constants.js";

export class AtomcodeOAuthError extends Error {
  constructor(message, { code = "oauth_error", status = 0 } = {}) {
    super(message);
    this.name = "AtomcodeOAuthError";
    this.code = code;
    this.status = status;
  }
}

const str = (source, key) => {
  const value = source?.[key];
  return typeof value === "string" ? value.trim() : "";
};

const num = (source, key) => {
  const value = Number(source?.[key]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
};

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Collapse an error body into one line without dumping HTML or tokens. */
function summarize(payload) {
  if (!payload || typeof payload !== "object") return "";
  const detail = payload.detail && typeof payload.detail === "object" ? payload.detail : null;
  const text =
    str(payload, "message") ||
    str(detail, "message") ||
    str(payload, "error") ||
    str(payload, "msg");
  if (text) return text.slice(0, 180);
  try {
    return JSON.stringify(payload).slice(0, 180);
  } catch {
    return "";
  }
}

async function request(url, init = {}, proxyOptions = null) {
  try {
    return await proxyAwareFetch(url, {
      ...init,
      signal: init.signal || AbortSignal.timeout(ATOMCODE_REQUEST_TIMEOUT_MS),
    }, proxyOptions);
  } catch (error) {
    throw new AtomcodeOAuthError(
      error?.name === "TimeoutError" || error?.name === "AbortError"
        ? "AtomCode broker request timed out"
        : `AtomCode broker request failed: ${error?.message || error}`,
      { code: "network" }
    );
  }
}

/** Start a login; returns `{ loginUrl, state }` without waiting for the user. */
export async function startAtomcodeLogin() {
  const url = `${atomcodeBrokerBase()}${ATOMCODE_BROKER_LOGIN_PATH}?provider=${encodeURIComponent(ATOMCODE_BROKER_PROVIDER)}`;
  const response = await request(url, { method: "GET", headers: { Accept: "application/json" } });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new AtomcodeOAuthError(
      `AtomCode login start failed (HTTP ${response.status})${summarize(payload) ? `: ${summarize(payload)}` : ""}`,
      { code: "http_error", status: response.status }
    );
  }
  const loginUrl = str(payload, "login_url");
  const state = str(payload, "state");
  if (!loginUrl || !state) {
    throw new AtomcodeOAuthError("AtomCode broker did not return login_url/state", {
      code: "bad_response",
      status: response.status,
    });
  }
  return { loginUrl, state };
}

/**
 * Ask whether the user finished. Network errors and 5xx are "still pending":
 * a blip must not abort a login the user is actively completing.
 */
export async function checkAtomcodeLogin(state) {
  const url = `${atomcodeBrokerBase()}${ATOMCODE_BROKER_CHECK_PATH}?state=${encodeURIComponent(state)}`;
  let response;
  try {
    response = await request(url, { method: "GET", headers: { Accept: "application/json" } });
  } catch {
    // A blip is "not answered yet", not "denied".
    return false;
  }
  if (response.status >= 500 || !response.ok) return false;
  const payload = await readJson(response);
  return payload?.valid === true;
}

/** Parse a broker token envelope (login and refresh share it). */
export function parseAtomcodeTokenBundle(payload) {
  const accessToken = str(payload, "access_token");
  if (!accessToken) {
    throw new AtomcodeOAuthError("AtomCode broker did not return access_token", {
      code: "bad_response",
    });
  }
  const user = payload?.user && typeof payload.user === "object" ? payload.user : {};
  return {
    accessToken,
    refreshToken: str(payload, "refresh_token"),
    tokenType: str(payload, "token_type"),
    expiresIn: num(payload, "expires_in"),
    userId: str(user, "id") || str(payload, "user_id"),
    username: str(user, "username"),
    name: str(user, "name"),
    email: str(user, "email"),
    avatarUrl: str(user, "avatar_url"),
  };
}

/** Merge a refreshed bundle over the previous one (non-empty wins). */
export function mergeAtomcodeTokenBundle(next, previous = {}) {
  const pick = (key) => (next?.[key] ? next[key] : previous?.[key] || "");
  return {
    accessToken: next?.accessToken || previous?.accessToken || "",
    refreshToken: pick("refreshToken"),
    tokenType: pick("tokenType"),
    expiresIn: next?.expiresIn > 0 ? next.expiresIn : previous?.expiresIn || 0,
    userId: pick("userId"),
    username: pick("username"),
    name: pick("name"),
    email: pick("email"),
    avatarUrl: pick("avatarUrl"),
  };
}

/** Fetch the token bundle once `checkAtomcodeLogin` reports ready. */
export async function fetchAtomcodeToken(state) {
  const url = `${atomcodeBrokerBase()}${ATOMCODE_BROKER_TOKEN_PATH}?state=${encodeURIComponent(state)}`;
  const response = await request(url, { method: "GET", headers: { Accept: "application/json" } });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new AtomcodeOAuthError(
      `AtomCode token fetch failed (HTTP ${response.status})${summarize(payload) ? `: ${summarize(payload)}` : ""}`,
      { code: "http_error", status: response.status }
    );
  }
  return parseAtomcodeTokenBundle(payload);
}

/** One poll: pending, or the complete bundle. */
export async function pollAtomcodeLogin(state) {
  if (!(await checkAtomcodeLogin(state))) return { pending: true };
  return { pending: false, bundle: await fetchAtomcodeToken(state) };
}

/**
 * Refresh. Rotation means callers must persist the returned pair; a missing
 * refresh_token keeps the previous one.
 */
export async function refreshAtomcodeToken(refreshToken, proxyOptions = null) {
  const token = typeof refreshToken === "string" ? refreshToken.trim() : "";
  if (!token) {
    throw new AtomcodeOAuthError("AtomCode account has no refresh_token; re-login required", {
      code: "invalid_grant",
      status: 401,
    });
  }
  const url = `${atomcodeBrokerBase()}${ATOMCODE_BROKER_REFRESH_PATH}`;
  const response = await request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ refresh_token: token }),
  }, proxyOptions);
  const payload = await readJson(response);
  if (response.status === 401 || response.status === 403) {
    throw new AtomcodeOAuthError(
      `AtomGit refresh_token rejected${summarize(payload) ? `: ${summarize(payload)}` : ""}`,
      { code: "invalid_grant", status: 401 }
    );
  }
  if (!response.ok) {
    throw new AtomcodeOAuthError(
      `AtomCode token refresh failed (HTTP ${response.status})${summarize(payload) ? `: ${summarize(payload)}` : ""}`,
      { code: "http_error", status: response.status }
    );
  }
  return parseAtomcodeTokenBundle(payload);
}

/** Connection-shaped credentials for the OAuth route / mapTokens. */
export function atomcodeProviderTokens(bundle) {
  return {
    accessToken: bundle.accessToken,
    refreshToken: bundle.refreshToken || null,
    expiresIn: bundle.expiresIn || null,
    email: bundle.email || (bundle.userId ? `atomcode-user-${bundle.userId}` : null),
    displayName: bundle.name || bundle.username || null,
    providerSpecificData: {
      authMethod: "device",
      userId: bundle.userId || "",
      username: bundle.username || "",
      name: bundle.name || "",
      avatarUrl: bundle.avatarUrl || "",
    },
  };
}
