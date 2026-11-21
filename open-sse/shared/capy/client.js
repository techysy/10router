/**
 * Capy.ai client — Clerk Native API (login/session) + private /app API.
 *
 * Credential model (maps onto 10router's OAuth connection shape):
 *   refreshToken  = Clerk client JWT containing rotating_token; rotated on
 *                   EVERY FAPI call — callers must persist the `rotatedJwt`
 *                   each call returns, or the stored credential dies.
 *   accessToken   = 60s session JWT minted via POST /v1/client/sessions/:sid/
 *                   tokens (Origin: capy://app → azp claim). Accepted by
 *                   api.capy.ai/app/*.
 */

import {
  CAPY_FAPI_BASE,
  CAPY_API_BASE,
  CAPY_APP_PREFIX,
  CAPY_ORIGIN,
  CAPY_CLERK_API_VERSION,
  CAPY_CLERK_JS_VERSION,
  CAPY_DEFAULT_TIMEOUT_MS,
  CAPY_CLIENT_SURFACE,
  CAPY_CLIENT_FEATURES,
  CAPY_CLIENT_ID_HEADER,
  CAPY_CLIENT_SURFACE_HEADER,
  CAPY_CLIENT_FEATURES_HEADER,
  makeCapyClientId,
} from "./constants.js";

export class CapyApiError extends Error {
  constructor(message, { status = 0, code = null, upstream = null } = {}) {
    super(message);
    this.name = "CapyApiError";
    this.status = status;
    this.code = code;
    this.upstream = upstream;
  }
}

const hasText = (v) => typeof v === "string" && v.trim() !== "";

function clerkParams() {
  return new URLSearchParams({
    _is_native: "1",
    __clerk_api_version: CAPY_CLERK_API_VERSION,
    _clerk_js_version: CAPY_CLERK_JS_VERSION,
  });
}

/**
 * One Clerk Frontend API call. Returns { body, rotatedJwt } — rotatedJwt is the
 * Authorization response header's JWT (the new client JWT when Clerk rotated
 * it); persist it whenever present.
 */
