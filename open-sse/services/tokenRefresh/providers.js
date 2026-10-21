import { PROVIDERS, PROVIDER_OAUTH } from "../../config/providers.js";
import { OAUTH_ENDPOINTS, GITHUB_COPILOT, buildKimiHeaders } from "../../config/appConstants.js";
import {
  RACCOON_ACCESS_TOKEN_TTL_SEC,
  RACCOON_REFRESH_URL,
} from "../../config/raccoon.js";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { dedupRefresh } from "./dedup.js";
import { buildClineHeaders, getClineAccessToken } from "../../shared/clineAuth.js";
import { buildExternalIdpRefreshParams } from "../../../src/lib/oauth/kiroExternalIdp.js";
import {
  LOBSTERAI_REFRESH_URL,
  LOBSTERAI_REQUEST_TIMEOUT_MS,
  LOBSTERAI_USER_AGENT,
} from "../../shared/lobsterai/constants.js";
import {
  jwtExpiryMs,
  keyfromFields,
  readNumber,
  resolveClientVersion,
  unwrapEnvelope,
} from "../../shared/lobsterai/client.js";
import { refreshAtomcodeToken as refreshAtomcodeOAuthToken } from "../../shared/atomcode/oauth.js";

let _xaiServiceSingleton = null;
export async function refreshXaiToken(refreshToken, log) {
  if (!refreshToken) return null;
  return dedupRefresh("xai", refreshToken, async () => {
    try {
      if (!_xaiServiceSingleton) {
        const mod = await import("../../../src/lib/oauth/services/xai.js");
        _xaiServiceSingleton = new mod.XaiService();
      }
      const tokens = await _xaiServiceSingleton.refreshAccessToken(refreshToken);
      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || refreshToken,
        expiresIn: tokens.expires_in,
        idToken: tokens.id_token,
      };
    } catch (e) {
      log?.warn?.("TOKEN_REFRESH", `xai refresh failed: ${e?.message || e}`);
      const msg = String(e?.message || "");
      if (msg.includes("invalid_grant") || msg.includes("invalid_request")) {
        return { error: "invalid_grant" };
      }
      return null;
    }
  }, log);
}

// Per-provider refresh variants for the generic path. Keys not listed fall back
// to the default form-encoded OAuth2 refresh with client_id + client_secret.
const REFRESH_PROFILES = {
  claude: {
    bodyFormat: "json",
    includeClientSecret: false,
    url: () => OAUTH_ENDPOINTS.anthropic.token,
    dedupKey: "claude",
  },
  iflow: {
    url: () => OAUTH_ENDPOINTS.iflow.token,
    dedupKey: "iflow",
    extraHeaders: (creds, cfg) => ({
      Authorization: `Basic ${btoa(`${cfg.clientId}:${cfg.clientSecret}`)}`,
    }),
  },
  github: {
    url: () => OAUTH_ENDPOINTS.github.token,
    dedupKey: "github",
    includeClientSecret: (cfg) => !!cfg?.clientSecret,
  },
  kimi: {
    dedupKey: "kimi",
    extraHeaders: (creds) => buildKimiHeaders(creds?.providerSpecificData?.deviceId),
  },
};

function resolveRefreshUrl(provider, config, profile) {
  if (profile?.url) {
    try { return profile.url(); } catch { /* fall through */ }
  }
  return config?.refreshUrl || PROVIDER_OAUTH[provider]?.tokenUrl || null;
}

function buildRefreshBody(profile, config, refreshToken) {
  const fmt = profile?.bodyFormat === "json" ? "json" : "form";
  const includeSecret = profile?.includeClientSecret === undefined
    ? true
    : typeof profile.includeClientSecret === "function"
      ? profile.includeClientSecret(config)
      : profile.includeClientSecret;
  const payload = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.clientId,
  };
  if (includeSecret && config.clientSecret) payload.client_secret = config.clientSecret;
  if (fmt === "json") return { format: "json", body: JSON.stringify(payload) };
  return { format: "form", body: new URLSearchParams(payload) };
}

export async function refreshAccessToken(provider, refreshToken, credentials, log) {
  const config = PROVIDERS[provider];
  const profile = REFRESH_PROFILES[provider] || {};
  const url = resolveRefreshUrl(provider, config, profile);

  if (!config || !url) {
    log?.warn?.("TOKEN_REFRESH", `No refresh URL configured for provider: ${provider}`);
    return null;
  }

  if (!refreshToken) {
    log?.warn?.("TOKEN_REFRESH", `No refresh token available for provider: ${provider}`);
    return null;
  }

  const dedupKey = profile.dedupKey || provider;

  return dedupRefresh(dedupKey, refreshToken, async () => {
  try {
    const { format: bodyFormat, body } = buildRefreshBody(profile, config, refreshToken);
    const headers = {
      "Content-Type": bodyFormat === "json" ? "application/json" : "application/x-www-form-urlencoded",
      Accept: "application/json",
      ...(profile.extraHeaders ? (profile.extraHeaders(credentials, config) || {}) : {}),
    };
    const response = await fetch(url, { method: "POST", headers, body });

    if (!response.ok) {
      const errorText = await response.text();
      log?.error?.("TOKEN_REFRESH", `Failed to refresh token for ${provider}`, {
        status: response.status,
        error: errorText,
      });
      return null;
    }

    const tokens = await response.json();

    log?.info?.("TOKEN_REFRESH", `Successfully refreshed token for ${provider}`, {
      hasNewAccessToken: !!tokens.access_token,
      hasNewRefreshToken: !!tokens.refresh_token,
      expiresIn: tokens.expires_in,
    });

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || refreshToken,
      expiresIn: tokens.expires_in,
      ...(profile.parse ? (profile.parse(tokens) || {}) : {}),
    };
  } catch (error) {
    log?.error?.("TOKEN_REFRESH", `Error refreshing token for ${provider}`, {
      error: error.message,
    });
    return null;
  }
  }, log);
}

