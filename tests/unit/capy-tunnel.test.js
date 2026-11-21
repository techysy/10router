import assert from "node:assert/strict";
import {
  CapyDeviceTunnel,
  CapyTunnelRegistry,
  capyMachineResult,
  encodeTunnelDataFrame,
  decodeTunnelDataFrame,
  deviceOs,
  deviceArch,
} from "../../open-sse/shared/capy/tunnel.js";
import { capyPairDevice } from "../../open-sse/shared/capy/client.js";

let testApi;
try {
  testApi = await import("vitest");
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  testApi = await import("node:test");
}
const { it } = testApi;

/**
 * Minimal WebSocket stand-in: records what the tunnel sends and lets the test
 * push server frames in. No network, no timers beyond what the test drives.
 */
class FakeSocket {
  static instances = [];

  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.readyState = 1;
    this.binaryType = "arraybuffer";
    this.sent = [];
    this.listeners = { open: [], message: [], close: [], error: [] };
    FakeSocket.instances.push(this);
    // Dial asynchronously like a real socket.
    queueMicrotask(() => this.emit("open", {}));
  }

  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }

  emit(type, event) {
    for (const fn of this.listeners[type] ?? []) fn(event);
  }

  send(data) {
    this.sent.push(typeof data === "string" ? JSON.parse(data) : data);
  }

  close(code = 1000, reason = "") {
    this.readyState = 3;
    this.emit("close", { code, reason });
  }

  get controlSent() {
    return this.sent.filter((f) => f && typeof f === "object" && !Buffer.isBuffer(f) && !ArrayBuffer.isView(f));
  }
}

function newTunnel(overrides = {}) {
  FakeSocket.instances = [];
  return new CapyDeviceTunnel({
    orgId: "org_1",
    deviceId: "dev_1",
    token: "capyd_test",
    hostname: "test-host",
    worktreeBase: "/tmp/10router-wt-test",
    WebSocketImpl: FakeSocket,
    ...overrides,
  });
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// ── wire helpers ──────────────────────────────────────────────────────────────

it("data frames are a big-endian uint32 id followed by the body", () => {
  const body = Buffer.from('{"handler":"worktree_list"}');
  const frame = encodeTunnelDataFrame(7, body);
  assert.equal(frame.readUInt32BE(0), 7);
  assert.equal(frame.subarray(4).toString("utf8"), body.toString("utf8"));

  const back = decodeTunnelDataFrame(frame);
  assert.equal(back.streamId, 7);
  // The decoder must not copy: the body is a view over the same buffer.
  assert.equal(back.body.toString("utf8"), body.toString("utf8"));
  assert.equal(decodeTunnelDataFrame(Buffer.alloc(2)), null);
});

it("uses the wire enum, not host strings", () => {
  assert.equal(deviceOs("win32"), "win32");
  assert.equal(deviceOs("darwin"), "darwin");
  assert.equal(deviceOs("freebsd"), "linux");
  assert.equal(deviceArch("arm64"), "arm64");
  // "x64" is a 400 with an empty body — the enum is x86_64.
  assert.equal(deviceArch("x64"), "x86_64");
});

// ── handshake ─────────────────────────────────────────────────────────────────

it("sends hello on open and completes the handshake by sending ready ourselves", async () => {
  const tunnel = newTunnel();
  const ready = tunnel.ensure(5000);
  await tick();
  const sock = FakeSocket.instances.at(-1);

  assert.equal(sock.url, "wss://device-tunnel-production.cloud.capy.ai/tunnel");
  assert.equal(sock.options.headers.authorization, "Bearer capyd_test");

  const hello = sock.controlSent.find((f) => f.type === "hello");
  assert.ok(hello, "hello must be sent on open");
  assert.equal(hello.contractVersion, 2);
  assert.equal(hello.deviceId, "dev_1");
  assert.equal(hello.os, deviceOs());
  assert.deepEqual(hello.workspaces, []);

  // The server opens with ping and session-config; ready is INBOUND-only.
  sock.emit("message", { data: JSON.stringify({ type: "ping" }) });
  assert.ok(sock.controlSent.some((f) => f.type === "pong"), "ping must be answered with pong");

  sock.emit("message", { data: JSON.stringify({ type: "session-config", bearer: "b" }) });
  await ready;

  const types = sock.controlSent.map((f) => f.type);
  assert.ok(types.includes("workspaces-changed"), "workspaces-changed is required before ready");
  assert.ok(types.includes("ready"), "the client must send ready; waiting for one times out");
  assert.ok(tunnel.connected);
  tunnel.close();
});

it("rejects when the socket closes with an auth code", async () => {
  const tunnel = newTunnel();
  const ready = tunnel.ensure(5000);
  await tick();
  const sock = FakeSocket.instances.at(-1);
  sock.close(4401, "unauthorized");
  await assert.rejects(ready, (e) => e.code === "device_token_rejected");
});

it("rejects when the socket closes for a non-auth reason", async () => {
  const tunnel = newTunnel();
  const ready = tunnel.ensure(5000);
  await tick();
  FakeSocket.instances.at(-1).close(1011, "boom");
  await assert.rejects(ready, (e) => e.code === "device_connect_failed");
});

// ── invocation serving ────────────────────────────────────────────────────────

async function connectedTunnel() {
  const tunnel = newTunnel();
  const ready = tunnel.ensure(5000);
  await tick();
  const sock = FakeSocket.instances.at(-1);
  sock.emit("message", { data: JSON.stringify({ type: "session-config" }) });
  await ready;
  return { tunnel, sock };
}

it("serves an invocation stream: response + binary body + close", async () => {
  const { tunnel, sock } = await connectedTunnel();
  const body = JSON.stringify({ invocationId: "inv_1", handler: "worktree_list", params: { roots: [] } });

  sock.emit("message", { data: JSON.stringify({ type: "open", streamId: 3, kind: "invoke", method: "POST", path: "/v1/invocations?wait=25000" }) });
  sock.emit("message", { data: encodeTunnelDataFrame(3, Buffer.from(body)) });
  sock.emit("message", { data: JSON.stringify({ type: "close", streamId: 3 }) });

  const response = sock.controlSent.find((f) => f.type === "response" && f.streamId === 3);
  assert.ok(response, "a response frame must be sent");
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "application/json");

  const binary = sock.sent.filter((d) => Buffer.isBuffer(d) && d.readUInt32BE(0) === 3);
  assert.equal(binary.length, 1, "exactly one binary body frame");
  const decoded = JSON.parse(binary[0].subarray(4).toString("utf8"));
  assert.equal(decoded.status, "succeeded");
  assert.equal(decoded.result.kind, "worktree_list");

  assert.ok(sock.controlSent.some((f) => f.type === "close" && f.streamId === 3));
  tunnel.close();
});