export async function clerkRequest(path, {
  clientJwt,
  method = "GET",
  form,
  timeoutMs = CAPY_DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const qs = clerkParams();
  const response = await fetchImpl(`${CAPY_FAPI_BASE}${path}?${qs}`, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: CAPY_ORIGIN,
      ...(hasText(clientJwt) ? { Authorization: `Bearer ${clientJwt}` } : {}),
    },
    body: form ? new URLSearchParams(form) : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });

  const rotated = response.headers.get("authorization");
  const rotatedJwt = hasText(rotated) ? rotated.replace(/^Bearer\s+/i, "").trim() : null;
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = Array.isArray(body?.errors) && body.errors.length
      ? String(body.errors[0].message || body.errors[0].long_message || "")
      : "";
    const code = Array.isArray(body?.errors) && body.errors.length ? body.errors[0].code ?? null : null;
    throw new CapyApiError(
      `Capy sign-in request failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
      { status: response.status, code },
    );
  }
  return { body, rotatedJwt };
}

/**
 * Step 1 of the email-code login: create a Clerk client, open a sign_in for the
 * email, and send the code to the account's primary email address.
 * Returns { clientJwt, signInId, emailAddressId } — the state verify needs.
 */
export async function sendCapyEmailCode(email, { fetchImpl } = {}) {
  if (!hasText(email)) throw new CapyApiError("Email is required", { code: "invalid_email" });
  const client = await clerkRequest("/v1/client", { method: "POST", form: {}, fetchImpl });
  const clientJwt = client.rotatedJwt;
  if (!hasText(clientJwt)) throw new CapyApiError("Capy did not issue a client credential");

  const created = await clerkRequest("/v1/client/sign_ins", {
    clientJwt, method: "POST", form: { identifier: email.trim() }, fetchImpl,
  });
  const signIn = created.body?.response;
  const signInId = signIn?.id;
  if (!hasText(signInId)) throw new CapyApiError("Capy did not start a sign-in");

  const factors = Array.isArray(signIn?.supported_first_factors) ? signIn.supported_first_factors : [];
  const emailCode = factors.find((f) => f?.strategy === "email_code" && hasText(f?.email_address_id));
  if (!emailCode) {
    const strategies = factors.map((f) => f?.strategy).filter(Boolean).join(", ");
    throw new CapyApiError(
      strategies ? `This Capy account cannot sign in by email code (available: ${strategies})` : "This Capy account cannot sign in by email code",
      { code: "no_email_code" },
    );
  }

  const prepared = await clerkRequest(`/v1/client/sign_ins/${encodeURIComponent(signInId)}/prepare_first_factor`, {
    clientJwt: created.rotatedJwt ?? clientJwt,
    method: "POST",
    form: { strategy: "email_code", email_address_id: emailCode.email_address_id },
    fetchImpl,
  });
  return {
    clientJwt: prepared.rotatedJwt ?? created.rotatedJwt ?? clientJwt,
    signInId,
    emailAddressId: emailCode.email_address_id,
  };
}

/**
 * Step 2: exchange the 6-digit code for a session.
 * Returns { clientJwt, sessionId, userId } or throws CapyApiError(code:"wrong_code").
 */
export async function verifyCapyEmailCode({ clientJwt, signInId, code }, { fetchImpl } = {}) {
  if (!hasText(clientJwt) || !hasText(signInId) || !hasText(code)) {
    throw new CapyApiError("Missing sign-in state or code", { code: "missing_state" });
  }
  let res;
  try {
    res = await clerkRequest(`/v1/client/sign_ins/${encodeURIComponent(signInId)}/attempt_first_factor`, {
      clientJwt, method: "POST", form: { strategy: "email_code", code: code.trim() }, fetchImpl,
    });
  } catch (e) {
    if (e instanceof CapyApiError && (e.code === "form_code_incorrect" || e.status === 422)) {
      throw new CapyApiError("验证码不正确或已过期", { code: "wrong_code", status: e.status });
    }
    throw e;
  }
  const signIn = res.body?.response;
  const sessionId = signIn?.created_session_id ?? signIn?.createdSessionId;
  const status = signIn?.status;
  if (status !== "complete" || !hasText(sessionId)) {
    throw new CapyApiError(
      status === "needs_second_factor"
        ? "This account requires a second factor; sign in via the Capy app once to finish setup"
        : `Capy sign-in did not complete (status: ${status ?? "unknown"})`,
      { code: "incomplete", status: 400 },
    );
  }
  return {
    clientJwt: res.rotatedJwt ?? clientJwt,
    sessionId,
    userId: signIn?.user_id ?? null,
  };
}

/**
 * Mint a ~60s session JWT accepted by api.capy.ai/app.
 * Origin: capy://app is REQUIRED — without it the JWT has no `azp` claim and
 * every /app/* call answers 401.
 * Returns { jwt, rotatedClientJwt }.
 */
export async function mintCapySessionJwt({ clientJwt, sessionId }, { fetchImpl } = {}) {
  if (!hasText(clientJwt) || !hasText(sessionId)) {
    throw new CapyApiError("Missing Capy session credential", { code: "missing_credential" });
  }
  const res = await clerkRequest(`/v1/client/sessions/${encodeURIComponent(sessionId)}/tokens`, {
    clientJwt, method: "POST", form: {}, fetchImpl,
  });
  const jwt = res.body?.jwt ?? res.body?.response?.jwt;
  if (!hasText(jwt)) throw new CapyApiError("Capy did not issue a session token");
  return { jwt, rotatedClientJwt: res.rotatedJwt };
}

/** api.capy.ai/app call with a minted session JWT.
 *
 * Sends the desktop-equivalent client-surface headers on every /app/* call:
 * x-capy-client-surface=desktop, x-capy-client-features=message-edit,visual,ads-models,
 * and a stable x-capy-client-id. The server gates ad-funded (free) model access
 * on the `ads-models` feature flag plus surface=desktop; omitting these causes
 * jam-create to be rejected (HTTP 400/403) for ad-supported models. */
let _clientId = null;
function capyClientId() {
  if (!_clientId) _clientId = makeCapyClientId();
  return _clientId;
}

export async function capyAppRequest(jwt, path, {
  method = "GET",
  body,
  timeoutMs = CAPY_DEFAULT_TIMEOUT_MS,
  accept = "application/json",
  fetchImpl = globalThis.fetch,
  signal,
  clientId,
} = {}) {
  if (!hasText(jwt)) throw new CapyApiError("Missing Capy session token", { code: "missing_token" });
  const headers = {
    Authorization: `Bearer ${jwt}`,
    Accept: accept,
    Origin: CAPY_ORIGIN,
    [CAPY_CLIENT_SURFACE_HEADER]: CAPY_CLIENT_SURFACE,
    [CAPY_CLIENT_FEATURES_HEADER]: CAPY_CLIENT_FEATURES,
    [CAPY_CLIENT_ID_HEADER]: clientId ?? capyClientId(),
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetchImpl(`${CAPY_API_BASE}${CAPY_APP_PREFIX}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "error",
    signal: signal ?? AbortSignal.timeout(timeoutMs),
  });
  return response;
}