// CLIProxyAPI DeviceFlowClient.RefreshToken: form body (no client_secret) + X-Msh-* headers
// Delegate to refreshAccessToken("kimi", ...) — profile carries the X-Msh headers.
export async function refreshKimiToken(refreshToken, credentials, log) {
  return refreshAccessToken("kimi", refreshToken, credentials, log);
}

// Claude OAuth: JSON body, client_id only. Delegate to refreshAccessToken("claude", ...).
export async function refreshClaudeOAuthToken(refreshToken, log) {
  return refreshAccessToken("claude", refreshToken, {}, log);
}

export async function refreshGoogleToken(refreshToken, clientId, clientSecret, log) {
  if (!refreshToken) return null;
  return dedupRefresh(`google:${clientId}`, refreshToken, async () => {
  try {
    const response = await fetch(OAUTH_ENDPOINTS.google.token, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      log?.error?.("TOKEN_REFRESH", "Failed to refresh Google token", { status: response.status, error: errorText });
      return null;
    }

    const tokens = await response.json();
    log?.info?.("TOKEN_REFRESH", "Successfully refreshed Google token", { hasNewAccessToken: !!tokens.access_token, expiresIn: tokens.expires_in });
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || refreshToken, expiresIn: tokens.expires_in };
  } catch (error) {
    log?.error?.("TOKEN_REFRESH", `Network error refreshing Google token: ${error.message}`);
    return null;
  }
  }, log);
}

export function classifyOAuthRefreshError(errorText = "", status = 0) {
  let parsed = null;
  try {
    parsed = errorText ? JSON.parse(errorText) : null;
  } catch {
    parsed = null;
  }

  const code = parsed?.error?.code || parsed?.error || parsed?.error_code || "";
  const description = parsed?.error_description || parsed?.message || errorText || "";
  const combined = `${code} ${description}`.toLowerCase();
  const permanent = [
    "refresh_token_expired",
    "refresh_token_reused",
    "refresh_token_invalidated",
    "invalid_grant",
  ].some((marker) => combined.includes(marker));

  return { status, code, description, permanent };
}

export async function refreshCodexToken(refreshToken, log) {
  if (!refreshToken) return null;
  return dedupRefresh("codex", refreshToken, async () => {
    try {
      const response = await fetch(OAUTH_ENDPOINTS.openai.token, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          client_id: PROVIDERS.codex.clientId,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        const failure = classifyOAuthRefreshError(errorText, response.status);
        if (failure.permanent) {
          log?.error?.("TOKEN_REFRESH", "Codex refresh token already used or invalid. Re-auth required.", {
            status: response.status,
            code: failure.code,
          });
          return { error: "unrecoverable_refresh_error", code: failure.code };
        }

        log?.error?.("TOKEN_REFRESH", "Failed to refresh Codex token", {
          status: response.status,
          error: errorText,
          code: failure.code,
          permanent: failure.permanent,
        });
        return null;
      }

      const tokens = await response.json();

      log?.info?.("TOKEN_REFRESH", "Successfully refreshed Codex token", {
        hasNewAccessToken: !!tokens.access_token,
        hasNewRefreshToken: !!tokens.refresh_token,
        hasIdToken: !!tokens.id_token,
        expiresIn: tokens.expires_in,
      });

      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || refreshToken,
        idToken: tokens.id_token,
        expiresIn: tokens.expires_in,
      };
    } catch (error) {
      log?.error?.("TOKEN_REFRESH", `Network error refreshing Codex token: ${error.message}`);
      return null;
    }
  }, log);
}

async function resolveKiroProfileArnPatch(providerSpecificData, accessToken, refreshedArn) {
  if (providerSpecificData?.profileArn) return {};
  let profileArn = refreshedArn?.trim?.() || null;
  if (!profileArn) {
    const { fetchKiroProfileArn } = await import("../../../src/lib/oauth/providers.js");
    profileArn = await fetchKiroProfileArn(accessToken);
  }
  return profileArn ? { providerSpecificData: { profileArn } } : {};
}

