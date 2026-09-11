import http from "http";
import crypto from "node:crypto";
import { URL } from "url";
import { CODEX_CONFIG, TRAE_CONFIG, WINDSURF_CONFIG, XIAOMI_MIMO_CONFIG, ZED_HOSTED_CONFIG } from "../constants/oauth.js";

// Loopback origin guard for local callback proxies.
// Legit OAuth redirects are top-level navigations (no `Origin` header); a cross-site
// page issuing `fetch(..., {mode:"no-cors"})` to scan + hit 127.0.0.1 always sends
// `Origin: https://attacker`. Reject any non-loopback Origin to block login-CSRF.
function isLoopbackOrigin(origin) {
  if (!origin) return true; // navigation redirect — allow
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
}


/**
 * Start a local HTTP server to receive OAuth callback
 * @param {Function} onCallback - Called with query params when callback received
 * @param {number} fixedPort - Optional fixed port number (default: random)
 * @returns {Promise<{server: http.Server, port: number, close: Function}>}
 */
export function startLocalServer(onCallback, fixedPort = null) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost`);

      if (url.pathname === "/callback" || url.pathname === "/auth/callback") {
        const params = Object.fromEntries(url.searchParams);

        // Send success response to browser with auto-close attempt
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Authentication Successful</title>
  <style>
    body { font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5; }
    .container { text-align: center; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
    .success { color: #22c55e; font-size: 3rem; }
    h1 { margin: 1rem 0; }
    p { color: #666; }
    #countdown { font-weight: bold; }
  </style>
</head>
<body>
  <div class="container">
    <div class="success">&#10003;</div>
    <h1>Authentication Successful</h1>
    <p id="message">Closing in <span id="countdown">3</span> seconds...</p>
  </div>
  <script>
    let count = 3;
    const countdown = document.getElementById("countdown");
    const message = document.getElementById("message");
    const timer = setInterval(() => {
      count--;
      countdown.textContent = count;
      if (count <= 0) {
        clearInterval(timer);
        window.close();
        setTimeout(() => {
          message.textContent = "Please close this tab manually.";
        }, 500);
      }
    }, 1000);
  </script>
</body>
</html>`);

        // Call callback with params
        onCallback(params);
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    // Listen on fixed port or find available port
    const portToUse = fixedPort || 0;
    server.listen(portToUse, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        close: () => server.close(),
      });
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE" && fixedPort) {
        reject(new Error(`Port ${fixedPort} is already in use. Please close other applications using this port.`));
      } else {
        reject(err);
      }
    });
  });
}

/**
 * Wait for callback with timeout
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<Object>} - Callback params
 */
export function waitForCallback(timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error("Authentication timeout"));
      }
    }, timeoutMs);

    const onCallback = (params) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve(params);
      }
    };

    // Return the callback function
    resolve.__onCallback = onCallback;
  });
}

// Singleton proxy server for Codex OAuth callback on fixed port
let codexProxyServer = null;
let codexProxyTimeout = null;

const CODEX_PROXY_TIMEOUT_MS = 300000; // 5 minutes
const CODEX_PORT = CODEX_CONFIG.fixedPort;

// Pending exchange sessions keyed by state — used by server-side exchange mode
const pendingExchanges = new Map();

/**
 * Register a pending exchange session for server-side mode.
 * Modal client calls this before opening popup.
 */
export function registerCodexSession({ state, codeVerifier, redirectUri }) {
  if (!state || !codeVerifier || !redirectUri) return false;
  pendingExchanges.set(state, {
    codeVerifier,
    redirectUri,
    status: "pending",
    createdAt: Date.now(),
  });
  return true;
}

/**
 * Read session status (modal polls this).
 */
export function getCodexSessionStatus(state) {
  return pendingExchanges.get(state) || null;
}

/**
 * Clear a session (called after modal consumes status).
 */
