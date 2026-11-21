/**
 * Capy device tunnel — the headless device runtime.
 *
 * A jam only runs on a device whose agent is connected to Capy's tunnel. Until
 * now this provider depended on the user having the Capy desktop app running,
 * because enrolling a device through `/app/devices/enroll` only reserves the
 * slot: the device stays offline until something dials the tunnel for it. That
 * is what this file does.
 *
 * Measured against a live account (see the PR description):
 *
 *   pairing    POST /app/devices/code  →  approve  →  poll  →  { token: "capyd_…" }
 *   connect    WS wss://device-tunnel-production.cloud.capy.ai/tunnel
 *              authorization: Bearer capyd_…
 *   handshake  → hello{contractVersion:2,…}
 *              ← ping                      → pong
 *              ← session-config            → workspaces-changed
 *                                          → ready
 *   serving    ← open{streamId,kind,method,path,headers}
 *              ← <binary> streamId(4B BE) + JSON body
 *              ← close{streamId}
 *              → response{streamId,status,headers}
 *              → <binary> streamId(4B BE) + JSON result
 *              → close{streamId}
 *
 * Two details cost the most time to get right and are easy to get wrong again:
 *
 *  1. The `ready` frame is OUTBOUND. Waiting for the server to send one gets
 *     the socket closed with `1011 Ready timeout` after ~20s. The handshake
 *     completes when WE send it in response to `session-config`.
 *  2. Stream bodies arrive as BINARY frames — a big-endian uint32 stream id
 *     followed by the JSON payload. Reading them as text yields an empty body,
 *     so every invocation looks like `{}` and every handler looks unimplemented.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { CapyApiError } from "./client.js";

export const CAPY_DEVICE_TUNNEL = "wss://device-tunnel-production.cloud.capy.ai/tunnel";
export const CAPY_TUNNEL_CONTRACT_VERSION = 2;
const READY_TIMEOUT_MS = 20_000;
const CONNECT_TIMEOUT_MS = 15_000;
const CONNECT_POLL_MS = 400;

/**
 * The wire enum, not host strings. `arch` in particular: the desktop sends
 * `process.arch === "arm64" ? "arm64" : "x86_64"`, and "x64" is a 400 with an
 * empty body — which reads like "endpoint not implemented" rather than
 * "wrong enum".
 */
export function deviceOs(platform = process.platform) {
  if (platform === "win32") return "win32";
  if (platform === "darwin") return "darwin";
  return "linux";
}

export function deviceArch(arch = process.arch) {
  return arch === "arm64" ? "arm64" : "x86_64";
}