it("handles a body that arrives split across several binary frames", async () => {
  const { tunnel, sock } = await connectedTunnel();
  const body = Buffer.from(JSON.stringify({ handler: "volume_probe", params: { mounts: [{ mountPath: "~/a" }] } }));
  const half = Math.floor(body.length / 2);

  sock.emit("message", { data: JSON.stringify({ type: "open", streamId: 9, path: "/v1/invocations" }) });
  sock.emit("message", { data: encodeTunnelDataFrame(9, body.subarray(0, half)) });
  sock.emit("message", { data: encodeTunnelDataFrame(9, body.subarray(half)) });
  sock.emit("message", { data: JSON.stringify({ type: "close", streamId: 9 }) });

  const binary = sock.sent.filter((d) => Buffer.isBuffer(d) && d.readUInt32BE(0) === 9);
  const decoded = JSON.parse(binary[0].subarray(4).toString("utf8"));
  assert.equal(decoded.status, "succeeded");
  assert.equal(decoded.result.mounts[0].state, "current");
  tunnel.close();
});

it("answers an unknown path with MachineServer.Unavailable rather than hanging", async () => {
  const { tunnel, sock } = await connectedTunnel();
  sock.emit("message", { data: JSON.stringify({ type: "open", streamId: 4, path: "/v1/nope" }) });
  sock.emit("message", { data: JSON.stringify({ type: "close", streamId: 4 }) });
  const binary = sock.sent.filter((d) => Buffer.isBuffer(d) && d.readUInt32BE(0) === 4);
  const decoded = JSON.parse(binary[0].subarray(4).toString("utf8"));
  assert.equal(decoded.status, "failed");
  assert.equal(decoded.error.code, "MachineServer.Unavailable");
  tunnel.close();
});

it("never lets a malformed body escape as an unhandled failure", async () => {
  const { tunnel, sock } = await connectedTunnel();
  sock.emit("message", { data: JSON.stringify({ type: "open", streamId: 5, path: "/v1/invocations" }) });
  sock.emit("message", { data: encodeTunnelDataFrame(5, Buffer.from("{not json")) });
  sock.emit("message", { data: JSON.stringify({ type: "close", streamId: 5 }) });
  const binary = sock.sent.filter((d) => Buffer.isBuffer(d) && d.readUInt32BE(0) === 5);
  assert.equal(binary.length, 1, "a response is still sent");
  tunnel.close();
});

// ── machine RPC ───────────────────────────────────────────────────────────────

it("worktree_ensure refuses a root outside worktreeBase", () => {
  const state = { root: null, worktreeBase: "/tmp/base" };
  const out = capyMachineResult("worktree_ensure", { root: "/etc" }, state);
  assert.equal(out.status, "failed");
  assert.equal(out.error.code, "MachineServer.Refused");
});

it("worktree_ensure creates a root under worktreeBase and records it", () => {
  const state = { root: null, worktreeBase: "/tmp/base-check" };
  const out = capyMachineResult("worktree_ensure", { root: "/tmp/base-check/jam_1" }, state);
  assert.equal(out.status, "succeeded");
  assert.equal(state.root, "/tmp/base-check/jam_1");
});