export function clearCodexSession(state) {
  pendingExchanges.delete(state);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderCodexResultPage(success, message) {
  const color = success ? "#22c55e" : "#ef4444";
  const icon = success ? "&#10003;" : "&#10007;";
  const title = success ? "Authentication Successful" : "Authentication Failed";
  const safeMessage = escapeHtml(message);
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f5f5f5}.c{text-align:center;padding:2rem;background:#fff;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.1)}.i{color:${color};font-size:3rem}h1{margin:1rem 0}p{color:#666}</style>
</head><body><div class="c"><div class="i">${icon}</div><h1>${title}</h1><p>${safeMessage}</p><p>Closing in <span id="cd">3</span>s...</p>
<script>let n=3;const c=document.getElementById("cd");const t=setInterval(()=>{n--;c.textContent=n;if(n<=0){clearInterval(t);window.close();}},1000);</script>
</div></body></html>`;
}

/**
 * Start Codex proxy on fixed port 1455.
 * Mode A (server-side): if any session was registered, proxy auto-exchanges + saves DB.
 * Mode B (channel fallback): if no session, proxy 302 redirects to app port for legacy channel-based flow.
 */
export function startCodexProxy(appPort) {
  return new Promise((resolve) => {
    if (codexProxyServer) {
      resolve({ success: true });
      return;
    }

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");

      if (url.pathname !== "/callback" && url.pathname !== "/auth/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const errorParam = url.searchParams.get("error");
      const session = state ? pendingExchanges.get(state) : null;

      // Mode A: server-side exchange (session registered)
      if (session) {
        try {
          if (errorParam) {
            throw new Error(url.searchParams.get("error_description") || errorParam);
          }
          if (!code) throw new Error("No authorization code received");

          // Lazy import to avoid circular deps
          const { exchangeTokens } = await import("../providers.js");
          const { createProviderConnection } = await import("@/models");

          const tokenData = await exchangeTokens(
            "codex",
            code,
            session.redirectUri,
            session.codeVerifier,
            state
          );
          const connection = await createProviderConnection({
            provider: "codex",
            authType: "oauth",
            ...tokenData,
            expiresAt: tokenData.expiresIn
              ? new Date(Date.now() + tokenData.expiresIn * 1000).toISOString()
              : null,
            testStatus: "active",
          });

          session.status = "done";
          session.connectionId = connection.id;
          session.email = connection.email;

          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderCodexResultPage(true, "You can close this window."));
        } catch (err) {
          session.status = "error";
          session.error = err.message;
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderCodexResultPage(false, err.message));
        } finally {
          stopCodexProxy();
        }
        return;
      }

      // Mode B: legacy channel fallback — 302 redirect to app /callback
      const redirectUrl = `http://localhost:${appPort}/callback${url.search}`;
      res.writeHead(302, { Location: redirectUrl });
      res.end();
      stopCodexProxy();
    });

    server.listen(CODEX_PORT, "127.0.0.1", () => {
      codexProxyServer = server;
      codexProxyTimeout = setTimeout(() => stopCodexProxy(), CODEX_PROXY_TIMEOUT_MS);
      resolve({ success: true });
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        resolve({ success: false, reason: "port_busy" });
      } else {
        resolve({ success: false, reason: err.message });
      }
    });
  });
}

/**
 * Stop the Codex proxy server and cleanup
 */