/** A device name Capy accepts: alphanumerics, dot, underscore, @ and dash. */
export function defaultDeviceName(prefix = "10router-headless") {
  let host = "";
  try { host = os_hostname(); } catch { /* fall through */ }
  const raw = String(host || prefix);
  const cleaned = raw
    .replace(/[^A-Za-z0-9._@-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  return cleaned || prefix;
}

function os_hostname() {
  // Imported lazily so the module stays usable in a non-Node host in tests.
  // eslint-disable-next-line global-require
  return require("os").hostname();
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function resolveIn(base, raw) {
  const value = String(raw ?? "").trim();
  if (!value) throw new Error("path is required");
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(base, value);
}

const ok = (result) => ({ status: "succeeded", result });
const fail = (code, message) => ({ status: "failed", error: { code, message } });

/**
 * The machine RPC the agent drives. Only the subset a text/image conversation
 * needs is implemented; everything else answers `MachineServer.Unavailable`
 * rather than pretending to work. That mirrors the boundary the reference
 * implementation documents: terminal/browser/file-editing tools stay
 * unavailable on a headless device.
 */
export function capyMachineResult(handler, params, state) {
  const base = state.root || state.worktreeBase;
  switch (handler) {
    case "worktree_ensure": {
      const root = String(params.root ?? "");
      let created = false;
      if (root) {
        const worktreeBase = path.resolve(state.worktreeBase);
        const resolved = path.resolve(root);
        if (resolved !== worktreeBase && !resolved.startsWith(`${worktreeBase}${path.sep}`)) {
          return fail("MachineServer.Refused", "worktree root outside worktreeBase");
        }
        created = !fs.existsSync(resolved);
        fs.mkdirSync(resolved, { recursive: true });
        state.root = resolved;
      }
      return ok({ root, created, checkouts: [] });
    }
    case "worktree_list":
      return ok({ kind: "worktree_list", entries: [] });
    case "volume_landed": {
      const mounts = Array.isArray(params.mounts) ? params.mounts : [];
      return ok({
        kind: "volume_landed",
        mounts: mounts.map((m) => ({ mountPath: String(m?.mountPath ?? ""), current: true })),
        landing: false,
        checkpoints: false,
        directories: [],
        unretained: [],
        handback: true,
      });
    }
    case "volume_probe": {
      const mounts = Array.isArray(params.mounts) ? params.mounts : [];
      return ok({ mounts: mounts.map((m) => ({ mountPath: String(m?.mountPath ?? ""), state: "current" })) });
    }
    case "bash": {
      const command = String(params.command ?? "");
      if (!command.trim()) return fail("MachineServer.Bash", "bash command is empty");
      const startedAt = Date.now();
      const cap = 4 * 1024 * 1024;
      try {
        const stdout = execSync(command, {
          cwd: base,
          encoding: "utf8",
          timeout: 120_000,
          stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: cap,
        });
        return ok({ kind: "bash", stdout: String(stdout).slice(0, cap), stderr: "", exitCode: 0, durationMs: Date.now() - startedAt, timedOut: false, isError: false });
      } catch (e) {
        return ok({
          kind: "bash",
          stdout: String(e?.stdout ?? "").slice(0, cap),
          stderr: String(e?.stderr ?? e?.message ?? "").slice(0, cap),
          exitCode: typeof e?.status === "number" ? e.status : 1,
          durationMs: Date.now() - startedAt,
          timedOut: false,
          isError: true,
        });
      }
    }
    case "bash_output":
      return ok({ kind: "not-running" });
    case "read": {
      try {
        const text = fs.readFileSync(resolveIn(base, params.path), "utf8");
        const offset = Math.max(1, Number(params.offset) || 1);
        const limit = Math.max(1, Math.min(10_000, Number(params.limit) || 2_000));
        const all = text.split(/\r?\n/u);
        return ok({ kind: "read", content: all.slice(offset - 1, offset - 1 + limit).join("\n"), offset, totalLines: all.length, isError: false });
      } catch (e) {
        return fail("MachineServer.FileError", String(e?.message ?? e));
      }
    }
    case "write": {
      try {
        const file = resolveIn(base, params.path);
        const content = String(params.content ?? "");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content, "utf8");
        return ok({ kind: "write", path: file, bytes: Buffer.byteLength(content), isError: false });
      } catch (e) {
        return fail("MachineServer.FileError", String(e?.message ?? e));
      }
    }
    case "edit": {
      try {
        const file = resolveIn(base, params.path);
        const oldString = String(params.oldString ?? "");
        const newString = String(params.newString ?? "");
        if (!oldString || oldString === newString) return fail("MachineServer.FileError", "oldString must be non-empty and differ from newString");
        const text = fs.readFileSync(file, "utf8");
        const count = text.split(oldString).length - 1;
        if (count === 0) return fail("MachineServer.FileError", `The text was not found in ${String(params.path)}`);
        if (count > 1 && params.replaceAll !== true) return fail("MachineServer.FileError", `Found ${count} occurrences; provide more context or replaceAll`);
        fs.writeFileSync(file, params.replaceAll === true ? text.split(oldString).join(newString) : text.replace(oldString, newString), "utf8");
        return ok({ kind: "edit", path: file, replacements: count, isError: false });
      } catch (e) {
        return fail("MachineServer.FileError", String(e?.message ?? e));
      }
    }
    case "file_read": {
      try {
        const file = resolveIn(base, params.path);
        const text = fs.readFileSync(file, "utf8");
        return ok({ kind: "read", path: file, content: { text }, sha: sha256(text), isError: false });
      } catch (e) {
        if (e?.code === "ENOENT") return ok({ kind: "missing", isError: false });
        return fail("MachineServer.FileError", String(e?.message ?? e));
      }
    }
    case "file_write": {
      try {
        const file = resolveIn(base, params.path);
        const content = String(params.content ?? "");
        let currentSha = null;
        try { currentSha = sha256(fs.readFileSync(file, "utf8")); } catch { /* new file */ }
        const baseSha = typeof params.baseSha === "string" ? params.baseSha : null;
        if (baseSha !== null && currentSha !== baseSha) return ok({ kind: "conflict", currentSha, isError: false });
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content, "utf8");
        return ok({ kind: "written", sha: sha256(content), bytes: Buffer.byteLength(content), isError: false });
      } catch (e) {
        return fail("MachineServer.FileError", String(e?.message ?? e));
      }
    }
    default:
      if (String(handler).startsWith("git")) return ok({ repos: [] });
      return fail("MachineServer.Unavailable", `headless device does not implement ${handler || "unknown"}`);
  }
}

/** Big-endian uint32 stream id + payload, the tunnel's data-frame shape. */
export function encodeTunnelDataFrame(streamId, body) {
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32BE(streamId >>> 0, 0);
  body.copy(frame, 4);
  return frame;
}

export function decodeTunnelDataFrame(bytes) {
  if (!bytes || bytes.length < 4) return null;
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return { streamId: buf.readUInt32BE(0), body: buf.subarray(4) };
}

/**
 * One live tunnel for one enrolled device. Owns the socket, answers `ping`,
 * completes the handshake, and serves invocation streams until closed.
 *
 * `WebSocketImpl` is injectable so the protocol can be exercised without a
 * network in unit tests.
 */
export class CapyDeviceTunnel {
  constructor({ orgId, deviceId, token, hostname, worktreeBase, clientVersion = "10router-headless 1.0", WebSocketImpl, logger }) {
    if (!deviceId || !token) throw new CapyApiError("Capy 设备缺少 deviceId 或 token", { code: "missing_device_credential" });
    this.orgId = orgId;
    this.deviceId = deviceId;
    this.token = token;
    this.hostname = hostname || defaultDeviceName();
    this.worktreeBase = worktreeBase || path.join(process.cwd(), ".capy-worktrees");
    this.clientVersion = clientVersion;
    this.logger = logger;
    const Impl = WebSocketImpl ?? globalThis.WebSocket;
    if (!Impl) throw new CapyApiError("当前运行时没有 WebSocket（需要 Node 22+ / Bun）", { code: "no_websocket" });
    this.WebSocketImpl = Impl;
    this.ws = null;
    this.ready = false;
    this.state = { root: null, worktreeBase: this.worktreeBase };
    this.streams = new Map();
    this.pending = null;
    this.readyResolve = null;
    this.readyReject = null;
    this.connectPromise = null;
    this.closed = false;
  }

  get connected() {
    return this.ready && this.ws?.readyState === 1;
  }

  async ensure(timeoutMs = CONNECT_TIMEOUT_MS) {
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connect(timeoutMs);
    try { await this.connectPromise; } finally { this.connectPromise = null; }
  }

  close() {
    this.ready = false;
    this.closed = true;
    try { this.ws?.close(1000, "10router closed"); } catch { /* already gone */ }
    this.ws = null;
  }

  async connect(timeoutMs) {
    this.ready = false;
    let ws;
    try {
      ws = new this.WebSocketImpl(CAPY_DEVICE_TUNNEL, {
        headers: { authorization: `Bearer ${this.token}` },
      });
    } catch (e) {
      throw new CapyApiError(`连接 Capy 设备隧道失败：${e?.message ?? e}`, { code: "device_connect_failed" });
    }
    this.ws = ws;
    ws.binaryType = "arraybuffer";

    const ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    const timer = setTimeout(() => {
      const err = new CapyApiError(`连接 Capy 设备隧道超时（${Math.round(timeoutMs / 1000)}s）`, { code: "device_connect_timeout" });
      this.readyReject?.(err);
      try { ws.close(4000, "ready timeout"); } catch { /* gone */ }
    }, Math.max(3000, timeoutMs));
    timer.unref?.();

    const onReject = (err) => {
      clearTimeout(timer);
      this.readyReject?.(err);
    };

    ws.addEventListener("open", () => {
      this.send({
        type: "hello",
        contractVersion: CAPY_TUNNEL_CONTRACT_VERSION,
        deviceId: this.deviceId,
        hostname: this.hostname,
        os: deviceOs(),
        workspaces: [],
        worktreeBase: this.worktreeBase,
        clientVersion: this.clientVersion,
      });
    });
    ws.addEventListener("message", (event) => this.onMessage(event));
    ws.addEventListener("close", (event) => {
      this.ready = false;
      this.ws = null;
      const reason = String(event.reason || "");
      const rejected = [4001, 4003, 4401, 4403].includes(Number(event.code)) || /auth|token|unauthor|forbidden/iu.test(reason);
      const err = new CapyApiError(`Capy 设备隧道已关闭（${event.code}${reason ? `：${reason}` : ""}）`, {
        code: rejected ? "device_token_rejected" : "device_connect_failed",
      });
      onReject(err);
    });
    ws.addEventListener("error", () => {
      onReject(new CapyApiError("Capy 设备隧道连接失败", { code: "device_connect_failed" }));
    });

    try {
      await ready;
    } finally {
      clearTimeout(timer);
      this.readyResolve = null;
      this.readyReject = null;
    }
    this.ready = true;
  }

  send(frame) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try { this.ws.send(JSON.stringify(frame)); return true; } catch { return false; }
  }

  sendBinary(bytes) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try { this.ws.send(bytes); return true; } catch { return false; }
  }

  onMessage(event) {
    if (typeof event.data === "string") return this.onControl(event.data);
    const decoded = decodeTunnelDataFrame(event.data);
    if (!decoded) return undefined;
    const stream = this.streams.get(decoded.streamId);
    if (stream) stream.body = Buffer.concat([stream.body, decoded.body]);
    return undefined;
  }

  onControl(text) {
    let frame;
    try { frame = JSON.parse(text); } catch { return; }
    const type = String(frame.type ?? "");
    if (type === "ping") { this.send({ type: "pong" }); return; }
    if (type === "session-config") {
      // The handshake finishes here, and WE have to say ready — see the file
      // header. Waiting for an inbound `ready` gets a 1011 timeout instead.
      this.send({ type: "workspaces-changed", workspaces: [] });
      this.send({ type: "ready" });
      this.readyResolve?.();
      return;
    }
    if (type === "open") {
      const streamId = Number(frame.streamId);
      if (!Number.isInteger(streamId)) return;
      this.streams.set(streamId, {
        streamId,
        kind: String(frame.kind ?? "invoke"),
        method: String(frame.method ?? ""),
        path: String(frame.path ?? ""),
        body: Buffer.alloc(0),
      });
      return;
    }
    if (type === "close") {
      const streamId = Number(frame.streamId);
      const stream = this.streams.get(streamId);
      if (stream) this.runStream(stream);
    }
  }

  runStream(stream) {
    this.streams.delete(stream.streamId);
    let outcome;
    try {
      outcome = this.handleStream(stream);
    } catch (e) {
      outcome = fail("MachineServer.Internal", String(e?.message ?? e));
    }
    this.respond(stream.streamId, outcome);
  }

  handleStream(stream) {
    if (stream.path.startsWith("/v1/git/capture")) return ok({ repos: [], baseRefs: ["origin/HEAD"] });
    if (!stream.path.startsWith("/v1/invocations")) {
      return fail("MachineServer.Unavailable", `unsupported path ${stream.path}`);
    }
    let record = {};
    try {
      record = stream.body.length ? JSON.parse(stream.body.toString("utf8")) : {};
    } catch { /* malformed body → treated as an unknown handler */ }
    const handler = String(record.handler ?? "");
    const params = record.params && typeof record.params === "object" ? record.params : {};
    this.logger?.debug?.("CAPY", `tunnel rpc ${handler}`);
    return capyMachineResult(handler, params, this.state);
  }

  respond(streamId, outcome) {
    const body = Buffer.from(JSON.stringify(outcome));
    this.send({
      type: "response",
      streamId,
      status: 200,
      headers: { "content-type": "application/json", "content-length": String(body.length) },
    });
    this.sendBinary(encodeTunnelDataFrame(streamId, body));
    this.send({ type: "close", streamId });
  }
}