export async function capyAppJson(jwt, path, options = {}) {
  const response = await capyAppRequest(jwt, path, options);
  const text = await response.text();
  if (!response.ok) {
    let code = null;
    try { code = JSON.parse(text)?._tag ?? null; } catch { /* keep null */ }
    throw new CapyApiError(`Capy API ${path.split("?")[0]} failed (HTTP ${response.status})${code ? ` ${code}` : text ? `: ${text.slice(0, 160)}` : ""}`, {
      status: response.status, code, upstream: text.slice(0, 400),
    });
  }
  try { return JSON.parse(text); } catch {
    throw new CapyApiError(`Capy API ${path} returned invalid JSON`, { status: response.status });
  }
}

// ── App resources ──────────────────────────────────────────────────────────

export const capyMe = (jwt, o) => capyAppJson(jwt, "/me", o);
export const capyOrganizations = (jwt, o) => capyAppJson(jwt, "/organizations", o);
export const capyDevices = (jwt, orgId, o) => capyAppJson(jwt, `/orgs/${encodeURIComponent(orgId)}/devices`, o);
export const capyModels = (jwt, orgId, o) => capyAppJson(jwt, `/models?orgId=${encodeURIComponent(orgId)}`, o);

/**
 * Enroll a device for this account and return it. The server answers with
 * [{ orgId, device }] — one entry per org the account belongs to. A freshly
 * enrolled device is NOT connected: enrolment only reserves the slot, and a
 * jam can only be created on a device whose agent is actually online. What
 * this buys is that the connection no longer depends on the user having
 * opened the Capy desktop app to register one by hand.
 *
 * `os` and `arch` are the wire enum, not host strings: the desktop sends
 * process.platform / (arch === "arm64" ? "arm64" : "x86_64"). Sending "x64"
 * instead of "x86_64" is a 400 with no body.
 */
/**
 * Device-code pairing — the path that actually yields a connectable device.
 *
 * `/devices/enroll` reserves a slot but returns no token, so the device can
 * never come online (see tunnel.js). The device-code flow returns
 * `{ token: "capyd_…" }` at the end, which is what the tunnel authenticates
 * with:
 *
 *   startDeviceCode → approveDeviceCode (self-approve with our own JWT)
 *   → pollDeviceCode until `status: "approved"` → enrolled.token
 */
export async function capyStartDeviceCode(jwt, { hostname, os, arch }, o = {}) {
  const body = await capyAppJson(jwt, "/devices/code", {
    ...o,
    method: "POST",
    body: { hostname, os, arch },
  });
  const userCode = String(body?.userCode ?? "").trim();
  const deviceCode = String(body?.deviceCode ?? "").trim();
  if (!userCode || !deviceCode) {
    throw new CapyApiError("Capy 设备码接口没有返回 userCode/deviceCode", { code: "device_code_missing" });
  }
  return {
    userCode,
    deviceCode,
    verificationUrl: typeof body?.verificationUrl === "string" ? body.verificationUrl : "",
    expiresInSeconds: Number(body?.expiresInSeconds) || 300,
    pollIntervalSeconds: Math.max(1, Number(body?.pollIntervalSeconds) || 5),
  };
}

/**
 * Approve a device code with the account's own session JWT. This is what makes
 * pairing unattended — no browser round-trip is required (the verificationUrl
 * exists only as a manual fallback).
 */
export function capyApproveDeviceCode(jwt, orgId, { userCode, name }, o = {}) {
  return capyAppJson(jwt, `/orgs/${encodeURIComponent(orgId)}/devices/code/approve`, {
    ...o,
    method: "POST",
    body: { userCode, name },
  });
}

/** Poll until approved. Returns the enrolled device + its `capyd_` token. */
export async function capyPollDeviceCode(jwt, deviceCode, o = {}) {
  const body = await capyAppJson(jwt, "/devices/code/poll", {
    ...o,
    method: "POST",
    body: { deviceCode },
  });
  const status = String(body?.status ?? "");
  if (status === "approved") {
    const enrolled = body?.enrolled;
    if (!enrolled || typeof enrolled !== "object" || Array.isArray(enrolled)) {
      throw new CapyApiError("Capy 设备码已批准，但没有 enrolled", { code: "device_code_missing" });
    }
    return {
      status,
      orgId: enrolled.orgId ?? null,
      deviceId: enrolled.device?.id ?? enrolled.deviceId ?? null,
      token: enrolled.token ?? null,
    };
  }
  return { status };
}

/**
 * Full pairing flow. `sleep` is injectable so tests do not wait real seconds.
 */