export function stopCodexProxy() {
  if (codexProxyTimeout) {
    clearTimeout(codexProxyTimeout);
    codexProxyTimeout = null;
  }
  if (codexProxyServer) {
    codexProxyServer.close();
    codexProxyServer = null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// xAI fixed-port proxy on 127.0.0.1:56121
// Same shape as the Codex proxy. Kept as a parallel implementation rather than
// generalizing the Codex one to keep the codex hot-path byte-equivalent.
// ───────────────────────────────────────────────────────────────────────────

let xaiProxyServer = null;
let xaiProxyTimeout = null;
const XAI_PROXY_TIMEOUT_MS = 300000; // 5 minutes
const XAI_PROXY_PORT = 56121;
const xaiPendingExchanges = new Map();

export function registerXaiSession({ state, codeVerifier, redirectUri }) {
  if (!state || !codeVerifier || !redirectUri) return false;
  xaiPendingExchanges.set(state, {
    codeVerifier,
    redirectUri,
    status: "pending",
    createdAt: Date.now(),
  });
  return true;
}

export function getXaiSessionStatus(state) {
  return xaiPendingExchanges.get(state) || null;
}

export function clearXaiSession(state) {
  xaiPendingExchanges.delete(state);
}

function renderXaiResultPage(success, message) {
  return renderCodexResultPage(success, message);
}

/**
 * Start xAI proxy on fixed port 56121.
 * Mode A (server-side): if any session was registered, proxy auto-exchanges + saves DB.
 * Mode B (channel fallback): if no session, proxy 302 redirects to app port.
 */
export function startXaiProxy(appPort) {
  return new Promise((resolve) => {
    if (xaiProxyServer) {
      resolve({ success: true });
      return;
    }

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname !== "/callback" && url.pathname !== "/auth/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const errorParam = url.searchParams.get("error");
      const session = state ? xaiPendingExchanges.get(state) : null;

      // Mode A: server-side exchange
      if (session) {
        try {
          if (errorParam) {
            throw new Error(url.searchParams.get("error_description") || errorParam);
          }
          if (!code) throw new Error("No authorization code received");

          const { exchangeTokens } = await import("../providers.js");
          const { createProviderConnection } = await import("@/models");

          const tokenData = await exchangeTokens(
            "xai",
            code,
            session.redirectUri,
            session.codeVerifier,
            state
          );
          const connection = await createProviderConnection({
            provider: "xai",
            authType: "oauth",
            ...tokenData,
            expiresAt: tokenData.expiresIn
              ? new Date(Date.now() + tokenData.expiresIn * 1000).toISOString()
              : null,
            testStatus: "active",
          });

          session.status = "done";
          session.connectionId = connection.id;
          session.email = connection.email;

          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderXaiResultPage(true, "You can close this window."));
        } catch (err) {
          session.status = "error";
          session.error = err.message;
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderXaiResultPage(false, err.message));
        } finally {
          stopXaiProxy();
        }
        return;
      }

      // Mode B: legacy fallback redirect
      const redirectUrl = `http://localhost:${appPort}/callback${url.search}`;
      res.writeHead(302, { Location: redirectUrl });
      res.end();
      stopXaiProxy();
    });

    server.listen(XAI_PROXY_PORT, "127.0.0.1", () => {
      xaiProxyServer = server;
      xaiProxyTimeout = setTimeout(() => stopXaiProxy(), XAI_PROXY_TIMEOUT_MS);
      resolve({ success: true });
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        resolve({ success: false, reason: "port_busy" });
      } else {
        resolve({ success: false, reason: err.message });
      }
    });
  });
}

export function stopXaiProxy() {
  if (xaiProxyTimeout) {
    clearTimeout(xaiProxyTimeout);
    xaiProxyTimeout = null;
  }
  if (xaiProxyServer) {
    xaiProxyServer.close();
    xaiProxyServer = null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Trae dynamic-port proxy. Singleton session (one connect at a time per provider).
// Callback path = /callback with params refreshToken + loginHost.
// ───────────────────────────────────────────────────────────────────────────

let traeProxyServer = null;
let traeProxyTimeout = null;
let traeProxyPort = null;
let traeSession = null;

export function registerTraeSession({ state }) {
  if (!state) return false;
  traeSession = { state, status: "pending", createdAt: Date.now() };
  return true;
}
export function getTraeSessionStatus(state) {
  if (!traeSession) return null;
  if (state && traeSession.state !== state) return null;
  return traeSession;
}
export function clearTraeSession(state) {
  if (!state || (traeSession && traeSession.state === state)) traeSession = null;
}

export function startTraeProxy() {
  return new Promise((resolve) => {
    if (traeProxyServer) {
      resolve({ success: true, port: traeProxyPort, callbackUrl: `http://127.0.0.1:${traeProxyPort}${TRAE_CONFIG.callbackPath}` });
      return;
    }
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname !== TRAE_CONFIG.callbackPath && url.pathname !== "/auth/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const session = traeSession;
      if (!session) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, "No active Trae login session"));
        return;
      }
      // Anti-CSRF: reject cross-origin fetches (legit redirects send no Origin),
      // and reject state mismatch when state is present.
      if (!isLoopbackOrigin(req.headers.origin)) {
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, "Cross-origin callback rejected"));
        return;
      }
      const cbState = url.searchParams.get("state");
      if (cbState && session.state && cbState !== session.state) {
        session.status = "error";
        session.error = "Trae callback state mismatch";
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, session.error));
        stopTraeProxy();
        return;
      }
      // Pass the raw callback query to exchangeTokens → parseTraeCallback
      const rawCallback = `${url.pathname}?${url.searchParams.toString()}`;
      try {
        const { exchangeTokens } = await import("../providers.js");
        const { createProviderConnection } = await import("@/models");
        const tokenData = await exchangeTokens("trae", rawCallback);
        const connection = await createProviderConnection({
          provider: "trae",
          authType: "oauth",
          ...tokenData,
          expiresAt: tokenData.expiresIn
            ? new Date(Date.now() + tokenData.expiresIn * 1000).toISOString()
            : null,
          testStatus: "active",
        });
        session.status = "done";
        session.connectionId = connection.id;
        session.email = connection.email;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(true, "You can close this window."));
      } catch (err) {
        session.status = "error";
        session.error = err.message;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, err.message));
      } finally {
        stopTraeProxy();
      }
    });
    server.listen(0, "127.0.0.1", () => {
      traeProxyServer = server;
      traeProxyPort = server.address().port;
      traeProxyTimeout = setTimeout(() => stopTraeProxy(), TRAE_CONFIG.oauthTimeoutMs);
      resolve({ success: true, port: traeProxyPort, callbackUrl: `http://127.0.0.1:${traeProxyPort}${TRAE_CONFIG.callbackPath}` });
    });
    server.on("error", (err) => resolve({ success: false, reason: err.message }));
  });
}