/**
 * Per-connection tunnel registry. One tunnel per (orgId, deviceId); concurrent
 * callers share the same ensure() promise so a burst of requests dials once.
 * `close()` is idempotent and is what the executor calls when a connection is
 * dropped or the process shuts down.
 */
export class CapyTunnelRegistry {
  constructor({ worktreeBase, WebSocketImpl, logger } = {}) {
    this.tunnels = new Map();
    this.inflight = new Map();
    this.worktreeBase = worktreeBase || path.join(process.cwd(), ".capy-worktrees");
    this.WebSocketImpl = WebSocketImpl;
    this.logger = logger;
  }

  key(orgId, deviceId) {
    return `${orgId}:${deviceId}`;
  }

  /**
   * Bring a device online and wait until Capy agrees it is connected. Returns
   * the tunnel. A token the server rejects triggers one re-pair via `repair`,
   * because a stale `capyd_` token is indistinguishable from a revoked device
   * until you dial.
   */
  async ensure({ orgId, deviceId, token, hostname, listDevices, repair }, timeoutMs) {
    const key = this.key(orgId, deviceId);
    const live = this.tunnels.get(key);
    if (live?.connected) return live;
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const task = (async () => {
      let current = token;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const tunnel = new CapyDeviceTunnel({
          orgId, deviceId, token: current, hostname,
          worktreeBase: this.worktreeBase, WebSocketImpl: this.WebSocketImpl, logger: this.logger,
        });
        try {
          await tunnel.ensure(timeoutMs);
          if (typeof listDevices === "function") {
            const connected = await waitConnected(listDevices, deviceId);
            if (!connected) {
              tunnel.close();
              throw new CapyApiError("无头设备已连上隧道，但服务端没有标记 connected", { code: "device_not_connected" });
            }
          }
          this.tunnels.set(key, tunnel);
          return tunnel;
        } catch (e) {
          tunnel.close();
          const rejected = e?.code === "device_token_rejected";
          if (!rejected || attempt === 2 || typeof repair !== "function") throw e;
          this.logger?.warn?.("CAPY", `tunnel token rejected for ${deviceId}; re-pairing`);
          const next = await repair();
          if (!next?.token) throw e;
          current = next.token;
        }
      }
      throw new CapyApiError("无头设备连接失败", { code: "device_connect_failed" });
    })();

    this.inflight.set(key, task);
    try { return await task; } finally { this.inflight.delete(key); }
  }

  get(orgId, deviceId) {
    return this.tunnels.get(this.key(orgId, deviceId)) ?? null;
  }

  close(orgId, deviceId) {
    const key = this.key(orgId, deviceId);
    const tunnel = this.tunnels.get(key);
    if (tunnel) { tunnel.close(); this.tunnels.delete(key); }
  }

  closeAll() {
    for (const tunnel of this.tunnels.values()) tunnel.close();
    this.tunnels.clear();
    this.inflight.clear();
  }
}

async function waitConnected(listDevices, deviceId, deadlineMs = READY_TIMEOUT_MS) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const devices = await listDevices().catch(() => []);
    const list = Array.isArray(devices) ? devices : devices?.items ?? [];
    const hit = list.find((d) => d?.id === deviceId);
    if (hit?.connected) return true;
    await new Promise((r) => setTimeout(r, CONNECT_POLL_MS));
  }
  return false;
}