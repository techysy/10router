import { NextResponse } from "next/server";
import { getSettings, validateApiKey } from "@/lib/localDb";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { verifyDashboardAuthToken, isDashboardAuthConfigured } from "@/lib/auth/dashboardSession";
import { hasTrustedPeerHeaders } from "@/lib/auth/trustedPeer";
import { readCliToken, readDashboardPassword } from "@/lib/auth/authHeaders";

const CLI_TOKEN_SALT = "9r-cli-auth";

let cachedCliToken = null;
async function getCliToken() {
  if (!cachedCliToken) cachedCliToken = await getConsistentMachineId(CLI_TOKEN_SALT);
  return cachedCliToken;
}

async function hasValidCliToken(request) {
  const token = readCliToken(request);
  if (!token) return false;
  return token === await getCliToken();
}

// Public API paths — no auth required (LLM API has its own key auth inside handler).
const PUBLIC_API_PATHS = [
  "/api/health",
  "/api/locale",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/status",
  "/api/auth/oidc",
  "/api/auth/saml",
  // Pre-flight dashboard-password check for gated UI flows (same exposure
  // class as /api/auth/login; leaks nothing but ok).
  "/api/auth/verify-password",
  "/api/settings/require-login",
];

// Reachable without a session only from THIS machine (or with one from
// anywhere). Issue #9 item 11: /api/version and /api/init used to be public, so
// any remote caller could fingerprint the exact build and update state without
// authenticating. The consumers are all local — the CLI's stale-server probe and
// doctor reach http://127.0.0.1:<port>/api/version, desktop/main.js polls it for
// the update check — while the dashboard's Changelog modal fetches it with the
// user's session cookie, which the normal auth branch covers.
//
// NOTE: /api/version/shutdown and /api/version/update match this prefix too. They
// are listed in ALWAYS_PROTECTED, which is evaluated first, so they keep
// requiring a token.
const LOCAL_OR_AUTH_API_PATHS = [
  "/api/version",
  "/api/init",
];

// Public top-level prefixes (LLM API endpoints with their own API key auth).
// Public top-level prefixes (LLM API endpoints with their own API key auth).
// Keep root-level rewrites here too: middleware runs before Next.js rewrites,
// so "/responses" (rewritten to /api/v1/responses) would otherwise fall
// through the guard's catch-all and reach the LLM handler without a key.
const PUBLIC_PREFIXES = ["/v1", "/v1beta", "/api/v1", "/api/v1beta", "/codex", "/responses"];

// Always require JWT token regardless of requireLogin setting
const ALWAYS_PROTECTED = [
  "/api/shutdown",
  "/api/settings/database",
  "/api/version/shutdown",
  "/api/version/update",
  "/api/oauth/cursor/auto-import",
  "/api/oauth/kiro/auto-import",
  // Reads MiMo Desktop's local auth.json and returns the full sk- key —
  // credential-bearing like cursor/kiro auto-import, so it must never slip
  // through the requireLogin=false catch-all.
  "/api/oauth/xiaomi-mimo/auto-import",
  // OAuth credentials transfer: export dumps live tokens (encrypted by a
  // user passphrase AFTER the guard), import writes them. Even with
  // requireLogin=false these must demand credentials (export re-checks the
  // dashboard password inside). Only exception: a same-machine import, see the
  // transfer-import branch in proxy().
  "/api/oauth/transfer/",
];

// Require auth, but allow through if requireLogin is disabled
const PROTECTED_API_PATHS = [
  "/api/settings",
  "/api/keys",
  "/api/providers",
  "/api/provider-nodes",
  "/api/proxy-pools",
  "/api/combos",
  "/api/models",
  "/api/usage",
  "/api/oauth",
  "/api/cloud",
  "/api/media-providers",
  "/api/pricing",
  "/api/tags",
  "/api/cli-tools",
  "/api/mcp",
  "/api/translator",
  "/api/tunnel",
];

