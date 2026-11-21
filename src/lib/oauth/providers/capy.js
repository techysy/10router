// Capy — Clerk Native API email-code login (the same channel the official
// @capy/desktop app uses). Not standard OAuth: there is no third-party
// client_id, so the flow is two custom steps driven by dedicated routes —
// send the email code, then verify it and assemble the connection.
//
// Credential shape stored on the connection:
//   accessToken  = minted 60s session JWT (azp: capy://app)
//   refreshToken = Clerk client JWT with rotating_token (rotates every call —
//                  the executor must persist the rotated value like grok-cli)
//   providerSpecificData = { sessionId, userId, orgId, orgName, deviceId,
//                            machineId, loginAt, credentialSource }

import crypto from "crypto";
import os from "os";
import {
  sendCapyEmailCode,
  verifyCapyEmailCode,
  mintCapySessionJwt,
  capyOrganizations,
  capyDevices,
  capyPairDevice,
  capyShareDevice,
  capyModels,
  CapyApiError,
} from "open-sse/shared/capy/client.js";
import { CAPY_SESSION_TOKEN_TTL_MS } from "open-sse/shared/capy/constants.js";


// The enroll endpoint takes the desktop's wire enum, not arbitrary strings:
// process.platform verbatim, and arch collapses to arm64 or x86_64 — sending
// "x64" is a 400 with an empty body.
/** Stable device name for this install: hostname, sanitized to Capy's charset. */
function deviceName() {
  try {
    const raw = String(os.hostname() || "10router-headless");
    const cleaned = raw.replace(/[^A-Za-z0-9._@-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 80);
    return cleaned || "10router-headless";
  } catch {
    return "10router-headless";
  }
}

function enrollmentOs() {
  const p = process.platform;
  return p === "win32" || p === "darwin" ? p : "linux";
}

function enrollmentArch() {
  return process.arch === "arm64" ? "arm64" : "x86_64";
}

export const CAPY_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FLOW_TTL_MS = 10 * 60 * 1000;

// Pending sign-ins keyed by a single-use flow id. Server-local: the dashboard
// and these routes run in the same process, so nothing stronger is needed.
const pendingFlows = new Map();

function sweepExpired(now = Date.now()) {
  for (const [id, flow] of pendingFlows) {
    if (now - flow.createdAt > FLOW_TTL_MS) pendingFlows.delete(id);
  }
}

/**
 * Step 1 — create a Clerk sign_in and email the code.
 * Returns { flowId, expiresIn } for the dashboard's verify step.
 */
export async function sendCapyCode(email, { fetchImpl } = {}) {
  const state = await sendCapyEmailCode(email, { fetchImpl });
  sweepExpired();
  const flowId = crypto.randomBytes(24).toString("base64url");
  pendingFlows.set(flowId, {
    clientJwt: state.clientJwt,
    signInId: state.signInId,
    email,
    createdAt: Date.now(),
  });
  return { flowId, expiresIn: Math.floor(FLOW_TTL_MS / 1000) };
}

function takeFlow(flowId) {
  sweepExpired();
  const flow = typeof flowId === "string" ? pendingFlows.get(flowId) : null;
  if (!flow) throw new CapyApiError("登录已过期，请重新发送验证码", { code: "flow_expired" });
  pendingFlows.delete(flowId);
  return flow;
}

/**
 * Step 2 — verify the code, then prove model access before issuing a
 * connection: list organizations, require one usable org with ≥1 connected
 * device (projectless threads can only run on an enrolled device) and ≥1 model
 * — mirroring the draft gate that a login alone is never stored as a provider.
 * Returns everything createProviderConnection needs.
 */
export async function loginCapyByCode({ flowId, code }, { fetchImpl } = {}) {
  const flow = takeFlow(flowId);
  const session = await verifyCapyEmailCode(
    { clientJwt: flow.clientJwt, signInId: flow.signInId, code },
    { fetchImpl },
  );

  const { jwt, rotatedClientJwt } = await mintCapySessionJwt(session, { fetchImpl });
  const clientJwt = rotatedClientJwt ?? session.clientJwt;

  const orgs = await capyOrganizations(jwt, { fetchImpl }).catch((e) => {
    throw new CapyApiError(`Capy 会话未能访问组织: ${e.message}`, { code: "org_unavailable", status: e.status });
  });
  const orgList = Array.isArray(orgs) ? orgs : orgs?.items ?? [];
  const org = orgList.find((o) => o?.id && (o.accessLevel === "owner" || o.accessLevel === "member")) ?? orgList[0];
  if (!org?.id) {
    throw new CapyApiError("账号下没有可用的 Capy 组织", { code: "no_org" });
  }

  const devices = await capyDevices(jwt, org.id, { fetchImpl }).catch(() => []);
  const deviceList = Array.isArray(devices) ? devices : devices?.items ?? [];
  const connected = deviceList.filter((d) => d?.id && d.connected === true && !d.revokedAt);
  let device = connected[0] ?? deviceList.find((d) => d?.id && !d.revokedAt) ?? null;

  // No usable device → pair one through the device-code flow. This is the only
  // path that yields a `capyd_` token, and that token is what lets the executor
  // dial Capy's device tunnel and bring the device online without the user
  // running the desktop app. `/devices/enroll` would reserve a slot but hand
  // back no token, so the device could never connect — see tunnel.js.
  let enrolled = false;
  let deviceToken = null;
  if (!device) {
    try {
      const paired = await capyPairDevice(jwt, org.id, {
        name: deviceName(),
        hostname: deviceName(),
        os: enrollmentOs(),
        arch: enrollmentArch(),
      }, { fetchImpl });
      device = { id: paired.deviceId, name: paired.name, connected: false };
      deviceToken = paired.token;
      enrolled = true;
      // Shared so every org member can run threads on it, not just whoever
      // paired it. Best-effort: a share failure must not fail the login.
      await capyShareDevice(jwt, org.id, paired.deviceId, { fetchImpl }).catch(() => null);
    } catch { /* keep device null; the executor surfaces the real error */ }
  }

  // An existing device already paired by this account keeps its token, so the
  // tunnel can be re-dialled on later requests without re-pairing.
  if (device?.id && !deviceToken) {
    deviceToken = (deviceList ?? []).find((d) => d?.id === device.id)?.token
      ?? (device.token ?? null);
    if (!deviceToken) enrolled = false;
  }

  // Model-access proof: a session that cannot list the org's models is not a
  // usable upstream — refuse to store it.
  const models = await capyModels(jwt, org.id, { fetchImpl }).catch(() => null);
  const modelList = Array.isArray(models) ? models : models?.items ?? [];
  if (modelList.length === 0) {
    throw new CapyApiError("Capy 会话未能获取模型列表（模型访问未开通）", { code: "no_model_access" });
  }

  // Provision a reusable jam: the only Capy execution unit. First enrolment
  // needs an enrolled device (projectless threads must target one); once
  // created the jam keeps running even if the device later goes offline, so
  // we persist jamId and reuse it. If no device is connected yet, we still
  // store the connection — the executor creates the jam on first request.
  let jamId = null;
  try {
    const { capyCreateJam, capyJams } = await import("open-sse/shared/capy/client.js");
    const existing = await capyJams(jwt, org.id, { fetchImpl }).catch(() => null);
    const list = Array.isArray(existing) ? existing : existing?.items ?? [];
    const idle = list.find((j) => j?.id && j?.status === "idle" && !j?.archived);
    if (idle?.id) {
      jamId = idle.id;
    } else if (device?.id) {
      const created = await capyCreateJam(jwt, org.id, {
        jamId: `jam_${crypto.randomUUID()}`,
        requestId: crypto.randomUUID(),
        title: "10router",
        message: "Ready.",
        personal: true,
        ...(device?.id ? { deviceId: device.id } : {}),
      }, { fetchImpl }).catch(() => null);
      jamId = created?.id ?? null;
    }
  } catch { /* jam provisioning is best-effort; executor creates on demand */ }

  return {
    email: flow.email,
    userId: session.userId,
    clientJwt,
    sessionJwt: jwt,
    sessionId: session.sessionId,
    expiresIn: Math.floor(CAPY_SESSION_TOKEN_TTL_MS / 1000),
    orgId: org.id,
    orgName: org.name ?? null,
    deviceId: device?.id ?? null,
    machineId: device?.machineId ?? null,
    jamId,
    deviceConnected: connected.length > 0,
    deviceEnrolled: enrolled,
    deviceToken,
    modelCount: modelList.length,
  };
}

export function capyConnectionName(email, orgName) {
  const base = String(email || "capy").trim() || "capy";
  return orgName ? `${base} · ${orgName}` : base;
}