export async function refreshKiroToken(refreshToken, providerSpecificData, log, proxyOptions = null) {
  if (!refreshToken) return null;
  return dedupRefresh("kiro", refreshToken, async () => {
  const authMethod = providerSpecificData?.authMethod;
  const clientId = providerSpecificData?.clientId;
  const clientSecret = providerSpecificData?.clientSecret;
  const region = providerSpecificData?.region;

  if (authMethod === "external_idp") {
    let refreshRequest;
    try {
      refreshRequest = buildExternalIdpRefreshParams(refreshToken, providerSpecificData);
    } catch (error) {
      log?.warn?.("TOKEN_REFRESH", `Invalid Kiro external_idp refresh config: ${error.message}`);
      return null;
    }

    const response = await proxyAwareFetch(refreshRequest.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: refreshRequest.body,
    }, proxyOptions);

    if (!response.ok) {
      const errorText = await response.text();
      log?.error?.("TOKEN_REFRESH", "Failed to refresh Kiro external_idp token", {
        status: response.status,
        error: errorText,
      });
      return null;
    }

    const tokens = await response.json();

    log?.info?.("TOKEN_REFRESH", "Successfully refreshed Kiro external_idp token", {
      hasNewAccessToken: !!tokens.access_token,
      hasNewRefreshToken: !!tokens.refresh_token,
      expiresIn: tokens.expires_in,
    });

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || refreshToken,
      expiresIn: tokens.expires_in,
      providerSpecificData: refreshRequest.providerSpecificData,
    };
  }

  if (clientId && clientSecret) {
    const isIDC = authMethod === "idc";
    const endpoint = isIDC && region
      ? `https://oidc.${region}.amazonaws.com/token`
      : "https://oidc.us-east-1.amazonaws.com/token";

    const response = await proxyAwareFetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        clientId: clientId,
        clientSecret: clientSecret,
        refreshToken: refreshToken,
        grantType: "refresh_token",
      }),
    }, proxyOptions);

    if (!response.ok) {
      const errorText = await response.text();
      log?.error?.("TOKEN_REFRESH", "Failed to refresh Kiro AWS token", {
        status: response.status,
        error: errorText,
      });
      return null;
    }

    const tokens = await response.json();

    log?.info?.("TOKEN_REFRESH", "Successfully refreshed Kiro AWS token", {
      hasNewAccessToken: !!tokens.accessToken,
      expiresIn: tokens.expiresIn,
    });

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken || refreshToken,
      expiresIn: tokens.expiresIn,
      ...(await resolveKiroProfileArnPatch(providerSpecificData, tokens.accessToken, tokens.profileArn)),
    };
  }

  const response = await proxyAwareFetch(PROVIDERS.kiro.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "kiro-cli/1.0.0",
    },
    body: JSON.stringify({
      refreshToken: refreshToken,
    }),
  }, proxyOptions);

  if (!response.ok) {
    const errorText = await response.text();
    log?.error?.("TOKEN_REFRESH", "Failed to refresh Kiro social token", {
      status: response.status,
      error: errorText,
    });
    return null;
  }

  const tokens = await response.json();

  log?.info?.("TOKEN_REFRESH", "Successfully refreshed Kiro social token", {
    hasNewAccessToken: !!tokens.accessToken,
    expiresIn: tokens.expiresIn,
  });

  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || refreshToken,
    expiresIn: tokens.expiresIn,
    ...(await resolveKiroProfileArnPatch(providerSpecificData, tokens.accessToken, tokens.profileArn)),
  };
  }, log);
}

// iFlow: Basic Auth + client_id+client_secret in body. Delegate to refreshAccessToken("iflow", ...).
export async function refreshIflowToken(refreshToken, log) {
  return refreshAccessToken("iflow", refreshToken, {}, log);
}

// GitHub: optional client_secret. Delegate to refreshAccessToken("github", ...).
export async function refreshGitHubToken(refreshToken, log) {
  return refreshAccessToken("github", refreshToken, {}, log);
}

export async function refreshCopilotToken(githubAccessToken, log) {
  if (!githubAccessToken) return null;
  return dedupRefresh("copilot", githubAccessToken, async () => {
  try {
    const response = await fetch(PROVIDER_OAUTH["github"]?.copilotTokenUrl, {
      headers: {
        "Authorization": `token ${githubAccessToken}`,
        "User-Agent": GITHUB_COPILOT.USER_AGENT,
        "Editor-Version": `vscode/${GITHUB_COPILOT.VSCODE_VERSION}`,
        "Editor-Plugin-Version": `copilot-chat/${GITHUB_COPILOT.COPILOT_CHAT_VERSION}`,
        "Accept": "application/json",
        "x-github-api-version": GITHUB_COPILOT.API_VERSION
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      log?.error?.("TOKEN_REFRESH", "Failed to refresh Copilot token", {
        status: response.status,
        error: errorText
      });
      return null;
    }

    const data = await response.json();

    log?.info?.("TOKEN_REFRESH", "Successfully refreshed Copilot token", {
      hasToken: !!data.token,
      expiresAt: data.expires_at
    });

    return {
      token: data.token,
      expiresAt: data.expires_at
    };
  } catch (error) {
    log?.error?.("TOKEN_REFRESH", "Error refreshing Copilot token", {
      error: error.message
    });
    return null;
  }
  }, log);
}

// CodeBuddy (Tencent) refresh — POST /v2/plugin/auth/token/refresh with the
// refresh token carried in the X-Refresh-Token header (not a form body),
// matching the official CodeBuddy CLI. Response: { code: 0, data: <token> }.
// AtomCode (AtomGit) — JSON {refresh_token} to the login broker, no client
// credentials, and BOTH tokens rotate. A rejected refresh token is permanent
// (the browser login has to be repeated), so surface invalid_grant instead of
// a generic null that keeps the dead account in rotation.
export async function refreshAtomcodeToken(refreshToken, log, proxyOptions = null) {
  if (!refreshToken) return null;
  return dedupRefresh("atomcode", refreshToken, async () => {
    try {
      const bundle = await refreshAtomcodeOAuthToken(refreshToken, proxyOptions);
      if (!bundle?.accessToken) return null;
      return {
        accessToken: bundle.accessToken,
        // Rotation: keep the previous token only when the broker omitted it.
        refreshToken: bundle.refreshToken || refreshToken,
        expiresIn: bundle.expiresIn || undefined,
        providerSpecificData: {
          ...(bundle.userId ? { userId: bundle.userId } : {}),
          ...(bundle.username ? { username: bundle.username } : {}),
          ...(bundle.name ? { name: bundle.name } : {}),
        },
      };
    } catch (error) {
      log?.warn?.("TOKEN_REFRESH", `atomcode refresh failed: ${error?.message || error}`);
      if (error?.code === "invalid_grant") return { error: "invalid_grant" };
      return null;
    }
  }, log);
}

export async function refreshCodebuddyToken(refreshToken, log) {
  if (!refreshToken) return null;
  return dedupRefresh("codebuddy-cn", refreshToken, async () => {
    const oauth = PROVIDER_OAUTH["codebuddy-cn"] || {};
    const response = await fetch(oauth.refreshUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": oauth.userAgent,
        "X-Requested-With": "XMLHttpRequest",
        "X-Domain": "copilot.tencent.com",
        "X-Refresh-Token": refreshToken,
        "X-Auth-Refresh-Source": "plugin",
        "X-Product": "SaaS",
      },
      body: "{}",
    });

    if (!response.ok) {
      const errorText = await response.text();
      log?.error?.("TOKEN_REFRESH", "Failed to refresh CodeBuddy token", {
        status: response.status,
        error: errorText,
      });
      return null;
    }

    const data = await response.json();
    if (data.code !== 0 || !data.data?.accessToken) {
      log?.error?.("TOKEN_REFRESH", "CodeBuddy token refresh returned no token", {
        code: data.code,
        msg: data.msg,
      });
      return null;
    }

    log?.info?.("TOKEN_REFRESH", "Successfully refreshed CodeBuddy token", {
      hasNewAccessToken: !!data.data.accessToken,
      hasNewRefreshToken: !!data.data.refreshToken,
      expiresIn: data.data.expiresIn,
    });

    return {
      accessToken: data.data.accessToken,
      refreshToken: data.data.refreshToken || refreshToken,
      expiresIn: data.data.expiresIn,
    };
  }, log);
}