export async function capyPairDevice(jwt, orgId, { name, hostname, os, arch, polls = 10, sleep }, o = {}) {
  const start = await capyStartDeviceCode(jwt, { hostname, os, arch }, o);
  try {
    await capyApproveDeviceCode(jwt, orgId, { userCode: start.userCode, name }, o);
  } catch (e) {
    const hint = start.verificationUrl ? `；可在浏览器打开 ${start.verificationUrl} 手动批准` : "";
    throw new CapyApiError(`Capy 设备码自动批准失败：${e?.message ?? e}${hint}`, {
      code: "device_pair_failed",
      status: e?.status ?? 0,
    });
  }
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 0; i < polls; i += 1) {
    let poll;
    try {
      poll = await capyPollDeviceCode(jwt, start.deviceCode, o);
    } catch (e) {
      if (e?.status === 401) throw e;
      await wait(start.pollIntervalSeconds * 1000);
      continue;
    }
    if (poll.status === "approved") {
      if (!poll.deviceId || !poll.token) {
        throw new CapyApiError("Capy 设备码批准结果缺少 deviceId/token", { code: "device_code_missing" });
      }
      return {
        orgId: poll.orgId || orgId,
        deviceId: poll.deviceId,
        token: poll.token,
        name,
        verificationUrl: start.verificationUrl,
      };
    }
    if (poll.status === "denied" || poll.status === "expired") {
      throw new CapyApiError(`Capy 设备码配对${poll.status === "denied" ? "被拒绝" : "已过期"}`, { code: "device_pair_failed" });
    }
    await wait(start.pollIntervalSeconds * 1000);
  }
  throw new CapyApiError("等待 Capy 设备码批准超时", { code: "device_pair_timeout" });
}

export function capyEnrollDevice(jwt, { name, hostname, os, arch, heldOrgIds = [], deviceIds = [] }, o = {}) {
  return capyAppJson(jwt, "/devices/enroll", {
    ...o,
    method: "POST",
    body: { name, hostname, os, arch, heldOrgIds, deviceIds },
  });
}

/**
 * Flip a device's access to "shared" so every member of the org can run
 * threads on it, instead of it belonging to whoever enrolled it. Same
 * endpoint the dashboard uses; "org"/"organization" are rejected.
 */
export function capyShareDevice(jwt, orgId, deviceId, o = {}) {
  return capyAppJson(jwt, `/orgs/${encodeURIComponent(orgId)}/devices/${encodeURIComponent(deviceId)}/access`, {
    ...o,
    method: "POST",
    body: { access: "shared" },
  });
}
export const capyJams = (jwt, orgId, o) => capyAppJson(jwt, `/orgs/${encodeURIComponent(orgId)}/jams`, o);

/**
 * Create a projectless jam bound to an enrolled device. `workspace.kind` must be
 * "worktree" for a fresh folder; "linked" requires an existing device folder.
 */
export function capyCreateJam(jwt, orgId, { jamId, requestId, title, message, modelId, reasoningMode, modes, promptVariant, deviceId, workspace, personal }, o = {}) {
  return capyAppJson(jwt, `/orgs/${encodeURIComponent(orgId)}/jams`, {
    ...o,
    method: "POST",
    body: {
      jamId,
      requestId,
      ...(hasText(title) ? { title } : {}),
      message,
      ...(hasText(modelId) ? { model: { modelId, ...(hasText(reasoningMode) ? { reasoningMode } : {}), ...(modes ? { modes } : {}) } } : {}),
      ...(hasText(promptVariant) ? { promptVariant } : {}),
      ...(hasText(deviceId)
        ? { device: { deviceId, workspace: workspace ?? { kind: "worktree" } } }
        : {}),
      ...(personal === undefined ? {} : { personal }),
    },
  });
}

export function capyPostMessage(jwt, orgId, jamId, { text, modelId, clientKey }, o = {}) {
  return capyAppJson(jwt, `/orgs/${encodeURIComponent(orgId)}/jams/${encodeURIComponent(jamId)}/message`, {
    ...o,
    method: "POST",
    body: {
      text,
      ...(hasText(modelId) ? { model: { modelId } } : {}),
      ...(hasText(clientKey) ? { clientKey } : {}),
    },
  });
}

export const capyJamEvents = (jwt, orgId, jamId, { pathSuffix = "", ...o } = {}) =>
  capyAppJson(jwt, `/orgs/${encodeURIComponent(orgId)}/jams/${encodeURIComponent(jamId)}/events${pathSuffix}`, o);

/** NDJSON event stream — caller consumes response.body as newline-delimited JSON. */
export const capyJamEventStream = (jwt, orgId, jamId, o = {}) =>
  capyAppRequest(jwt, `/orgs/${encodeURIComponent(orgId)}/jams/${encodeURIComponent(jamId)}/events/stream`, {
    ...o,
    accept: "application/x-ndjson",
  });

export const capyDeleteJams = (jwt, orgId, jamIds, o = {}) =>
  capyAppJson(jwt, `/orgs/${encodeURIComponent(orgId)}/jams/delete`, {
    ...o,
    method: "POST",
    body: { jamIds: Array.isArray(jamIds) ? jamIds : [jamIds] },
  });