// Routes that spawn child processes or read host secrets — restrict to localhost.
const LOCAL_ONLY_PATHS = [
  "/api/cli-tools/cowork-settings",
  "/api/cli-tools/antigravity-mitm",
  "/api/mcp/",
  "/api/tunnel/tailscale-install",
  "/api/tunnel/tailscale-enable",
  "/api/tunnel/tailscale-disable",
  "/api/tunnel/tailscale-check",
  "/api/tunnel/enable",
  "/api/tunnel/disable",
  "/api/oauth/cursor/auto-import",
  "/api/oauth/kiro/auto-import",
  // Host-secret reader (MiMo Desktop auth.json) — remote/LAN calls must never
  // reach it, matching the cursor/kiro auto-import siblings.
  "/api/oauth/xiaomi-mimo/auto-import",
  "/api/auth/reset-password",
  "/api/headroom/start",
  "/api/headroom/stop",
  "/api/headroom/proxy",
];

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

// Accepts a Host header, a URL hostname or a raw socket address. Splitting on the first
// colon only works for IPv4 and would reduce every IPv6 form to "", so a dual-stack
// listener handing back ::ffff:127.0.0.1 would not read as loopback.
function isLoopbackHostname(h) {
  if (!h) return false;
  let name = String(h).trim().toLowerCase();
  if (name.startsWith("[")) {
    const end = name.indexOf("]");
    if (end === -1) return false;
    name = name.slice(1, end);
  } else if (name.indexOf(":") !== -1 && name.indexOf(":") === name.lastIndexOf(":")) {
    name = name.slice(0, name.indexOf(":"));
  }
  if (name.startsWith("::ffff:")) name = name.slice(7);
  return LOOPBACK_HOSTS.has(name);
}

function isLoopbackPeer(request) {
  if (hasTrustedPeerHeaders(request)) {
    return isLoopbackHostname(request.headers.get("x-10r-real-ip"));
  }
  // Bare `next dev` forks its server, so the wrapper never loads and no peer address
  // reaches us. Host is spoofable, so this stays confined to development.
  if (process.env.NODE_ENV === "development") {
    return isLoopbackHostname(request.headers.get("host"));
  }
  return false;
}

export function isLocalRequest(request) {
  // Stamped by custom-server.js when forwarding headers exist: request came through
  // a reverse proxy, so the loopback socket is the proxy hop, not the end-user.
  if (request.headers.get("x-10r-via-proxy")) return false;
  if (!isLoopbackPeer(request)) return false;
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (!isLoopbackHostname(new URL(origin).hostname)) return false;
    } catch { return false; }
  }
  return true;
}