export function stopTraeProxy() {
  if (traeProxyTimeout) { clearTimeout(traeProxyTimeout); traeProxyTimeout = null; }
  if (traeProxyServer) { traeProxyServer.close(); traeProxyServer = null; }
  traeProxyPort = null;
}

// ───────────────────────────────────────────────────────────────────────────
// Windsurf dynamic-port proxy. Singleton session.
// Callback path = /windsurf-auth-callback with params access_token (firebase JWT) + state.
// ───────────────────────────────────────────────────────────────────────────

let windsurfProxyServer = null;
let windsurfProxyTimeout = null;
let windsurfProxyPort = null;
let windsurfSession = null;

export function registerWindsurfSession({ state }) {
  if (!state) return false;
  windsurfSession = { state, status: "pending", createdAt: Date.now() };
  return true;
}
export function getWindsurfSessionStatus(state) {
  if (!windsurfSession) return null;
  if (state && windsurfSession.state !== state) return null;
  return windsurfSession;
}
export function clearWindsurfSession(state) {
  if (!state || (windsurfSession && windsurfSession.state === state)) windsurfSession = null;
}

export function startWindsurfProxy() {
  return new Promise((resolve) => {
    if (windsurfProxyServer) {
      resolve({ success: true, port: windsurfProxyPort, callbackUrl: `http://127.0.0.1:${windsurfProxyPort}${WINDSURF_CONFIG.callbackPath}` });
      return;
    }
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname !== WINDSURF_CONFIG.callbackPath) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const session = windsurfSession;
      if (!session) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, "No active Windsurf login session"));
        return;
      }
      // Anti-CSRF: reject cross-origin fetches, and require state present + matching.
      if (!isLoopbackOrigin(req.headers.origin)) {
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, "Cross-origin callback rejected"));
        return;
      }
      const cbState = url.searchParams.get("state");
      if (!cbState || !session.state || cbState !== session.state) {
        session.status = "error";
        session.error = "Windsurf callback state mismatch";
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, session.error));
        stopWindsurfProxy();
        return;
      }
      const rawCallback = `${url.pathname}?${url.searchParams.toString()}`;
      try {
        const { exchangeTokens } = await import("../providers.js");
        const { createProviderConnection } = await import("@/models");
        const tokenData = await exchangeTokens("windsurf", rawCallback, null, null, session.state);
        const connection = await createProviderConnection({
          provider: "windsurf",
          authType: "api_key",
          ...tokenData,
          testStatus: "active",
        });
        session.status = "done";
        session.connectionId = connection.id;
        session.email = connection.email;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(true, "You can close this window."));
      } catch (err) {
        session.status = "error";
        session.error = err.message;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, err.message));
      } finally {
        stopWindsurfProxy();
      }
    });
    server.listen(0, "127.0.0.1", () => {
      windsurfProxyServer = server;
      windsurfProxyPort = server.address().port;
      windsurfProxyTimeout = setTimeout(() => stopWindsurfProxy(), WINDSURF_CONFIG.oauthTimeoutMs);
      resolve({ success: true, port: windsurfProxyPort, callbackUrl: `http://127.0.0.1:${windsurfProxyPort}${WINDSURF_CONFIG.callbackPath}` });
    });
    server.on("error", (err) => resolve({ success: false, reason: err.message }));
  });
}

export function stopWindsurfProxy() {
  if (windsurfProxyTimeout) { clearTimeout(windsurfProxyTimeout); windsurfProxyTimeout = null; }
  if (windsurfProxyServer) { windsurfProxyServer.close(); windsurfProxyServer = null; }
  windsurfProxyPort = null;
}

