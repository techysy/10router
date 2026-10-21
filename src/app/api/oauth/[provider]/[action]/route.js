import { NextResponse } from "next/server";
import crypto from "node:crypto";
import {
  getProvider,
  generateAuthData,
  exchangeTokens,
  requestDeviceCode,
  pollForToken
} from "@/lib/oauth/providers";
import { createProviderConnection } from "@/models";
import {
  startCodexProxy,
  stopCodexProxy,
  registerCodexSession,
  getCodexSessionStatus,
  clearCodexSession,
  startXaiProxy,
  stopXaiProxy,
  registerXaiSession,
  getXaiSessionStatus,
  clearXaiSession,
  startTraeProxy,
  stopTraeProxy,
  registerTraeSession,
  getTraeSessionStatus,
  clearTraeSession,
  startLobsterAiProxy,
  stopLobsterAiProxy,
  registerLobsterAiSession,
  getLobsterAiSessionStatus,
  clearLobsterAiSession,
  startWindsurfProxy,
  stopWindsurfProxy,
  registerWindsurfSession,
  getWindsurfSessionStatus,
  clearWindsurfSession,
  startZedProxy,
  stopZedProxy,
  registerZedSession,
  getZedSessionStatus,
  clearZedSession,
  startXiaomiMimoProxy,
  stopXiaomiMimoProxy,
  registerXiaomiMimoSession,
  getXiaomiMimoSessionStatus,
  clearXiaomiMimoSession,
  completeXiaomiMimoFlow,
  startCodeArtsProxy,
  stopCodeArtsProxy,
  registerCodeArtsLoginSession,
  getCodeArtsSessionStatus,
  clearCodeArtsSession,
} from "@/lib/oauth/utils/server";

// OfficeAce authorizes by cloud-side state polling (no loopback): this map keeps
// the transient poll state so concurrent UI polls do not claim twice.
const officeAcePollSessions = new Map();
import { detectIdeInstalled } from "@/lib/oauth/utils/ideDetect";
import { ZED_HOSTED_CONFIG } from "@/lib/oauth/constants/oauth";

async function completeXaiManualCode(code, state) {
  const session = state ? getXaiSessionStatus(state) : null;
  if (!session) {
    throw new Error("xAI OAuth session not found; restart the login flow and paste the code again");
  }
  if (!code) throw new Error("Missing xAI authorization code");

  try {
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
    clearXaiSession(state);
    stopXaiProxy();
    return {
      id: connection.id,
      provider: connection.provider,
      email: connection.email,
      displayName: connection.displayName,
    };
  } catch (err) {
    clearXaiSession(state);
    stopXaiProxy();
    throw err;
  }
}

/**
 * Dynamic OAuth API Route
 * Handles: authorize, exchange, device-code, poll
 */

// The Xiaomi MiMo cards share this one custom ECDH flow: `xiaomi-mimo` (cloud
// models) and `mimo-desktop` (account-session models, split out 2026-09-22). The
// flow is addressed by provider id in the URL, so both ids must take the SAME
// branches — while connections are created under whichever card the caller used,
// never a hardcoded id, or the two cards would end up sharing one row.
const XIAOMI_MIMO_PROVIDERS = new Set(["xiaomi-mimo", "mimo-desktop"]);
const isXiaomiMimo = (p) => XIAOMI_MIMO_PROVIDERS.has(p);

