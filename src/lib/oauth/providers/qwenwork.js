import { QWENWORK_SITES } from "../../qwenwork/constants.js";

// QwenWork uses the Qoder-family device flow (PKCE + nonce + machine_id,
// poll until a device token appears) pointed at the QwenWork gateway,
// with client_id + redirect_uri on the authorization URL and the profile
// read from account-context. Both deployments share this implementation;
// only the site constants differ (see qwenwork-cn.js).
export function createQwenWorkProvider(siteKey) {
  const site = QWENWORK_SITES[siteKey];
  return {
    config: {
      loginUrl: site.loginUrl,
      deviceTokenUrl: site.deviceTokenUrl,
      userInfoUrl: site.userInfoUrl,
      refreshUrl: site.refreshTokenUrl,
      clientId: site.clientId,
      redirectUri: site.redirectUri,
    },
    flowType: "device_code",
    requestDeviceCode: async () => {
      const { QwenWorkService } = await import("@/lib/oauth/services/qwenwork");
      const flow = new QwenWorkService(site).initiateDeviceFlow();
      // Match the device_code shape the rest of the OAuthModal expects
      // (device_code, user_code, verification_uri[_complete], interval).
      // The poll endpoint identifies us by nonce+verifier, not by a
      // server-issued device_code, so we plumb our own values through:
      //   device_code   = nonce  (modal forwards as deviceCode on poll)
      //   codeVerifier  = our PKCE verifier (route forwards as codeVerifier)
      return {
        device_code: flow.nonce,
        user_code: flow.nonce.slice(0, 8).toUpperCase(),
        verification_uri: site.loginUrl,
        verification_uri_complete: flow.verificationUriComplete,
        expires_in: 300,
        interval: 2,
        codeVerifier: flow.codeVerifier,
        _qwenworkNonce: flow.nonce,
        _qwenworkMachineId: flow.machineId,
      };
    },
    pollToken: async (config, deviceCode, codeVerifier, extraData) => {
      const { QwenWorkService } = await import("@/lib/oauth/services/qwenwork");
      const svc = new QwenWorkService(site);
      const nonce = deviceCode || extraData?._qwenworkNonce;
      const verifier = codeVerifier || extraData?._qwenworkVerifier;
      if (!nonce || !verifier) {
        return {
          ok: false,
          data: { error: "invalid_request", error_description: "Missing nonce/verifier" },
        };
      }
      let result;
      try {
        result = await svc.pollDeviceToken({ nonce, codeVerifier: verifier });
      } catch (err) {
        return {
          ok: false,
          data: { error: "poll_failed", error_description: err.message },
        };
      }
      if (result.status === "pending") {
        return { ok: false, data: { error: "authorization_pending" } };
      }
      // Best-effort profile lookup so we have a name/email to display.
      const userInfo = await svc.fetchUserInfo(result.accessToken);
      // expireTime is a Unix-ms timestamp from QoderService.parseExpiry,
      // which falls back to "now + 30 days" when the upstream omits
      // expiry. Floor to a sane minimum (1 day) so a stale or skewed
      // upstream timestamp doesn't truncate the stored token.
      const minSeconds = 24 * 60 * 60;
      const remainingSeconds = Math.floor((result.expireTime - Date.now()) / 1000);
      const expiresIn = Math.max(minSeconds, remainingSeconds);
      return {
        ok: true,
        data: {
          access_token: result.accessToken,
          refresh_token: result.refreshToken,
          expires_in: expiresIn,
          _qwenworkUserId: result.userId,
          _qwenworkMachineId: extraData?._qwenworkMachineId || "",
          _qwenworkName: userInfo.name,
          _qwenworkEmail: userInfo.email,
          _qwenworkOrganizationId: userInfo.organizationId,
        },
      };
    },
    mapTokens: (tokens) => {
      const rawEmail = (tokens._qwenworkEmail || "").trim();
      const displayName = (tokens._qwenworkName || "").trim() || null;
      const userId = tokens._qwenworkUserId || "";
      // Dedup in createProviderConnection requires a non-empty email.
      // When fetchUserInfo silently fails (returns ""), fall back to a
      // stable synthetic identifier derived from userId so re-logins
      // update the existing row instead of accumulating duplicates.
      const email = rawEmail || (userId ? `qwenwork-user-${userId}` : null);
      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || null,
        expiresIn: tokens.expires_in,
        email,
        displayName,
        providerSpecificData: {
          authMethod: "device",
          userId,
          machineId: tokens._qwenworkMachineId || "",
          organizationId: tokens._qwenworkOrganizationId || "",
        },
      };
    },
  };
}

const qwenwork = createQwenWorkProvider("qwenwork");

export default qwenwork;
