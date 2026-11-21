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
import {
  sendCapyEmailCode,
  verifyCapyEmailCode,
  mintCapySessionJwt,
  capyOrganizations,
  capyDevices,
  capyEnrollDevice,
  capyShareDevice,
  capyModels,
  CapyApiError,
} from "open-sse/shared/capy/client.js";
import { CAPY_SESSION_TOKEN_TTL_MS } from "open-sse/shared/capy/constants.js";


// The enroll endpoint takes the desktop's wire enum, not arbitrary strings:
// process.platform verbatim, and arch collapses to arm64 or x86_64 — sending
// "x64" is a 400 with an empty body.
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

  // No device at all → enroll one, so the connection does not depend on the
  // user having opened the Capy desktop app first. An enrolled device is
  // offline until its agent connects, but it is what a jam is created against,
  // and sharing it lets every org member run threads on the same machine
  // instead of each needing their own.
  let enrolled = false;
  if (!device) {
    const hostname = "10router";
    try {
      const enrolledOrgs = await capyEnrollDevice(jwt, {
        name: "10router",
        hostname,
        os: enrollmentOs(),
        arch: enrollmentArch(),
      }, { fetchImpl });
      const entries = Array.isArray(enrolledOrgs) ? enrolledOrgs : enrolledOrgs?.items ?? [];
      const mine = entries.find((e) => e?.orgId === org.id) ?? entries[0];
      if (mine?.device?.id) {
        device = mine.device;
        enrolled = true;
        // Best-effort: shared devices belong to the org, personal ones only to
        // whoever enrolled them. A failure here is not worth failing login over.
        await capyShareDevice(jwt, org.id, mine.device.id, { fetchImpl }).catch(() => null);
      }
    } catch { /* keep device null; the executor surfaces the real error */ }
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
    modelCount: modelList.length,
  };
}

export function capyConnectionName(email, orgName) {
  const base = String(email || "capy").trim() || "capy";
  return orgName ? `${base} · ${orgName}` : base;
}