// ───────────────────────────────────────────────────────────────────────────
// Zed RSA native-app proxy. Singleton session.
// Callback: GET http://127.0.0.1:<port>/?user_id=...&access_token=<RSA-encrypted>
// The proxy decrypts the access token using the private key stored in session.codeVerifier.
// ───────────────────────────────────────────────────────────────────────────

let zedProxyServer = null;
let zedProxyTimeout = null;
let zedProxyPort = null;
let zedSession = null;

export function registerZedSession({ state, codeVerifier }) {
  if (!state || !codeVerifier) return false;
  zedSession = { state, codeVerifier, status: "pending", createdAt: Date.now() };
  return true;
}
export function getZedSessionStatus(state) {
  if (!zedSession) return null;
  if (state && zedSession.state !== state) return null;
  return zedSession;
}
export function clearZedSession(state) {
  if (!state || (zedSession && zedSession.state === state)) zedSession = null;
}

export function startZedProxy(preferredPort = 0) {
  return new Promise((resolve) => {
    if (zedProxyServer) {
      resolve({ success: true, port: zedProxyPort, callbackUrl: `http://127.0.0.1:${zedProxyPort}/` });
      return;
    }
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      // Log path + redacted params (access_token is the RSA-encrypted credential).
      const redacted = Object.fromEntries(url.searchParams);
      for (const k of ["access_token", "user_id", "code_verifier", "state"]) {
        if (redacted[k]) redacted[k] = "<redacted>";
      }
      console.log("[Zed proxy]", req.method, url.pathname, JSON.stringify(redacted));
      if (url.pathname !== "/" && url.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const session = zedSession;
      if (!session) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, "No active Zed login session"));
        return;
      }
      // Anti-CSRF: Zed tokens are RSA-encrypted to our keypair so they can't be
      // forged cross-site, but still reject cross-origin fetches for defense-in-depth.
      if (!isLoopbackOrigin(req.headers.origin)) {
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, "Cross-origin callback rejected"));
        return;
      }
      // Pass raw callback path+query to exchangeTokens → parseZedCallbackPayload.
      // codeVerifier carries the encoded RSA private key for decryption.
      const rawCallback = url.search ? `${url.pathname}?${url.searchParams.toString()}` : url.pathname;
      try {
        const { exchangeTokens } = await import("../providers.js");
        const { createProviderConnection } = await import("@/models");
        const tokenData = await exchangeTokens("zed", rawCallback, null, session.codeVerifier, session.state);
        const connection = await createProviderConnection({
          provider: "zed",
          authType: "oauth",
          ...tokenData,
          testStatus: "active",
        });
        session.status = "done";
        session.connectionId = connection.id;
        session.email = connection.email;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(true, "You can close this window."));
      } catch (err) {
        session.status = "error";
        session.error = err.message;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderCodexResultPage(false, err.message));
      } finally {
        stopZedProxy();
      }
    });
    const tryPort = Number(preferredPort) || 0;
    server.on("error", (err) => {
      // If the preferred port (e.g. 58443) is busy, fall back to a random port.
      if (err.code === "EADDRINUSE" && tryPort !== 0) {
        console.log(`[Zed proxy] port ${tryPort} busy, falling back to random`);
        server.listen(0, "127.0.0.1", () => {
          zedProxyServer = server;
          zedProxyPort = server.address().port;
          zedProxyTimeout = setTimeout(() => stopZedProxy(), ZED_HOSTED_CONFIG.oauthTimeoutMs);
          console.log(`[Zed proxy] listening on random port ${zedProxyPort}`);
          resolve({ success: true, port: zedProxyPort, callbackUrl: `http://127.0.0.1:${zedProxyPort}/` });
        });
      } else {
        console.log(`[Zed proxy] listen error: ${err.message}`);
        resolve({ success: false, reason: err.message });
      }
    });
    server.listen(tryPort, "127.0.0.1", () => {
      zedProxyServer = server;
      zedProxyPort = server.address().port;
      zedProxyTimeout = setTimeout(() => { console.log("[Zed proxy] timeout, stopping"); stopZedProxy(); }, ZED_HOSTED_CONFIG.oauthTimeoutMs);
      console.log(`[Zed proxy] listening on port ${zedProxyPort}`);
      resolve({ success: true, port: zedProxyPort, callbackUrl: `http://127.0.0.1:${zedProxyPort}/` });
    });
  });
}