export async function refreshCodebuddyIntlToken(refreshToken, log) {
  if (!refreshToken) return null;
  return dedupRefresh("codebuddy-intl", refreshToken, async () => {
    const oauth = PROVIDER_OAUTH["codebuddy-intl"] || {};
    const response = await fetch(oauth.refreshUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": oauth.userAgent,
        "X-Requested-With": "XMLHttpRequest",
        "X-Domain": "www.codebuddy.ai",
        "X-Refresh-Token": refreshToken,
        "X-Auth-Refresh-Source": "plugin",
        "X-Product": "SaaS",
      },
      body: "{}",
    });

    if (!response.ok) {
      const errorText = await response.text();
      log?.error?.("TOKEN_REFRESH", "Failed to refresh CodeBuddy intl token", {
        status: response.status,
        error: errorText,
      });
      return null;
    }

    const data = await response.json();
    if (data.code !== 0 || !data.data?.accessToken) {
      log?.error?.("TOKEN_REFRESH", "CodeBuddy intl token refresh returned no token", {
        code: data.code,
        msg: data.msg,
      });
      return null;
    }

    log?.info?.("TOKEN_REFRESH", "Successfully refreshed CodeBuddy intl token", {
      hasNewAccessToken: !!data.data.accessToken,
      hasNewRefreshToken: !!data.data.refreshToken,
      expiresIn: data.data.expiresIn,
    });

    return {
      accessToken: data.data.accessToken,
      refreshToken: data.data.refreshToken || refreshToken,
      expiresIn: data.data.expiresIn,
    };
  }, log);
}

export async function refreshMinimaxCodeToken(provider, refreshToken, log, proxyOptions = null) {
  if (!refreshToken) return null;
  return dedupRefresh(provider, refreshToken, async () => {
    const oauthConfig = PROVIDER_OAUTH[provider];
    const tokenUrl = oauthConfig?.tokenUrl || (provider === "minimax-code-global"
      ? "https://account.minimax.io/oauth2/token"
      : "https://account.minimax.cn/oauth2/token");

    try {
      const response = await proxyAwareFetch(tokenUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: oauthConfig?.clientId || "mcode-public",
          refresh_token: refreshToken,
        }).toString(),
      }, proxyOptions);

      if (!response.ok) {
        const errorText = await response.text();
        const failure = classifyOAuthRefreshError(response.status, errorText);
        log?.warn?.("TOKEN_REFRESH", `Failed to refresh MiniMax Code token (${provider})`, {
          status: response.status,
          error: errorText,
          code: failure.code,
          permanent: failure.permanent,
        });
        if (failure.permanent) {
          return { error: failure.code || "invalid_grant" };
        }
        return null;
      }

      const tokens = await response.json();
      log?.info?.("TOKEN_REFRESH", `Successfully refreshed MiniMax Code token (${provider})`, {
        hasNewAccessToken: !!tokens.access_token,
        hasNewRefreshToken: !!tokens.refresh_token,
        expiresIn: tokens.expires_in,
      });

      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || refreshToken,
        expiresIn: tokens.expires_in,
      };
    } catch (error) {
      log?.error?.("TOKEN_REFRESH", `Network error refreshing MiniMax Code token (${provider}): ${error.message}`);
      return null;
    }
  }, log);
}

