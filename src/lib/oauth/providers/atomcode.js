// AtomCode (AtomGit) OAuth — broker-mediated, poll-based device-style login.
//
// There is no loopback callback: acs.atomgit.com terminates the authorization
// itself and the CLI polls `auth/check` until `valid`, then fetches the token
// bundle. `device_code` below is that broker `state`; there is no user code.
//
// Refresh rotates both tokens. `refreshAtomcodeToken` (named export) is also
// wired into open-sse/services/tokenRefresh so the gateway can renew without
// the user re-opening a browser.

import {
  atomcodeProviderTokens,
  pollAtomcodeLogin,
  refreshAtomcodeToken,
  startAtomcodeLogin,
} from "open-sse/shared/atomcode/oauth.js";
import { ATOMCODE_DEFAULT_BROKER_BASE } from "open-sse/shared/atomcode/constants.js";

const atomcode = {
  config: {
    brokerBaseUrl: ATOMCODE_DEFAULT_BROKER_BASE,
    provider: "atomgit",
  },
  flowType: "device_code",

  requestDeviceCode: async () => {
    const { loginUrl, state } = await startAtomcodeLogin();
    return {
      device_code: state,
      // The broker does not issue a short user code; the state is the only
      // correlation id, so do not display a fake one.
      user_code: "",
      verification_uri: loginUrl,
      verification_uri_complete: loginUrl,
      expires_in: 300,
      interval: 3,
    };
  },

  pollToken: async (config, deviceCode) => {
    if (!deviceCode) {
      return {
        ok: false,
        data: { error: "invalid_request", error_description: "Missing AtomCode login state" },
      };
    }
    try {
      const result = await pollAtomcodeLogin(deviceCode);
      if (result.pending) {
        return { ok: false, data: { error: "authorization_pending" } };
      }
      const bundle = result.bundle;
      return {
        ok: true,
        data: {
          access_token: bundle.accessToken,
          refresh_token: bundle.refreshToken,
          expires_in: bundle.expiresIn,
          _atomcodeUserId: bundle.userId,
          _atomcodeUsername: bundle.username,
          _atomcodeName: bundle.name,
          _atomcodeEmail: bundle.email,
          _atomcodeAvatar: bundle.avatarUrl,
        },
      };
    } catch (error) {
      // A transient broker failure must not end the user's login — the modal
      // keeps polling on non-fatal errors.
      return {
        ok: false,
        data: {
          error: error?.code === "invalid_grant" ? "expired_token" : "poll_failed",
          error_description: error?.message || String(error),
        },
      };
    }
  },

  mapTokens: (tokens) => atomcodeProviderTokens({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
    userId: tokens._atomcodeUserId,
    username: tokens._atomcodeUsername,
    name: tokens._atomcodeName,
    email: tokens._atomcodeEmail,
    avatarUrl: tokens._atomcodeAvatar,
  }),
};

/** Refresh helper for tokenRefresh/providers.js (returns connection shape). */
export async function refresh(refreshToken) {
  const bundle = await refreshAtomcodeToken(refreshToken);
  return {
    accessToken: bundle.accessToken,
    refreshToken: bundle.refreshToken || refreshToken,
    expiresIn: bundle.expiresIn || undefined,
    providerSpecificData: {
      ...(bundle.userId ? { userId: bundle.userId } : {}),
      ...(bundle.username ? { username: bundle.username } : {}),
    },
  };
}

export default atomcode;