function isPublicLlmApi(pathname) {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function extractApiKey(request) {
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
  const apiKeyHeader = request.headers.get("x-api-key");
  if (apiKeyHeader) return apiKeyHeader;
  const googleApiKeyHeader = request.headers.get("x-goog-api-key");
  if (googleApiKeyHeader) return googleApiKeyHeader;
  return request.nextUrl.searchParams?.get("key") || null;
}

async function hasValidApiKey(request) {
  const apiKey = extractApiKey(request);
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}

async function canAccessPublicLlmApi(request) {
  if (isLocalRequest(request)) return true;
  if (await hasValidCliToken(request)) return true;
  return await hasValidApiKey(request);
}

async function canAccessLocalOnlyRoute(request) {
  if (await hasValidCliToken(request)) return true;
  // Browser on host: loopback Host + Origin (blocks tunnel/CSRF) + auth (JWT or requireLogin=false)
  if (isLocalRequest(request) && await isAuthenticated(request)) return true;
  return false;
}

async function hasValidToken(request) {
  const token = request.cookies.get("auth_token")?.value;
  return await verifyDashboardAuthToken(token);
}

// Read settings directly from DB to avoid self-fetch deadlock in proxy
async function loadSettings() {
  try {
    return await getSettings();
  } catch {
    return null;
  }
}

// Shared with src/proxy.js — the mimo login branch must respect dashboard auth.
export { isAuthenticated };

async function isAuthenticated(request) {
  if (await hasValidToken(request)) return true;
  const settings = await loadSettings();
  if (settings && settings.requireLogin === false) return true;
  // Bootstrap state: no password hash, no INITIAL_PASSWORD, no SSO — there is no
  // secret a remote client could ever present, so remote clients are refused
  // (401 / login redirect) rather than handed a default. The operator on the
  // machine itself is let in so a password can be set; without this the guard
  // would deadlock the first-run experience (login needs a password, setting a
  // password needs auth). See dashboardSession.isDashboardAuthConfigured.
  if (!isDashboardAuthConfigured(settings) && isLocalRequest(request)) return true;
  return false;
}

function isPublicApi(pathname) {
  if (isPublicLlmApi(pathname)) return true;
  return PUBLIC_API_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export const __test__ = {
  isLocalRequest,
  isPublicLlmApi,
  extractApiKey,
  canAccessPublicLlmApi,
  canAccessLocalOnlyRoute,
};

export async function proxy(request) {
  const { pathname } = request.nextUrl;

  // "Dashboard: local-only" (Settings → Experimental → Security, off by default).
  // Refuses non-loopback traffic to the management surface — dashboard HTML,
  // /api/* incl. providers / keys / usage. The LLM API is deliberately exempt:
  // it authenticates with per-key credentials and serving it over the LAN is the
  // product's main scenario, so this switch is about the admin UI and the
  // upstream credentials behind it, not about the gateway itself. Checked before
  // anything else so a remote caller cannot probe which routes exist.
  if (!isPublicLlmApi(pathname)) {
    const settings = await loadSettings();
    if (settings?.dashboardLocalOnly === true && !isLocalRequest(request)) {
      return NextResponse.json(
        { error: "The dashboard is set to local-only access (Experimental → Security). Turn it off from the machine running 10Router to manage it remotely." },
        { status: 403 },
      );
    }
  }

  // Local-only gate for spawn-capable / host-secret routes.
  if (LOCAL_ONLY_PATHS.some((p) => pathname.startsWith(p))) {
    if (!(await canAccessLocalOnlyRoute(request))) {
      return NextResponse.json({ error: "Local only: CLI token required" }, { status: 403 });
    }
  }

  // Usage-import self-serve: POST with explicit credentials (dashboard password
  // or virtual proxy key) is passed through to the route, which verifies them
  // itself — the guard's cookie/CLI-token check can't see these. Must sit above
  // the ALWAYS_PROTECTED prefix match on /api/settings/database.
  if (
    request.method === "POST" &&
    pathname === "/api/settings/database/import-usage" &&
    (readDashboardPassword(request) || extractApiKey(request))
  ) {
    return NextResponse.next();
  }

  // OAuth transfer IMPORT from the machine itself. Inside the route the transfer
  // passphrase is the real authorization (GCM tag proves possession of the export
  // passphrase). With requireLogin=false the local operator has no JWT to present,
  // so the ALWAYS_PROTECTED match below would lock them out of importing their own
  // file (e.g. a CreditDaddy / 10router export). Loopback peer + loopback Origin
  // (isLocalRequest) keeps tunnels, LAN and cross-site pages out; EXPORT stays
  // fully protected because it dumps live tokens.
  if (
    request.method === "POST" &&
    pathname === "/api/oauth/transfer/import" &&
    isLocalRequest(request) &&
    (await isAuthenticated(request))
  ) {
    return NextResponse.next();
  }

  // Always protected - require valid JWT or local CLI token (machineId-based).
  // Exception: agent-managed custom provider write (POST create node / add
  // connection) may use a dashboard LLM API key, so remote agents can self-serve
  // custom OpenAI/Anthropic-compatible endpoints without a CLI token. Only the
  // bare root paths + POST match; list/update/delete on [id] routes stay protected.
  const isAgentProviderWrite =
    request.method === "POST" &&
    (pathname === "/api/provider-nodes" || pathname === "/api/providers");
  if (ALWAYS_PROTECTED.some((p) => pathname.startsWith(p))) {
    if (
      (await hasValidCliToken(request)) ||
      (await hasValidToken(request)) ||
      (isAgentProviderWrite && (await hasValidApiKey(request)))
    )
      return NextResponse.next();
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (isPublicLlmApi(pathname)) {
    if (await canAccessPublicLlmApi(request)) return NextResponse.next();
    return NextResponse.json({ error: "API key required for remote API access" }, { status: 401 });
  }

  // Version/init info: local callers (CLI, tray, same-machine dashboard) as
  // before, plus any authenticated session — but no longer an open book to the
  // network (issue #9, item 11).
  if (LOCAL_OR_AUTH_API_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    if (isLocalRequest(request) || (await hasValidCliToken(request)) || (await isAuthenticated(request))) {
      return NextResponse.next();
    }
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Read-only provider quota overview for external dashboards (e.g. CreditDaddy):
  // a dashboard virtual key (sk-…) is enough, the same trust level as the
  // usage-import self-serve path. GET only; the route returns no credentials.
  if (request.method === "GET" && pathname === "/api/usage/quotas" && (await hasValidApiKey(request))) {
    return NextResponse.next();
  }

  // Deny-by-default for /api/* — public allow-list bypasses, everything else requires auth.
  if (pathname.startsWith("/api/")) {
    if (isPublicApi(pathname)) return NextResponse.next();
    if (await hasValidCliToken(request) || await isAuthenticated(request))
      return NextResponse.next();
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Protect all dashboard routes
  if (pathname.startsWith("/dashboard")) {
    let requireLogin = true;
    let tunnelDashboardAccess = true;
    let dashboardSettings = null;

    try {
      const settings = await loadSettings();
      dashboardSettings = settings;
      if (settings) {
        requireLogin = settings.requireLogin !== false;
        tunnelDashboardAccess = settings.tunnelDashboardAccess === true;

        // Block tunnel/tailscale access if disabled (redirect to login)
        if (!tunnelDashboardAccess) {
          const host = (request.headers.get("host") || "").split(":")[0].toLowerCase();
          const tunnelHost = settings.tunnelUrl ? new URL(settings.tunnelUrl).hostname.toLowerCase() : "";
          const tailscaleHost = settings.tailscaleUrl ? new URL(settings.tailscaleUrl).hostname.toLowerCase() : "";
          if ((tunnelHost && host === tunnelHost) || (tailscaleHost && host === tailscaleHost)) {
            return NextResponse.redirect(new URL("/login", request.url));
          }
        }
      }
    } catch {
      // On error, keep defaults (require login, block tunnel)
    }

    // If login not required, allow through
    if (!requireLogin) return NextResponse.next();

    // Bootstrap state (see isAuthenticated): with nothing configured at all, a
    // remote client has no secret to present — it gets the login page, which
    // explains that the first password has to be set on the machine itself. The
    // loopback operator is let straight in so they *can* set one. This HTML
    // branch reads the cookie directly rather than going through
    // isAuthenticated, so it needs its own copy of the rule.
    if (!isDashboardAuthConfigured(dashboardSettings) && isLocalRequest(request)) {
      return NextResponse.next();
    }

    // Verify JWT token
    const token = request.cookies.get("auth_token")?.value;
    if (token) {
      if (await verifyDashboardAuthToken(token)) {
        return NextResponse.next();
      } else {
        return NextResponse.redirect(new URL("/login", request.url));
      }
    }

    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Redirect / to /dashboard if logged in, or /dashboard if it's the root
  if (pathname === "/") {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}