// ─── Qoder ───────────────────────────────────────────────────────────────────
//
// Qoder device tokens (`dt-...`) refresh on the **openapi** host, unsigned:
//   POST {openApiBaseUrl}/api/v1/deviceToken/refresh  {"refresh_token": "..."}
// PAT-derived job refresh tokens (`jrt-...`) use a sibling endpoint:
//   POST {openApiBaseUrl}/api/v1/jobToken/refresh     {"refresh_token": "..."}
// The two are NOT interchangeable. The registry's old
// `center.../algo/api/v3/user/refresh_token` endpoint is appcode-signed and
// drops an unsigned device-token request with 403 "Request discarded", so it
// is never used here.
//
// Upstream rotates the pair on every successful refresh; the previous refresh
// token is consumed immediately, hence dedupRefresh + full write-back.
const QODER_REFRESH_UA = "qoder-local-proxy";
// Device tokens live ~30 days. Used only when the response carries no
// absolute expiry — refreshing early is harmless, never refreshing is not.
const QODER_DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function qoderPickString(payload, keys) {
  for (const key of keys) {
    const value = payload?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * Absolute expiry only. `expires_in` is milliseconds on Qoder's device
 * endpoint (2591999994 ≈ 30 days) but seconds in other references — guessing
 * writes a multi-decade expiry and disables proactive refresh for good.
 */
function qoderExpiryMs(payload, nowMs = Date.now()) {
  for (const key of ["expires_at", "expiresAt", "expire_time", "expireTime"]) {
    const raw = payload?.[key];
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      return raw < 1e11 ? raw * 1000 : raw;
    }
    if (typeof raw === "string" && raw.trim()) {
      const text = raw.trim();
      if (/^\d+$/.test(text)) {
        const parsed = Number.parseInt(text, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          return parsed < 1e11 ? parsed * 1000 : parsed;
        }
      }
      const parsed = Date.parse(text);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return nowMs + QODER_DEFAULT_TTL_MS;
}

export async function refreshQoderToken(provider, refreshToken, credentials, log, proxyOptions = null) {
  if (!refreshToken) return null;

  const oauth = PROVIDER_OAUTH[provider] || {};
  const url = refreshToken.startsWith("jrt-") ? oauth.jobRefreshUrl : oauth.refreshUrl;
  if (!url) {
    log?.warn?.("TOKEN_REFRESH", `No Qoder refresh URL configured for ${provider}`);
    return null;
  }

  return dedupRefresh(provider, refreshToken, async () => {
    try {
      const response = await proxyAwareFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": QODER_REFRESH_UA,
        },
        body: JSON.stringify({ refresh_token: refreshToken }),
      }, proxyOptions);

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        const failure = classifyOAuthRefreshError(errorText, response.status);
        const code = typeof failure.code === "string" && failure.code ? failure.code : null;
        // 401/403 is terminal across every reference implementation: expired,
        // rotated away, or issued for the other region. Everything else
        // (429/5xx, or a 400 from protocol drift) is transient and must not
        // mark the account — a wrong-endpoint 400 is our bug, not a dead token.
        if (response.status === 401 || response.status === 403 || failure.permanent) {
          log?.error?.("TOKEN_REFRESH", `Qoder refresh token rejected (${provider})`, {
            status: response.status,
            code,
          });
          return { error: "unrecoverable_refresh_error", code };
        }
        log?.warn?.("TOKEN_REFRESH", `Qoder refresh failed transiently (${provider})`, {
          status: response.status,
        });
        return null;
      }

      const data = await response.json().catch(() => null);
      const accessToken = qoderPickString(data, ["device_token", "deviceToken", "token", "access_token"]);
      if (!accessToken) {
        // 200 without a token is an upstream shape change, not proof the
        // refresh token is dead — leave the account in rotation.
        log?.warn?.("TOKEN_REFRESH", `Qoder refresh returned no token (${provider})`);
        return null;
      }

      // Never write account A's token pair onto account B's connection.
      const returnedUser = qoderPickString(data, ["user_id", "uid", "userId"]);
      const expectedUser = credentials?.providerSpecificData?.userId || "";
      if (returnedUser && expectedUser && returnedUser !== expectedUser) {
        log?.error?.("TOKEN_REFRESH", `Qoder refresh returned a different account (${provider})`);
        return null;
      }

      const newRefresh = qoderPickString(data, ["refresh_token", "refreshToken"]) || refreshToken;
      const expiresIn = Math.max(1, Math.floor((qoderExpiryMs(data) - Date.now()) / 1000));

      log?.info?.("TOKEN_REFRESH", `Successfully refreshed Qoder token (${provider})`, {
        hasNewAccessToken: true,
        hasNewRefreshToken: newRefresh !== refreshToken,
        expiresIn,
      });

      return { accessToken, refreshToken: newRefresh, expiresIn };
    } catch (error) {
      log?.error?.("TOKEN_REFRESH", `Error refreshing Qoder token (${provider}): ${error.message}`);
      return null;
    }
  }, log);
}

// Raccoon 小浣熊 — POST {authBase}/refresh {"refresh_token": "..."} ->
// data.access_token + data.refresh_token. The refresh token ROTATES on every
// successful call (Rust raccoon/credentials.rs), so the new value must be
// persisted; dedupRefresh keys on the old token and hands concurrent callers
// the same result instead of replaying a consumed token.
//
// The auth host is a different site from the LLM gateway and the source client
// calls it directly (no account proxy), so this deliberately does not take
// proxyOptions.
function raccoonJwtExpiryMs(token) {
  try {
    const payloadPart = String(token).split(".")[1];
    if (!payloadPart) return null;
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    return Number.isFinite(payload?.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export async function refreshRaccoonToken(refreshToken, log) {
  if (!refreshToken) return null;
  return dedupRefresh("raccoon", refreshToken, async () => {
    try {
      const response = await proxyAwareFetch(RACCOON_REFRESH_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ refresh_token: refreshToken }),
      }, null);

      const text = await response.text();
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }

      if (!response.ok) {
        const failure = classifyOAuthRefreshError(text, response.status);
        log?.warn?.("TOKEN_REFRESH", "Failed to refresh Raccoon token", {
          status: response.status,
          code: failure.code || null,
          permanent: failure.permanent,
        });
        // 401/403 on a refresh call means the refresh token itself is dead —
        // retrying cannot recover it, so surface needs-reauth instead of a miss.
        if (response.status === 401 || response.status === 403 || failure.permanent) {
          return { error: failure.code || "invalid_grant" };
        }
        return null;
      }

      const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;
      const accessToken = String(data?.access_token || "").trim().replace(/^Bearer\s+/i, "");
      if (!accessToken) {
        // A 2xx without a token is a protocol failure, not a transient blip:
        // repeating it will never produce a usable credential.
        log?.warn?.("TOKEN_REFRESH", "Raccoon refresh returned no access_token", {
          code: payload?.code ?? null,
        });
        return { error: "invalid_grant" };
      }
      const nextRefreshToken = String(data?.refresh_token || "").trim().replace(/^Bearer\s+/i, "") || refreshToken;
      const expiresAt = raccoonJwtExpiryMs(accessToken) ?? Date.now() + RACCOON_ACCESS_TOKEN_TTL_SEC * 1000;

      log?.info?.("TOKEN_REFRESH", "Successfully refreshed Raccoon token", {
        hasNewAccessToken: true,
        rotatedRefreshToken: nextRefreshToken !== refreshToken,
      });

      return {
        accessToken,
        // An apikey-category connection keeps the JWT in `apiKey`, and the
        // executor's auth resolution prefers apiKey over accessToken. Without
        // mirroring it here the refreshed token would be persisted but the very
        // next request would keep sending the expired apiKey.
        apiKey: accessToken,
        refreshToken: nextRefreshToken,
        expiresAt,
      };
    } catch (error) {
      log?.error?.("TOKEN_REFRESH", `Network error refreshing Raccoon token: ${error.message}`);
      return null;
    }
  }, log);
}