export function stopZedProxy() {
  console.log(`[Zed proxy] stopping (port ${zedProxyPort || "-"})`);
  if (zedProxyTimeout) { clearTimeout(zedProxyTimeout); zedProxyTimeout = null; }
  if (zedProxyServer) { zedProxyServer.close(); zedProxyServer = null; }
  zedProxyPort = null;
}

// ───────────────────────────────────────────────────────────────────────────
// Xiaomi MiMo Desktop OAuth callback proxy
// Receives the ECDH-encrypted `u` param, decrypts it, stores the session.
// ───────────────────────────────────────────────────────────────────────────

let xiaomiMimoProxyServer = null;
let xiaomiMimoProxyPort = null;
let xiaomiMimoProxyTimeout = null;
// The only origin allowed to call the listener cross-origin: the platform's own login
// page, which is what hands us the payload.
const XIAOMI_MIMO_PLATFORM_ORIGIN = new URL(XIAOMI_MIMO_CONFIG.platformUrl).origin;
// Per-listener secret path. The platform's authorize page fetches this URL and hands
// the encrypted payload to it, so the path doubles as the capability that keeps a
// random web page from talking to the listener at all — which is why the official
// client randomises it, and why it is what replaces a loopback-only Origin check
// (the platform page is an https origin and could never pass one).
let xiaomiMimoCallbackPath = null;

/** Where the platform's page expects to be told how the hand-off went. */
function xiaomiMimoPlatformCallbackUrl(status, message) {
  const url = new URL(`${XIAOMI_MIMO_CONFIG.platformUrl}/authorize/callback`);
  url.searchParams.set("status", status);
  if (message) url.searchParams.set("message", message);
  return url.toString();
}

const xiaomiMimoSessions = new Map();

export function registerXiaomiMimoSession({ state, privateKeyDer }) {
  if (!state || !privateKeyDer) return false;
  // Bound the map: each entry holds an X25519 private key. The window is the
  // PASTE-CODE window, not the callback window — the platform's authorize page makes
  // the user copy a code by hand, so a key has to outlive the local listener.
  const cutoff = Date.now() - XIAOMI_MIMO_CONFIG.pendingTtlMs;
  for (const [key, s] of xiaomiMimoSessions) {
    if (s.createdAt < cutoff) xiaomiMimoSessions.delete(key);
  }
  xiaomiMimoSessions.set(state, {
    privateKeyDer,
    status: "pending",
    createdAt: Date.now(),
  });
  return true;
}

export function getXiaomiMimoSessionStatus(state) {
  const s = xiaomiMimoSessions.get(state);
  if (!s) return null;
  // Don't leak the private key to the client
  return { status: s.status, result: s.result || null, error: s.error || null };
}

export function clearXiaomiMimoSession(state) {
  xiaomiMimoSessions.delete(state);
}

/**
 * Minimum plausible size of the encrypted payload.
 *
 * Wire format needs 12-byte nonce + 32-byte ephemeral public key + 16-byte GCM tag +
 * at least 1 byte of ciphertext = 61 raw bytes, i.e. 84 base64 characters. Anything
 * shorter cannot be a payload — that is a copy problem, not a key mismatch, and the
 * user needs to hear exactly that difference.
 */
const MIN_XIAOMI_MIMO_PAYLOAD_CHARS = 60;

/**
 * Normalize a browser-delivered encrypted payload.
 *
 * The same blob arrives four ways: as the `u` query param on the local callback, as a
 * bare code copied off the platform's authorize page, as `u=<payload>` without a URL,
 * and as the whole page text — which drags a label ("授权码：…", "Authorization code: …")
 * and wrapping quotes along with it. Getting any of that wrong trips the GCM tag and
 * looks like "the code is wrong", so be forgiving here instead of blaming the user.
 *
 * @param {string} input
 * @returns {string} payload, or "" when nothing usable was supplied
 */