it("unimplemented handlers answer Unavailable instead of pretending", () => {
  const state = { root: null, worktreeBase: "/tmp/base" };
  const out = capyMachineResult("browser_navigate", {}, state);
  assert.equal(out.status, "failed");
  assert.equal(out.error.code, "MachineServer.Unavailable");
});

// ── registry ──────────────────────────────────────────────────────────────────

it("registry shares one tunnel across concurrent ensures", async () => {
  FakeSocket.instances = [];
  const registry = new CapyTunnelRegistry({ worktreeBase: "/tmp/reg", WebSocketImpl: FakeSocket });
  const params = { orgId: "org_1", deviceId: "dev_1", token: "capyd_x", hostname: "h" };

  const p1 = registry.ensure(params);
  const p2 = registry.ensure(params);
  await tick();
  // Only one socket should have been dialled for the same device.
  assert.equal(FakeSocket.instances.length, 1);

  const sock = FakeSocket.instances.at(-1);
  sock.emit("message", { data: JSON.stringify({ type: "session-config" }) });
  const [t1, t2] = await Promise.all([p1, p2]);
  assert.equal(t1, t2, "both callers share the same tunnel");
  registry.closeAll();
});

it("registry re-pairs once when the token is rejected", async () => {
  FakeSocket.instances = [];
  const registry = new CapyTunnelRegistry({ worktreeBase: "/tmp/reg2", WebSocketImpl: FakeSocket });
  let repairs = 0;
  const params = {
    orgId: "org_1", deviceId: "dev_1", token: "capyd_stale", hostname: "h",
    repair: async () => { repairs += 1; return { token: "capyd_fresh" }; },
  };

  const ensure = registry.ensure(params);
  await tick();
  FakeSocket.instances.at(-1).close(4401, "unauthorized");
  await tick();
  await tick();

  const second = FakeSocket.instances.at(-1);
  assert.equal(repairs, 1, "a rejected token triggers exactly one re-pair");
  assert.equal(second.options.headers.authorization, "Bearer capyd_fresh");
  second.emit("message", { data: JSON.stringify({ type: "session-config" }) });
  await ensure;
  registry.closeAll();
});

// ── pairing ───────────────────────────────────────────────────────────────────

function pairFetch({ userCode = "AAAA-BBBB", deviceCode = "capydc_1", status = "approved", token = "capyd_paired", denyApprove = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    const json = (body, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
    if (u.includes("/devices/code") && !u.includes("/poll") && !u.includes("/approve")) {
      return json({ userCode, deviceCode, verificationUrl: "https://capy.ai/x", expiresInSeconds: 300, pollIntervalSeconds: 1 });
    }
    if (u.includes("/devices/code/approve")) {
      if (denyApprove) return json({ error: "nope" }, 403);
      return json({ status: "approved" });
    }
    if (u.includes("/devices/code/poll")) {
      if (status === "approved") {
        return json({ status, enrolled: { orgId: "org_1", device: { id: "dev_paired" }, token } });
      }
      return json({ status });
    }
    return json({ error: "unmocked" }, 500);
  };
  return { fetchImpl, calls };
}

it("pairing self-approves with our own JWT and returns the capyd_ token", async () => {
  const { fetchImpl, calls } = pairFetch();
  const out = await capyPairDevice("jwt-1", "org_1", {
    name: "10router-headless", hostname: "h", os: "linux", arch: "x86_64",
    sleep: async () => {},
  }, { fetchImpl });

  assert.equal(out.deviceId, "dev_paired");
  assert.equal(out.token, "capyd_paired");
  assert.equal(out.orgId, "org_1");

  const start = calls.find((c) => c.url.endsWith("/devices/code"));
  const sent = JSON.parse(sentStart(start));
  assert.equal(sent.os, "linux");
  assert.equal(sent.arch, "x86_64", "the wire enum, not x64");
  assert.ok(calls.some((c) => c.url.includes("/devices/code/approve")), "approval is what makes pairing unattended");
});

function sentStart(call) {
  return call.init.body;
}

it("pairing fails fast when approval is refused", async () => {
  const { fetchImpl } = pairFetch({ denyApprove: true });
  await assert.rejects(
    capyPairDevice("jwt-1", "org_1", { name: "n", hostname: "h", os: "linux", arch: "x86_64", sleep: async () => {} }, { fetchImpl }),
    (e) => e.code === "device_pair_failed",
  );
});

it("pairing reports a denied device code", async () => {
  const { fetchImpl } = pairFetch({ status: "denied" });
  await assert.rejects(
    capyPairDevice("jwt-1", "org_1", { name: "n", hostname: "h", os: "linux", arch: "x86_64", sleep: async () => {} }, { fetchImpl }),
    (e) => e.code === "device_pair_failed",
  );
});