// Trae refresh — POST ExchangeToken with JSON body {ClientID, RefreshToken, ClientSecret, UserID}.
// Response: {Result: {AccessToken, RefreshToken, TokenType, ExpiresAt}}.
//
// 国内站 / 国际站的 refresh token 不互通（拿错端换必 20101），所以刷新目标必须是
// 和登录时同一端的网关：连接上存了 providerSpecificData.site，这里按它选 URL；
// 老连接没有 site 字段时：refresh token 本身无法区分站点，按登录地址 / 作用域推断，
// 判不出就沿用国际站（这是 site 之前唯一的落地形态）。
const TRAE_REFRESH_ORIGINS = {
  intl: ["https://api.marscode.com", "https://api.trae.ai", "https://www.trae.ai"],
  cn: ["https://api.trae.com.cn", "https://api.marscode.cn", "https://api.trae.cn"],
};

function traeSiteFromCredentials(credentials) {
  const psd = credentials?.providerSpecificData || {};
  const declared = String(psd.site || "").trim().toLowerCase();
  if (declared === "cn" || declared === "intl") return declared;
  const host = String(psd.loginHost || psd.host || "").trim().toLowerCase();
  if (host.endsWith("trae.cn") || host.endsWith("trae.com.cn") || host.endsWith("marscode.cn")) return "cn";
  if (String(psd.scope || "") === "marscode-cn") return "cn";
  return "intl";
}

// Trae SOLO refresh lives in its own module (DeviceProof + legacy fallback);
// re-export keeps the single import surface for tokenRefresh.js.
export { refreshTraeSoloToken } from "./trae-solo.js";

export async function refreshTraeToken(refreshToken, credentials, log) {
  if (!refreshToken) return null;
  const oauth = PROVIDER_OAUTH.trae || {};
  const site = traeSiteFromCredentials(credentials);
  const base = oauth.exchangeTokenUrl || oauth.tokenUrl || "https://api.marscode.com/cloudide/api/v3/trae/oauth/ExchangeToken";
  const path = new URL(base).pathname;
  const candidates = TRAE_REFRESH_ORIGINS[site].map((origin) => `${origin}${path}`);
  if (!candidates.length) {
    log?.warn?.("TOKEN_REFRESH", "No Trae exchangeTokenUrl configured");
    return null;
  }

  return dedupRefresh("trae", refreshToken, async () => {
    for (const url of candidates) {
      const out = await refreshTraeTokenOnce(url, refreshToken, oauth, log, site);
      // null 并不总是"致命"：可能是这个 origin 不归该站点管，换下一个 origin 再试。
      if (out) return out;
    }
    return null;
  }, log);
}

async function refreshTraeTokenOnce(url, refreshToken, oauth, log, site) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "Trae/1.0.0 antigravity-cockpit-tools",
      },
      body: JSON.stringify({
        ClientID: oauth.clientId || "ono9krqynydwx5",
        RefreshToken: refreshToken,
        ClientSecret: oauth.clientSecret || "-",
        UserID: "",
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      // 20101 通常是站点选错（同一 token 在另一端不被认），留给下一个 origin。
      log?.warn?.("TOKEN_REFRESH", "Trae token refresh rejected", {
        site,
        origin: new URL(url).origin,
        status: response.status,
        error: String(errorText || "").slice(0, 200),
      });
      return null;
    }

    const payload = await response.json();
    const result = payload?.Result || payload?.result || payload;
    const accessToken = result?.AccessToken || result?.accessToken;
    if (!accessToken) {
      log?.error?.("TOKEN_REFRESH", "Trae refresh returned no AccessToken", { payload });
      return null;
    }

    const newRefresh = result?.RefreshToken || result?.refreshToken || refreshToken;
    const expiresAt = result?.ExpiresAt || result?.expiresAt;
    let expiresIn;
    if (typeof expiresAt === "number") {
      expiresIn = Math.max(1, expiresAt - Math.floor(Date.now() / 1000));
    } else if (typeof expiresAt === "string") {
      const ms = new Date(expiresAt).getTime() - Date.now();
      expiresIn = ms > 0 ? Math.floor(ms / 1000) : undefined;
    }

    log?.info?.("TOKEN_REFRESH", "Successfully refreshed Trae token", {
      site,
      hasNewAccessToken: !!accessToken,
      hasNewRefreshToken: newRefresh !== refreshToken,
      expiresIn,
    });

    return {
      accessToken,
      refreshToken: newRefresh,
      expiresIn,
    };
  } catch (error) {
    log?.error?.("TOKEN_REFRESH", `Error refreshing Trae token (${site}): ${error.message}`);
    return null;
  }
}