// GET /api/oauth/[provider]/authorize - Generate auth URL
// GET /api/oauth/[provider]/device-code - Request device code (for device_code flow)
export async function GET(request, { params }) {
  try {
    const { provider, action } = await params;
    const { searchParams } = new URL(request.url);

    if (action === "authorize") {
      // Xiaomi MiMo: custom ECDH flow. Start the local callback proxy, mint an
      // X25519 keypair and register it against the state the client generated.
      if (isXiaomiMimo(provider)) {
        const state = searchParams.get("state");
        if (!state) {
          return NextResponse.json({ error: "Missing state" }, { status: 400 });
        }
        const started = await startXiaomiMimoProxy();
        if (!started.success) {
          return NextResponse.json({ error: started.reason || "Failed to start callback listener" }, { status: 500 });
        }
        const { generateKeyPair, buildAuthorizeUrl, buildManualAuthorizeUrl, getKeyName } =
          await import("@/lib/oauth/providers/xiaomi-mimo.js");
        const { publicKey, privateKeyDer } = generateKeyPair();
        registerXiaomiMimoSession({ state, privateKeyDer });
        const keyName = getKeyName();
        return NextResponse.json({
          authorizeUrl: buildAuthorizeUrl(publicKey, started.callbackUrl, keyName),
          // The platform's code-display page. Official clients surface both and let the
          // user fall back to copying a code when the localhost callback is unreachable.
          manualUrl: buildManualAuthorizeUrl(publicKey, keyName),
          callbackUrl: started.callbackUrl,
          state,
        });
      }

      // OfficeAce: cloud-side state polling (PKCE+DPoP live in the provider module).
      if (provider === "officeace") {
        const { startLogin } = await import("@/lib/oauth/providers/officeace.js");
        const started = await startLogin({});
        return NextResponse.json({
          authUrl: started.authorizeUrl,
          state: started.state,
          pollIntervalMs: 2500,
          flowType: "cloud_poll",
        });
      }
      // CodeArts: portal accepts only the loopback port; PKCE + DPoP key live in
      // the server-side session keyed by state.
      if (provider === "codearts") {
        const [{ generatePKCE }, { buildAuthorizeUrl, generateDpopKeyPair }] = await Promise.all([
          import("@/lib/oauth/utils/pkce.js"),
          import("@/lib/oauth/providers/codearts.js"),
        ]);
        const redirectUri = searchParams.get("redirect_uri") || "http://127.0.0.1:0/oauth/callback";
        const state = crypto.randomUUID();
        const { codeVerifier, codeChallenge } = generatePKCE();
        const keys = generateDpopKeyPair();
        registerCodeArtsLoginSession({ state, verifier: codeVerifier, dpopPrivateKeyPem: keys.privateKeyPem, redirectUri });
        return NextResponse.json({
          authUrl: buildAuthorizeUrl({ redirectUri, state, pkceChallenge: codeChallenge }),
          state,
          callbackPath: "/oauth/callback",
        });
      }
      // Raccoon: official page redirects to the office-raccoon:// custom scheme;
      // the user pastes that callback back (manual-code path).
      if (provider === "raccoon") {
        const { buildAuthorizeUrl } = await import("@/lib/oauth/providers/raccoon.js");
        const state = crypto.randomUUID();
        return NextResponse.json({ authUrl: buildAuthorizeUrl({ state }), state, flowType: "manual_callback" });
      }
      const redirectUri = searchParams.get("redirect_uri") || "http://localhost:8080/callback";
      // Collect provider-specific meta params (e.g. gitlab passes baseUrl, clientId, clientSecret)
      const reservedParams = new Set(["redirect_uri"]);
      const meta = {};
      searchParams.forEach((value, key) => { if (!reservedParams.has(key)) meta[key] = value; });
      // Zed: derive native_app_port from the local callback URL so the RSA keypair
      // is bound to the port the proxy is actually listening on.
      if (provider === "zed") {
        try { const p = new URL(redirectUri).port; if (p) meta.nativeAppPort = p; } catch { /* ignore */ }
      }
      const authData = await generateAuthData(provider, redirectUri, Object.keys(meta).length ? meta : undefined);
      return NextResponse.json(authData);
    }

    if (action === "start-proxy") {
      // Trae/Windsurf/Zed use a dynamic-port local callback server (singleton session,
      // state is registered separately via /register-session after /authorize).
      if (provider === "trae") {
        const result = await startTraeProxy();
        return NextResponse.json(result);
      }
      if (provider === "lobsterai") {
        const result = await startLobsterAiProxy();
        return NextResponse.json(result);
      }
      if (provider === "codearts") {
        const result = await startCodeArtsProxy();
        return NextResponse.json(result);
      }
      if (provider === "windsurf") {
        const result = await startWindsurfProxy();
        return NextResponse.json(result);
      }
      if (provider === "zed") {
        // Prefer ZED_HOSTED_CONFIG.defaultNativeAppPort (58443) so the browser redirect
        // matches what Zed expects; falls back to a random port if it's busy.
        const result = await startZedProxy(searchParams.get("native_app_port") || ZED_HOSTED_CONFIG.defaultNativeAppPort);
        return NextResponse.json(result);
      }
      if (!["codex", "xai"].includes(provider)) {
        return NextResponse.json({ error: "Proxy only supported for codex/xai/trae/windsurf/zed" }, { status: 400 });
      }
      const appPort = searchParams.get("app_port");
      if (!appPort) {
        return NextResponse.json({ error: "Missing app_port" }, { status: 400 });
      }
      const state = searchParams.get("state");
      const codeVerifier = searchParams.get("code_verifier");
      const redirectUri = searchParams.get("redirect_uri");
      const result = provider === "xai"
        ? await startXaiProxy(Number(appPort))
        : await startCodexProxy(Number(appPort));
      let serverSide = false;
      if (result.success && state && codeVerifier && redirectUri) {
        serverSide = provider === "xai"
          ? registerXaiSession({ state, codeVerifier, redirectUri })
          : registerCodexSession({ state, codeVerifier, redirectUri });
      }
      return NextResponse.json({ ...result, serverSide });
    }

    if (action === "poll-status") {
      const state = searchParams.get("state");
      if (!state) {
        return NextResponse.json({ error: "Missing state" }, { status: 400 });
      }
      // OfficeAce: advance the cloud-side authorization poll; on 200 finish the
      // login and create the connection exactly once.
      if (provider === "officeace") {
        const { pollAuthorization, finishLogin, forgetLoginSession } = await import("@/lib/oauth/providers/officeace.js");
        let oa = officeAcePollSessions.get(state);
        if (!oa) { oa = { state, status: "pending", createdAt: Date.now() }; officeAcePollSessions.set(state, oa); }
        if (oa.status === "done") {
          return NextResponse.json({ status: "done", connectionId: oa.connectionId, email: oa.email });
        }
        const polled = await pollAuthorization(state);
        if (polled.status === "pending") return NextResponse.json({ status: "pending" });
        if (polled.status === "expired") {
          forgetLoginSession(state);
          officeAcePollSessions.delete(state);
          return NextResponse.json({ status: "error", error: polled.error || "授权已过期，请重新登录" });
        }
        try {
          const creds = await finishLogin({ state, code: polled.code });
          const connection = await createProviderConnection({
            provider: "officeace",
            authType: "oauth",
            ...creds,
            // Gateway Basic never expires; the control-plane STS expiry lives in psd.
            expiresAt: null,
            testStatus: "active",
          });
          oa.status = "done";
          oa.connectionId = connection.id;
          oa.email = connection.email;
          return NextResponse.json({ status: "done", connectionId: connection.id, email: connection.email });
        } catch (err) {
          officeAcePollSessions.delete(state);
          return NextResponse.json({ status: "error", error: err?.message || String(err) });
        }
      }
      let session;
      if (provider === "trae") session = getTraeSessionStatus(state);
      else if (provider === "lobsterai") session = getLobsterAiSessionStatus(state);
      else if (provider === "windsurf") session = getWindsurfSessionStatus(state);
      else if (provider === "zed") session = getZedSessionStatus(state);
      else if (provider === "xai") session = getXaiSessionStatus(state);
      else if (provider === "codex") session = getCodexSessionStatus(state);
      else if (provider === "codearts") session = getCodeArtsSessionStatus(state);
      else if (isXiaomiMimo(provider)) {
        const xm = getXiaomiMimoSessionStatus(state);
        if (!xm) return NextResponse.json({ status: "unknown" });
        if (xm.status === "done" && xm.result) {
          // Redact the credential: the API key stays on the server and is applied
          // by /exchange, so it never has to reach the browser. The session is kept
          // until exchange consumes it (unlike the code-based flows above).
          return NextResponse.json({ status: xm.status, result: { uid: xm.result.uid, baseUrl: xm.result.baseUrl } });
        }
        if (xm.status === "error") {
          const payload = { status: xm.status, error: xm.error };
          clearXiaomiMimoSession(state);
          return NextResponse.json(payload);
        }
        return NextResponse.json({ status: xm.status });
      }
      else return NextResponse.json({ error: "Poll only supported for codex/xai/trae/windsurf/zed/lobsterai" }, { status: 400 });
      if (!session) return NextResponse.json({ status: "unknown" });
      if (session.status === "done" || session.status === "error") {
        // CodeArts sessions carry the PKCE verifier and the DPoP private key;
        // never serialize them to the browser.
        const payload = provider === "codearts"
          ? { status: session.status, error: session.error, connectionId: session.connectionId, email: session.email }
          : { ...session };
        if (provider === "trae") clearTraeSession(state);
        else if (provider === "lobsterai") clearLobsterAiSession(state);
        else if (provider === "windsurf") clearWindsurfSession(state);
        else if (provider === "zed") clearZedSession(state);
        else if (provider === "codearts") clearCodeArtsSession(state);
        else if (provider === "xai") clearXaiSession(state);
        else clearCodexSession(state);
        return NextResponse.json(payload);
      }
      return NextResponse.json({ status: session.status });
    }

    if (action === "stop-proxy") {
      if (provider === "trae") stopTraeProxy();
      else if (provider === "lobsterai") stopLobsterAiProxy();
      else if (provider === "windsurf") stopWindsurfProxy();
      else if (provider === "zed") stopZedProxy();
      else if (provider === "codearts") stopCodeArtsProxy();
      else if (provider === "xai") stopXaiProxy();
      else if (provider === "codex") stopCodexProxy();
      else if (isXiaomiMimo(provider)) stopXiaomiMimoProxy();
      else return NextResponse.json({ error: "Proxy only supported for codex/xai/trae/windsurf/zed/lobsterai" }, { status: 400 });
      return NextResponse.json({ success: true });
    }

    if (action === "ide-status") {
      // Detect whether the IDE is installed locally (used by import-token UX).
      if (provider !== "trae" && provider !== "windsurf") {
        return NextResponse.json({ error: "ide-status only supported for trae/windsurf" }, { status: 400 });
      }
      const status = await detectIdeInstalled(provider);
      return NextResponse.json(status);
    }

    if (action === "device-code") {
      const providerData = getProvider(provider);
      if (providerData.flowType !== "device_code") {
        return NextResponse.json({ error: "Provider does not support device code flow" }, { status: 400 });
      }

      const authData = await generateAuthData(provider, null);
      const startUrl = searchParams.get("start_url");
      const region = searchParams.get("region");
      const authMethod = searchParams.get("auth_method");
      const deviceOptions = provider === "kiro"
        ? {
            ...(startUrl ? { startUrl } : {}),
            ...(region ? { region } : {}),
            ...(authMethod ? { authMethod } : {}),
          }
        : undefined;
      
      // Providers that don't use PKCE for device code (Grok CLI HAR: plain device_code, no challenge)
      const noPkceDeviceProviders = [
        "github",
        "kiro",
        "kimi",
        "kimi-coding",
        "kilocode",
        "codebuddy-cn",
        "codebuddy-intl",
        "qoder",
        "qoder-cn",
        "grok-cli",
        "glm",
        "muse",
        "atomcode",
      ];
      let deviceData;
      if (noPkceDeviceProviders.includes(provider)) {
        deviceData = await requestDeviceCode(provider, undefined, deviceOptions);
      } else {
        // Qwen and other PKCE providers
        deviceData = await requestDeviceCode(provider, authData.codeChallenge, deviceOptions);
      }

      return NextResponse.json({
        ...deviceData,
        // Prefer the verifier the provider's requestDeviceCode generated for
        // itself (qoder rolls its own PKCE pair); fall back to the generic one.
        codeVerifier: deviceData.codeVerifier || authData.codeVerifier,
      });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    console.log("OAuth GET error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// POST /api/oauth/[provider]/exchange - Exchange code for tokens and save
// POST /api/oauth/[provider]/poll - Poll for token (device_code flow)
export async function POST(request, { params }) {
  try {
    const { provider, action } = await params;

    // Zero-body actions (check-in, claim-compensation) don't require JSON payloads
    if (action === "checkin") {
      if (provider === "codebuddy-cn") {
        const { runCodebuddyCheckinTick } = await import("@/sse/services/codebuddyCheckin.js");
        const results = await runCodebuddyCheckinTick();
        return NextResponse.json({ success: true, results });
      }
      if (provider === "qoder" || provider === "qoder-cn") {
        const { claimAllQoderAccounts } = await import("@/sse/services/qoderCheckin.js");
        const results = await claimAllQoderAccounts(provider);
        return NextResponse.json({ success: true, results });
      }
      // 签到只对订阅线开放。minimax-free 是免登录网关线,签到在 CreditDaddy
      // 内闭环——这里不认它,卡面也不渲染签到按钮(issue #75)。
      if (provider === "minimax-code" || provider === "minimax-code-global") {
        const { runMinimaxCheckinTick } = await import("@/sse/services/minimaxCheckin.js");
        const results = await runMinimaxCheckinTick({ skipIfCheckedToday: false, provider });
        return NextResponse.json({ success: true, results });
      }
      return NextResponse.json({ error: `Check-in not supported for ${provider}` }, { status: 400 });
    }

    if (action === "claim-compensation") {
      if (provider === "codebuddy-cn") {
        const { runCodebuddyCompensationTick } = await import("@/sse/services/codebuddyCheckin.js");
        const results = await runCodebuddyCompensationTick();
        return NextResponse.json({ success: true, results });
      }
      return NextResponse.json({ error: `Claim compensation not supported for ${provider}` }, { status: 400 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid or empty request body" }, { status: 400 });
    }

    if (action === "register-session") {
      // Register proxy session out of URL query (state) + body (codeVerifier).
      // Zed's codeVerifier encodes the RSA private key — must stay out of URL/logs.
      const searchParams = new URL(request.url).searchParams;
      const state = searchParams.get("state") || body?.state;
      if (!state) return NextResponse.json({ error: "Missing state" }, { status: 400 });
      let ok = false;
      if (provider === "trae") ok = registerTraeSession({ state });
      else if (provider === "lobsterai") ok = registerLobsterAiSession({ state });
      else if (provider === "codearts") ok = !!getCodeArtsSessionStatus(state);
      else if (provider === "windsurf") ok = registerWindsurfSession({ state });
      else if (provider === "zed") ok = registerZedSession({ state, codeVerifier: body?.codeVerifier });
      else return NextResponse.json({ error: "register-session only supported for trae/windsurf/zed/lobsterai" }, { status: 400 });
      return NextResponse.json({ success: ok });
    }

    if (action === "submit-code") {
      // Xiaomi MiMo: the platform's authorize page may SHOW A CODE instead of calling
      // our localhost redirect, so the user has to paste it back. That code is the very
      // same ECDH+AES-GCM payload the callback carries, so it goes through the same
      // decrypt-and-store path (see completeXiaomiMimoFlow).
      if (!isXiaomiMimo(provider)) {
        return NextResponse.json({ error: "submit-code only supported for the Xiaomi MiMo cards" }, { status: 400 });
      }

      const outcome = await completeXiaomiMimoFlow(body?.code);
      if (!outcome.ok) {
        // These are shown verbatim in the modal, so they must say what to DO next:
        // a decryption failure is almost always a copy problem (a truncated blob or
        // a label copied along with it), never a permission problem.
        const messages = {
          empty_payload: "Paste the authorization code first.",
          payload_too_short:
            "That is too short to be the whole code — it is usually a long string of 100+ characters. Use the Copy button on the sign-in page, then paste it here.",
          no_pending_session:
            "This sign-in attempt is no longer active. Click Sign in via Browser to start again.",
          decrypt_failed:
            "That code does not match this sign-in. Copy the whole code from the sign-in page, or click Sign in via Browser for a fresh one.",
          missing_api_key: "That code did not contain an API key. Start the sign-in again.",
        };
        return NextResponse.json(
          { status: "error", error: messages[outcome.error] || "Could not read that code." },
          { status: 400 },
        );
      }

      // The payload carries no state, so report which session matched: the client needs
      // it for /exchange, which applies the sk- key server-side (it never reaches the
      // browser — see the poll-status branch for the same redaction rule).
      return NextResponse.json({
        status: "done",
        state: outcome.state,
        result: { uid: outcome.result.uid, baseUrl: outcome.result.baseUrl },
      });
    }

    if (action === "send-sms-code") {
      const { phone, ccode } = body || {};
      const { sendSmsCode } = await import("@/lib/oauth/providers/loomy.js");
      const result = await sendSmsCode({ phone, ccode });
      return NextResponse.json({ success: true, ...result });
    }

    if (action === "verify-sms-code") {
      const { phone, code, msgid, ccode } = body || {};
      const { verifySmsCode, mapTokens } = await import("@/lib/oauth/providers/loomy.js");
      const tokens = await verifySmsCode({ phone, code, msgid, ccode });
      const mapped = mapTokens(tokens);
      const expiresAt = mapped.expiresAt
        || (mapped.expiresIn ? new Date(Date.now() + mapped.expiresIn * 1000).toISOString() : null);
      const connection = await createProviderConnection({
        provider: "loomy",
        authType: "oauth",
        ...mapped,
        expiresAt,
        testStatus: "active",
      });
      return NextResponse.json({ success: true, connectionId: connection.id, email: connection.email });
    }

    if (action === "exchange") {
      const { code, redirectUri, codeVerifier, state, meta } = body;

      // Raccoon: manual callback / bare code, exchanged and stored here.
      if (provider === "raccoon") {
        const { parseCallbackUrl, exchangeCode } = await import("@/lib/oauth/providers/raccoon.js");
        const parsed = parseCallbackUrl(code, state);
        if (!parsed.ok) return NextResponse.json({ error: parsed.error || "Invalid callback" }, { status: 400 });
        const tokenData = await exchangeCode(parsed.code);
        const connection = await createProviderConnection({
          provider: "raccoon",
          authType: "oauth",
          ...tokenData,
          expiresAt: tokenData.expiresAt ? new Date(tokenData.expiresAt).toISOString() : null,
          testStatus: "active",
        });
        return NextResponse.json({ success: true, connectionId: connection.id, email: connection.email });
      }

      // CodeArts: popup-blocked fallback — the pasted callback is exchanged with
      // the verifier/DPoP key registered by /authorize.
      if (provider === "codearts") {
        const session = state ? getCodeArtsSessionStatus(state) : null;
        if (session?.status === "done") {
          clearCodeArtsSession(state);
          return NextResponse.json({ success: true, connectionId: session.connectionId });
        }
        if (!session) {
          return NextResponse.json({ error: "CodeArts login session not found; restart the login flow" }, { status: 400 });
        }
        const { parseLoopbackCallback, exchangeCode } = await import("@/lib/oauth/providers/codearts.js");
        let parsed = null;
        try { parsed = parseLoopbackCallback(code, state); } catch { parsed = null; }
        if (!parsed?.code) return NextResponse.json({ error: "No authorization code in the pasted callback" }, { status: 400 });
        const tokenData = await exchangeCode({
          code: parsed.code,
          codeVerifier: session.verifier,
          dpopPrivateKeyPem: session.dpopPrivateKeyPem,
          redirectUri: session.redirectUri,
        });
        const connection = await createProviderConnection({
          provider: "codearts",
          authType: "oauth",
          ...tokenData,
          expiresAt: tokenData.expiresIn ? new Date(Date.now() + tokenData.expiresIn * 1000).toISOString() : null,
          testStatus: "active",
        });
        session.status = "done";
        session.connectionId = connection.id;
        return NextResponse.json({ success: true, connectionId: connection.id, email: connection.email });
      }

      // Xiaomi MiMo: the decrypted session already holds the sk- key server-side.
      if (isXiaomiMimo(provider)) {
        if (!state) return NextResponse.json({ error: "Missing state" }, { status: 400 });
        const session = getXiaomiMimoSessionStatus(state);
        if (!session || session.status !== "done" || !session.result?.accessToken) {
          return NextResponse.json({ error: "OAuth session not completed" }, { status: 400 });
        }
        try {
          // Which card this browser sign-in was started from. The account session
          // (passToken) belongs ONLY to the `mimo-desktop` card: folding it into
          // the cloud card's row is what made its connection advertise a Desktop
          // session it does not own (the "客户端会话" badge, and a weekly quota
          // read from this machine's Desktop cookie store). The cloud card keeps
          // the sk- key and nothing else; the executor never reads a stored
          // passToken on it, and the Desktop card falls back to the machine
          // cookie store on its own.
          const isDesktopCard = provider === "mimo-desktop";

          let desktopSession = null;
          if (isDesktopCard) {
            try {
              const { readDesktopPassToken } = await import("open-sse/shared/mimoAccount.js");
              desktopSession = await readDesktopPassToken();
            } catch {
              // Desktop locked / not installed — the import still stores what
              // the browser flow returned; the session can come from the
              // Desktop card's own import path later.
            }
          }

          const uid = session.result.uid || null;
          const sessionExtras = desktopSession?.passToken
            ? {
                mimoPassToken: desktopSession.passToken,
                mimoUserId: desktopSession.userId || null,
                mimoCUserId: desktopSession.cUserId || null,
              }
            : {};

          // Merge into an existing row for the same Xiaomi account (e.g. the
          // session-only connection created by the Desktop QR import) instead
          // of stacking a second connection. Identity matching is shared with
          // the api-key route so both paths agree — and the mimoUserId fallback
          // covers payloads where the platform omits uid.
          const { getProviderConnections, updateProviderConnection } = await import("@/models");
          const { findXiaomiConnection } = await import("@/lib/oauth/xiaomiIdentity.js");
          const existing = findXiaomiConnection(
            await getProviderConnections({ provider }),
            {
              uid,
              key: session.result.accessToken,
              // The desktop session read above may know the account even when
              // the browser payload does not carry a uid.
              mimoUserId: desktopSession?.userId || null,
            },
          );

          // Merged base psd for the update path. On the cloud card, also drop
          // any session fields an older build folded into the row — the
          // {...existing} spread would otherwise carry them straight back in.
          const existingPsd = { ...(existing?.providerSpecificData || {}) };
          if (!isDesktopCard) {
            delete existingPsd.mimoPassToken;
            delete existingPsd.mimoUserId;
            delete existingPsd.mimoCUserId;
          }

          const connection = existing
            ? await updateProviderConnection(existing.id, {
                accessToken: session.result.accessToken,
                providerSpecificData: {
                  ...existingPsd,
                  uid,
                  baseUrl: session.result.baseUrl || "https://api.xiaomimimo.com/v1",
                  authMethod: "oauth",
                  // The Desktop label only ever belongs on the Desktop card —
                  // on a cloud row it claimed a session that card does not own.
                  ...(isDesktopCard ? { provider: "Xiaomi MiMo Desktop" } : {}),
                  ...sessionExtras,
                },
                testStatus: "active",
                // Browser re-authorize supersedes the stored failure text.
                resetErrorState: true,
              })
            : await createProviderConnection({
                provider,
                authType: "api_key",
                accessToken: session.result.accessToken,
                refreshToken: null,
                expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
                email: uid ? `${uid}@xiaomi` : null,
                displayName: uid ? `Xiaomi ${uid}` : "Xiaomi MiMo",
                providerSpecificData: {
                  uid,
                  baseUrl: session.result.baseUrl || "https://api.xiaomimimo.com/v1",
                  authMethod: "oauth",
                  ...(isDesktopCard ? { provider: "Xiaomi MiMo Desktop" } : {}),
                  ...sessionExtras,
                },
                testStatus: "active",
              });
          clearXiaomiMimoSession(state);
          stopXiaomiMimoProxy();
          return NextResponse.json({
            success: true,
            connection: {
              id: connection.id,
              provider: connection.provider,
              email: connection.email,
              displayName: connection.displayName,
            },
          });
        } catch (err) {
          return NextResponse.json({ error: err.message }, { status: 500 });
        }
      }

      // Trae/Windsurf: code is either a raw callback URL or a pasted token.
      // exchangeTokens() handles both paths; no PKCE, skip codex JWT extraction.
      if (provider === "trae" || provider === "windsurf") {
        const token = typeof code === "string" ? code.trim() : "";
        if (!token) {
          return NextResponse.json({ error: "Missing token or callback URL" }, { status: 400 });
        }
        try {
          const tokenData = await exchangeTokens(provider, token, null, null, state);
          const connection = await createProviderConnection({
            provider,
            authType: provider === "windsurf" ? "api_key" : "oauth",
            ...tokenData,
            expiresAt: tokenData.expiresIn
              ? new Date(Date.now() + tokenData.expiresIn * 1000).toISOString()
              : null,
            testStatus: "active",
          });
          return NextResponse.json({
            success: true,
            connection: {
              id: connection.id,
              provider: connection.provider,
              email: connection.email,
              displayName: connection.displayName,
            }
          });
        } catch (err) {
          return NextResponse.json({ error: err.message }, { status: 500 });
        }
      }

      // Detect if "code" is actually a raw JWT access token (starts with eyJ)
      if (code && code.startsWith("eyJ") && code.includes(".")) {
        const { extractCodexAccountInfo } = await import("@/lib/oauth/providers");
        const info = extractCodexAccountInfo(code);

        // Also decode JWT directly for ChatGPT website tokens which use
        // top-level account_id/plan_type instead of nested openai auth claims
        let directPayload = {};
        try {
          const b64 = code.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
          const padded = b64 + "=".repeat((4 - b64.length % 4) % 4);
          directPayload = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
        } catch {}

        const accountId = info.chatgptAccountId || directPayload.account_id;
        const planType = info.chatgptPlanType || directPayload.plan_type;
        const email = info.email || directPayload.email;

        const providerSpecificData = { authMethod: "access_token" };
        if (accountId) providerSpecificData.chatgptAccountId = accountId;
        if (planType) providerSpecificData.chatgptPlanType = planType;

        const connection = await createProviderConnection({
          provider,
          authType: "access_token",
          accessToken: code,
          email: email || null,
          providerSpecificData,
          testStatus: "active",
        });

        return NextResponse.json({
          success: true,
          connection: {
            id: connection.id,
            provider: connection.provider,
            email: connection.email,
            displayName: connection.displayName,
          }
        });
      }

      // Cline and ClinePass use authorization_code without PKCE. Kimchi returns a browser token.
      const noPkceExchangeProviders = ["cline", "clinepass", "kimchi"];
      if (!code || !redirectUri || (!codeVerifier && !noPkceExchangeProviders.includes(provider))) {
        return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
      }

      // Exchange code for tokens (meta carries provider-specific params, e.g. gitlab clientId/baseUrl)
      const tokenData = await exchangeTokens(provider, code, redirectUri, codeVerifier, state, meta);

      // Save to database
      const connection = await createProviderConnection({
        provider,
        authType: "oauth",
        ...tokenData,
        expiresAt: tokenData.expiresIn 
          ? new Date(Date.now() + tokenData.expiresIn * 1000).toISOString() 
          : null,
        testStatus: "active",
      });

      return NextResponse.json({ 
        success: true, 
        connection: {
          id: connection.id,
          provider: connection.provider,
          email: connection.email,
          displayName: connection.displayName,
        }
      });
    }

    if (action === "poll") {
      const { deviceCode, codeVerifier, extraData } = body;

      if (!deviceCode) {
        return NextResponse.json({ error: "Missing device code" }, { status: 400 });
      }

      // Providers that don't use PKCE for device code
      const noPkceProviders = ["github", "kimi", "kimi-coding", "kilocode", "codebuddy-cn", "codebuddy-intl", "glm", "muse", "atomcode"];
      let result;
      if (noPkceProviders.includes(provider)) {
        // kimi needs extraData._kimiDeviceId for stable X-Msh-Device-Id (CLIProxyAPI parity);
        // glm needs extraData._zcodePollToken (ZCode CLI 轮询会话凭证)
        result = await pollForToken(provider, deviceCode, null, extraData);
      } else if (provider === "kiro") {
        // Kiro needs extraData (clientId, clientSecret) from device code response
        result = await pollForToken(provider, deviceCode, null, extraData);
      } else if (provider === "qoder" || provider === "qoder-cn") {
        // Qoder needs both the PKCE verifier (codeVerifier) and the machineId
        // captured at device-code time (extraData._qoderMachineId) so
        // mapTokens can persist it for COSY signing.
        if (!codeVerifier) {
          return NextResponse.json({ error: "Missing code verifier" }, { status: 400 });
        }
        result = await pollForToken(provider, deviceCode, codeVerifier, extraData);
      } else {
        // Qwen and other PKCE providers
        if (!codeVerifier) {
          return NextResponse.json({ error: "Missing code verifier" }, { status: 400 });
        }
        result = await pollForToken(provider, deviceCode, codeVerifier);
      }

      if (result.success) {
        // Save to database (legacy kimi-coding OAuth → dual-auth kimi)
        const providerId = provider === "kimi-coding" ? "kimi" : provider;
        const connection = await createProviderConnection({
          provider: providerId,
          authType: "oauth",
          ...result.tokens,
          expiresAt: result.tokens.expiresIn 
            ? new Date(Date.now() + result.tokens.expiresIn * 1000).toISOString() 
            : null,
          testStatus: "active",
        });

        return NextResponse.json({ 
          success: true, 
          connection: {
            id: connection.id,
            provider: connection.provider,
          }
        });
      }

      // Still pending or error - don't create connection for pending states
      const isPending = result.pending || result.error === "authorization_pending" || result.error === "slow_down";
      
      return NextResponse.json({
        success: false,
        error: result.error,
        errorDescription: result.errorDescription,
        pending: isPending,
        // fatal：不可恢复（如登录后交换失败）——客户端必须停止轮询并展示错误
        ...(result.fatal ? { fatal: true } : {}),
      });
    }

    if (action === "manual-code") {
      if (provider !== "xai") {
        return NextResponse.json({ error: "Manual code only supported for xai" }, { status: 400 });
      }
      const { code, state } = body;
      const connection = await completeXaiManualCode(String(code || "").trim(), String(state || "").trim());
      return NextResponse.json({ success: true, connection });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    console.log("OAuth POST error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