export function normalizeXiaomiMimoPayload(input) {
  let value = String(input ?? "").trim();
  if (!value) return "";

  // A pasted URL/query — also covers a bare `u=<payload>` with no URL around it.
  const wrapped = value.match(/(?:^|[?&])(?:u|code)=([^&\s]+)/);
  if (wrapped) {
    try {
      value = decodeURIComponent(wrapped[1]);
    } catch {
      value = wrapped[1]; // A stray '%' must not become a 500
    }
  }

  // A label copied together with the code. ASCII labels require a separator so a
  // payload that merely starts with those letters is never eaten.
  value = value
    .replace(/^(?:授权码|验证码)\s*[:：=]?\s*/, "")
    .replace(/^(?:authorization\s*code|code)\s*[:：=]\s*/i, "");
  // Wrapping punctuation from copy buttons, markdown or quotes; and a trailing
  // sentence punctuation mark from "…code. " style pages.
  value = value.replace(/^[`'"“”‘’<([{]+/, "").replace(/[`'"“”‘’>)\]},.;:。，；：]+$/, "");
  return value.replace(/\s+/g, "");
}

/**
 * Decrypt a payload against every pending session and store the credential in
 * whichever session's private key opened it.
 *
 * Both entry points funnel through here:
 *   • the local callback proxy (`?u=`), and
 *   • a pasted authorization code (POST …/submit-code).
 *
 * MiMo Desktop's own login engine does the same thing (its `loginCode()` walks up
 * to 8 pending keys), because the platform never echoes a state: attribution IS
 * "which pending key decrypts it", so every key must be tried.
 *
 * A failure deliberately leaves every session untouched — with several logins in
 * flight one stray payload must not abort the others, and a synchronous caller
 * (the paste route) reports the error directly instead.
 *
 * @param {string} rawPayload
 * @returns {Promise<{ok: true, state: string, result: object}
 *   | {ok: false, error: "empty_payload"|"payload_too_short"|"no_pending_session"|"missing_api_key"|"decrypt_failed"}>}
 */
export async function completeXiaomiMimoFlow(rawPayload) {
  const payload = normalizeXiaomiMimoPayload(rawPayload);
  if (!payload) return { ok: false, error: "empty_payload" };
  if (payload.length < MIN_XIAOMI_MIMO_PAYLOAD_CHARS) {
    return { ok: false, error: "payload_too_short" };
  }

  const pending = [...xiaomiMimoSessions.entries()].filter(([, s]) => s.status === "pending");
  if (pending.length === 0) return { ok: false, error: "no_pending_session" };

  const { decryptCallback } = await import("../providers/xiaomi-mimo.js");
  let openedWithoutKey = false;

  for (const [state, session] of pending) {
    let decrypted;
    try {
      decrypted = decryptCallback(session.privateKeyDer, payload);
    } catch {
      continue; // Wrong key for this session — try the next one
    }
    if (!decrypted.sk) {
      // The AES-GCM tag verified, so this IS our payload — it just is not a
      // credential. Report that precisely instead of blaming the key.
      openedWithoutKey = true;
      continue;
    }

    session.status = "done";
    session.result = {
      uid: decrypted.uid,
      accessToken: decrypted.sk,
      baseUrl: decrypted.url || XIAOMI_MIMO_CONFIG.defaultBaseUrl,
    };
    return { ok: true, state, result: session.result };
  }

  const failed = openedWithoutKey ? "missing_api_key" : "decrypt_failed";
  // Length + pending count only — the payload itself is a credential container and
  // must never be written to a log.
  console.warn(
    `[xiaomi-mimo oauth] code rejected (${failed}): ${payload.length} chars, ${pending.length} pending session(s)`,
  );
  return { ok: false, error: failed };
}

/**
 * Start the Xiaomi Desktop OAuth callback proxy.
 * @returns {Promise<{success: boolean, port?: number, callbackUrl?: string, reason?: string}>}
 */
export function startXiaomiMimoProxy() {
  return new Promise((resolve) => {
    if (xiaomiMimoProxyServer) {
      resolve({
        success: true,
        port: xiaomiMimoProxyPort,
        callbackUrl: `http://127.0.0.1:${xiaomiMimoProxyPort}${xiaomiMimoCallbackPath}`,
      });
      return;
    }

    const callbackPath =
      xiaomiMimoCallbackPath ||
      (xiaomiMimoCallbackPath = `/callback/${crypto.randomBytes(16).toString("hex")}`);

    const server = http.createServer(async (req, res) => {
      // The platform's login page calls this listener from its own https origin, so the
      // origin CANNOT be restricted to loopback (doing so silently broke the whole
      // hand-off). The anti-abuse property comes from the unguessable callback path
      // below plus the fact that the payload only opens with our X25519 private key —
      // the same shape the official client uses.
      const origin = req.headers.origin || "";
      const cors =
        origin === XIAOMI_MIMO_PLATFORM_ORIGIN
          ? {
              "Access-Control-Allow-Origin": origin,
              "Access-Control-Allow-Methods": "GET, OPTIONS",
              "Access-Control-Allow-Headers": "*",
              "Access-Control-Max-Age": "600",
              Vary: "Origin",
            }
          : { Vary: "Origin" };

      if (req.method === "OPTIONS") {
        res.writeHead(204, cors);
        res.end();
        return;
      }

      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== callbackPath) {
        res.writeHead(404, cors);
        res.end("Not Found");
        return;
      }

      // From here on, failures are reported to the platform's page (a 302 it follows),
      // never as a page we render — that is what closes out its sign-in UI.
      const u = url.searchParams.get("u");
      if (!u) {
        res.writeHead(302, { ...cors, Location: xiaomiMimoPlatformCallbackUrl("error", "missing_data") });
        res.end();
        return;
      }

      // The callback URL carries no state param, so decryption is attributed purely by
      // "which pending key opens the payload" — see completeXiaomiMimoFlow.
      const pendingSessions = [...xiaomiMimoSessions.entries()]
        .filter(([, s]) => s.status === "pending");

      try {
        const outcome = await completeXiaomiMimoFlow(u);
        if (!outcome.ok) {
          throw new Error(
            outcome.error === "missing_api_key"
              ? "Decrypted payload missing sk (API key)"
              : "Could not decrypt with any pending session key",
          );
        }

        res.writeHead(302, { ...cors, Location: xiaomiMimoPlatformCallbackUrl("success") });
        res.end();
        console.log("[xiaomi-mimo oauth] callback decrypted");
      } catch (err) {
        console.error("[xiaomi-mimo oauth] decrypt failed:", err.message);
        // The callback URL carries no state, so a failure cannot be attributed
        // to a specific session. With a single pending session the attribution
        // is still unambiguous, so surface the error there. With several in
        // flight, marking them all would let one stray local request abort
        // every concurrent login — fail just this request and leave the
        // sessions pending so the UI can retry.
        if (pendingSessions.length === 1) {
          const [, only] = pendingSessions[0];
          only.status = "error";
          only.error = err.message;
        }
        res.writeHead(302, { ...cors, Location: xiaomiMimoPlatformCallbackUrl("error", "decrypt_failed") });
        res.end();
      }
    });

    server.on("error", (err) => {
      console.log("[xiaomi-mimo oauth] listen error:", err.message);
      resolve({ success: false, reason: err.message });
    });

    server.listen(0, "127.0.0.1", () => {
      xiaomiMimoProxyServer = server;
      xiaomiMimoProxyPort = server.address().port;
      xiaomiMimoProxyTimeout = setTimeout(() => {
        console.log("[xiaomi-mimo oauth] timeout, stopping");
        stopXiaomiMimoProxy();
      }, XIAOMI_MIMO_CONFIG.timeoutMs);
      console.log(`[xiaomi-mimo oauth] listening on port ${xiaomiMimoProxyPort}`);
      resolve({
        success: true,
        port: xiaomiMimoProxyPort,
        callbackUrl: `http://127.0.0.1:${xiaomiMimoProxyPort}${callbackPath}`,
      });
    });
  });
}

export function stopXiaomiMimoProxy() {
  console.log(`[xiaomi-mimo oauth] stopping (port ${xiaomiMimoProxyPort || "-"})`);
  if (xiaomiMimoProxyTimeout) { clearTimeout(xiaomiMimoProxyTimeout); xiaomiMimoProxyTimeout = null; }
  if (xiaomiMimoProxyServer) { xiaomiMimoProxyServer.close(); xiaomiMimoProxyServer = null; }
  xiaomiMimoProxyPort = null;
  // A new listener gets a fresh secret path.
  xiaomiMimoCallbackPath = null;
  // Stop LISTENING only. The local listener is the automatic callback path; the
  // platform's authorize page also shows a code for the user to paste by hand, and
  // that path is still perfectly usable after this listener is gone. Dropping the
  // pending keys here (as this used to) meant a pasted code failed with "this code
  // does not match this sign-in" the moment the 5-minute listener timed out — i.e.
  // exactly when a user gives up on the callback and reaches for the paste box.
  // registerXiaomiMimoSession() is what bounds the map, by pendingTtlMs.
}