// Zed access_token is long-lived; auth flow returns no refresh_token.
// No refresh possible — re-login required when token expires/revoked.
// Mirrors cursor/kilocode null-refresh pattern.
export function refreshZedToken() {
  return null;
}

// Windsurf apiKey is the long-lived terminal credential (no OAuth2 refresh_token
// grant yields a fresh apiKey). Refresh handled out-of-band by the caller.
// TODO(firebase): if short-lived Firebase JWT credentials must be refreshed,
// re-run RegisterUser with the refreshed Firebase JWT (separate code path).
export async function refreshWindsurfToken(credentials, log) {
  log?.info?.(
    "TOKEN_REFRESH",
    "windsurf: apiKey is long-lived (no refresh_token flow) — skipping"
  );
  return null;
}

// Cline refresh (issue #21). Upstream POST /api/v1/auth/refresh rejects the
// standard OAuth2 snake_case form body — it validates JSON with camelCase
// fields (`refreshToken` + `grantType`) and answers 400 "Validation failed"
// otherwise, which made backgroundTokenRefresh fail 100% for cline rows.
// ClinePass OAuth shares the same endpoints (registry/clinepass.js oauth block,
// CLINEPASS_CONFIG), so one implementation serves both handler entries.
// Auth note: chat/user endpoints require the `Bearer workos:<jwt>` prefix
// (clineAuth.js keeps that), but the refresh endpoint takes the token in the
// body — no Authorization header needed.
export async function refreshClineToken(providerId, refreshToken, log) {
  if (!refreshToken) return null;
  const oauth = PROVIDER_OAUTH[providerId] || PROVIDER_OAUTH.cline || {};
  const url = oauth.refreshUrl;
  if (!url) {
    log?.warn?.("TOKEN_REFRESH", `No Cline refreshUrl configured for ${providerId}`);
    return null;
  }

  return dedupRefresh(providerId, refreshToken, async () => {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: buildClineHeaders(null, {
          "Content-Type": "application/json",
          Accept: "application/json",
        }),
        // clientType matches the authorization exchange convention in
        // src/lib/oauth/providers/cline.js (client_type: "extension"); PR #22
        // live-verified the three-field body, issue #21 the two-field one.
        body: JSON.stringify({ refreshToken, grantType: "refresh_token", clientType: "extension" }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        // Terminal auth errors (revoked/expired/invalidated refresh token)
        // surface as an unrecoverable marker instead of a bare null so logs
        // say "re-auth required" and future scheduler logic can act on it.
        // Transient failures — including any wrong-shape 400 — stay null/retry.
        const failure = classifyOAuthRefreshError(errorText, response.status);
        if (failure.permanent) {
          log?.error?.("TOKEN_REFRESH", `${providerId} refresh token invalid or expired — re-auth required`, {
            status: response.status,
            code: failure.code,
          });
          return { error: "unrecoverable_refresh_error", code: failure.code };
        }
        log?.error?.("TOKEN_REFRESH", `Failed to refresh ${providerId} token`, {
          status: response.status,
          error: errorText,
        });
        return null;
      }

      const payload = await response.json();
      const data = payload?.data || payload;
      // Canonical stored form: the workos: prefix the chat path expects
      // (getClineAccessToken is idempotent, plain JWTs get prefixed).
      const accessToken = getClineAccessToken(data?.accessToken);
      if (!accessToken) {
        log?.error?.("TOKEN_REFRESH", `${providerId} refresh returned no accessToken`, { payload });
        return null;
      }

      const newRefresh = data?.refreshToken || refreshToken;
      // Upstream returns an absolute ISO expiresAt; convert to the relative
      // expiresIn that mergeRefreshedCredentials / updateProviderCredentials
      // prefer (same normalization as the Trae handler).
      let expiresIn;
      if (data?.expiresAt) {
        const ms = new Date(data.expiresAt).getTime() - Date.now();
        if (Number.isFinite(ms) && ms > 0) expiresIn = Math.floor(ms / 1000);
      } else if (typeof data?.expiresIn === "number") {
        expiresIn = data.expiresIn;
      }

      log?.info?.("TOKEN_REFRESH", `Successfully refreshed ${providerId} token`, {
        hasNewAccessToken: true,
        hasNewRefreshToken: newRefresh !== refreshToken,
        expiresIn,
      });

      return { accessToken, refreshToken: newRefresh, expiresIn };
    } catch (error) {
      log?.error?.("TOKEN_REFRESH", `${providerId} refresh error: ${error.message}`);
      return null;
    }
  }, log);
}

// LobsterAI refresh: the upstream rejects a bare `{refresh_token}` OAuth grant.
// It wants the identity payload captured at login (firstKeyfrom / latestKeyfrom,
// optional uuid / userId) plus `version`, and **no Authorization header**.
// `latestKeyfrom` is deliberately never refreshed — keeping the login-time value
// is the only shape validated in production (Rust credentials.rs module head).
export async function refreshLobsterAiToken(credentials, log = null, proxyOptions = null) {
  const refreshToken = credentials?.refreshToken;
  const psd = credentials?.providerSpecificData || {};
  if (!refreshToken) return { error: "invalid_grant" };
  if (!String(psd.firstKeyfrom || "").trim() || !String(psd.latestKeyfrom || "").trim()) {
    // Missing keyfrom means this row can never refresh (only re-login can fix it).
    log?.warn?.("TOKEN_REFRESH", "LobsterAI refresh token without keyfrom payload — re-auth required");
    return { error: "invalid_grant" };
  }

  const version = await resolveClientVersion();
  const body = Object.fromEntries(keyfromFields(psd, version));
  body.refreshToken = refreshToken;

  return dedupRefresh("lobsterai", refreshToken, async () => {
    try {
      const response = await proxyAwareFetch(
        LOBSTERAI_REFRESH_URL,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent": LOBSTERAI_USER_AGENT,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(LOBSTERAI_REQUEST_TIMEOUT_MS),
        },
        proxyOptions,
      );
      const text = await response.text().catch(() => "");
      if (response.status === 401 || response.status === 403) {
        log?.warn?.("TOKEN_REFRESH", `LobsterAI refresh rejected (HTTP ${response.status}) — re-auth required`);
        return { error: "invalid_grant" };
      }
      if (!response.ok) {
        log?.warn?.("TOKEN_REFRESH", `LobsterAI refresh failed (HTTP ${response.status})`, {
          body: text.slice(0, 200),
        });
        return null;
      }

      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        log?.warn?.("TOKEN_REFRESH", "LobsterAI refresh response is not JSON");
        return null;
      }
      const unwrapped = unwrapEnvelope(payload, "续期");
      if (!unwrapped.ok) {
        if (unwrapped.status === 401 || unwrapped.code === 40100 || unwrapped.code === 40101) {
          log?.warn?.("TOKEN_REFRESH", `LobsterAI refresh rejected (${unwrapped.code ?? 401}) — re-auth required`);
          return { error: "invalid_grant" };
        }
        log?.warn?.("TOKEN_REFRESH", `LobsterAI refresh error: ${unwrapped.message}`);
        return null;
      }

      const data = unwrapped.data;
      const accessToken = typeof data?.accessToken === "string" ? data.accessToken.trim() : "";
      if (!accessToken) {
        log?.warn?.("TOKEN_REFRESH", "LobsterAI refresh returned no accessToken — re-auth required");
        return { error: "invalid_grant" };
      }

      let expiresIn = readNumber(data.expiresIn);
      if (!expiresIn || expiresIn <= 0) {
        const expMs = jwtExpiryMs(accessToken);
        expiresIn = expMs > 0 ? Math.max(1, Math.floor((expMs - Date.now()) / 1000)) : undefined;
      }

      log?.info?.("TOKEN_REFRESH", "Successfully refreshed LobsterAI token", {
        hasNewRefreshToken: !!data.refreshToken,
        expiresIn,
      });
      return {
        accessToken,
        refreshToken: data.refreshToken || refreshToken,
        expiresIn,
      };
    } catch (error) {
      log?.warn?.("TOKEN_REFRESH", `LobsterAI refresh error: ${error?.message || error}`);
      return null;
    }
  }, log);
}

// ─── CodeArts / OfficeAce OAuth refresh ─────────────────────────────────────
//
// Both login modules live under src/lib/oauth/providers/ and return the same
// credential shape the login route writes (providerSpecificData + rotated
// refreshToken). Loaded dynamically: these modules pull crypto/DPoP helpers and
// are only needed when a credential is actually near expiry.

export async function refreshCodeArtsToken(credentials, log) {
  const refreshToken = String(credentials?.refreshToken || "").trim();
  if (!refreshToken) return null;
  const psd = credentials?.providerSpecificData || {};
  return dedupRefresh("codearts", refreshToken, async () => {
    try {
      const mod = await import("../../../src/lib/oauth/providers/codearts.js");
      const tokens = await mod.refresh({
        refreshToken,
        pkceVerifier: psd.pkceVerifier || psd.codeVerifier,
        dpopPrivateKeyPem: psd.dpopPrivateKeyPem,
        clientId: psd.clientId,
      });
      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
        providerSpecificData: tokens.providerSpecificData,
      };
    } catch (error) {
      const message = error?.message || String(error);
      const status = Number(error?.status || error?.statusCode || 0);
      const reauth = status === 401 || status === 403 || /invalid_grant|重新登录|缺少 PKCE/i.test(message);
      log?.warn?.("TOKEN_REFRESH", `codearts refresh failed${reauth ? " (re-auth required)" : ""}: ${message}`);
      return reauth ? { error: "invalid_grant", message } : null;
    }
  }, log);
}

export async function refreshOfficeAceToken(credentials, log) {
  const refreshToken = String(credentials?.refreshToken || "").trim();
  if (!refreshToken) return null;
  const psd = credentials?.providerSpecificData || {};
  return dedupRefresh("officeace", refreshToken, async () => {
    try {
      const mod = await import("../../../src/lib/oauth/providers/officeace.js");
      const tokens = await mod.refresh({
        refreshToken,
        dpopPrivateKeyPem: psd.dpopPrivateKeyPem,
      });
      return {
        // The Basic gateway pair does not expire; echoing it makes the generic
        // persist path treat this as a real refresh (OfficeAce only rotates the
        // temporary AK/SK inside providerSpecificData).
        accessToken: credentials.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
        providerSpecificData: tokens.providerSpecificData,
      };
    } catch (error) {
      const message = error?.message || String(error);
      const status = Number(error?.status || error?.statusCode || 0);
      const reauth = status === 400 || status === 401 || status === 403 || /invalid_grant|重新登录|缺少 DPoP/i.test(message);
      log?.warn?.("TOKEN_REFRESH", `officeace refresh failed${reauth ? " (re-auth required)" : ""}: ${message}`);
      return reauth ? { error: "invalid_grant", message } : null;
    }
  }, log);
}
