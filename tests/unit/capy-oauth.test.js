import assert from "node:assert/strict";
import { sendCapyCode, loginCapyByCode } from "../../src/lib/oauth/providers/capy.js";
import { CapyExecutor } from "../../open-sse/executors/capy.js";

let testApi;
try {
  testApi = await import("vitest");
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  testApi = await import("node:test");
}
const { it } = testApi;

// ── Fake Clerk FAPI + api.capy.ai/app server ─────────────────────────────────
// Emulates the exact surfaces the client uses: client creation, sign_ins
// (email_code), session token mint, org/device/model lists, jam list+create,
// message post, the NDJSON event stream, and batch jam delete.
function fakeCapyServer({
  code = "123456",
  models = [{ id: "particle/particle-1", name: "Particle-1" }],
  devices = [{ id: "dev_1", machineId: "mach_1", connected: true }],
  orgs = [{ id: "org_1", name: "ws", accessLevel: "member" }],
  sessionJwt = "fixture-session-jwt",
  rotatedClientJwt = null,
  events = [],
  wrongCodeError = { errors: [{ code: "form_code_incorrect", message: "incorrect" }] },
  jamList = [{ id: "jam_existing_1", status: "idle" }],
} = {}) {
  const calls = [];
  const enrolled = [];
  const shared = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    const json = (body, status = 200, extra = {}) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...extra },
      });
    const rotatedHdrs = (jwt) => ({ authorization: `Bearer ${jwt}` });

    // ── Clerk FAPI ──
    if (u.includes("clerk.capy.ai/v1/client?")) {
      return json({ response: { sessions: [] } }, 200, rotatedHdrs("client-jwt-1"));
    }
    if (u.includes("/v1/client/sign_ins?")) {
      return json({
        response: {
          id: "sin_1",
          status: "needs_first_factor",
          supported_first_factors: [{ strategy: "email_code", email_address_id: "idn_1" }],
        },
      }, 200, rotatedHdrs("client-jwt-2"));
    }
    if (u.includes("/prepare_first_factor")) {
      return json({ response: {} }, 200, rotatedHdrs("client-jwt-3"));
    }
    if (u.includes("/attempt_first_factor")) {
      const sent = new URLSearchParams(init.body).get("code");
      if (sent !== code) return json(wrongCodeError, 422);
      return json({
        response: { status: "complete", created_session_id: "sess_1", user_id: "user_1" },
      }, 200, rotatedHdrs("client-jwt-4"));
    }
    if (u.includes("/sessions/sess_1/tokens")) {
      return json({ jwt: sessionJwt }, 200, rotatedHdrs(rotatedClientJwt || "client-jwt-5"));
    }

    // ── api.capy.ai/app ──
    if (u.includes("api.capy.ai/app/organizations")) {
      return json(orgs);
    }
    // Enroll: the wire enum shape is validated so a bad os/arch is caught here.
    if (u.endsWith("/devices/enroll") && (init.method ?? "GET") === "POST") {
      const body = JSON.parse(init.body || "{}");
      if (!["win32", "darwin", "linux"].includes(body.os) || !["x86_64", "arm64"].includes(body.arch)) {
        return json({ _tag: "capy/InvalidRequest" }, 400);
      }
      enrolled.push(body);
      return json([{ orgId: orgs[0].id, device: { id: "dev_enrolled", machineId: "mach_e", connected: false } }]);
    }
    // Device access change (share)
    if (u.match(/\/devices\/[^/]+\/access$/) && (init.method ?? "GET") === "POST") {
      shared.push({ url: u, body: JSON.parse(init.body || "{}") });
      return json({ id: "dev_enrolled", access: "shared" });
    }
    if (u.match(/\/orgs\/[^/]+\/devices$/) && (init.method ?? "GET") === "GET") {
      return json(devices);
    }
    if (u.includes("/models?")) {
      return json(models);
    }
    // Jam list (GET /jams) — return existing idle jams
    if (u.match(/\/app\/orgs\/[^/]+\/jams(\?|$)/) && (init.method ?? "GET") === "GET") {
      return json(jamList);
    }
    // Jam create (POST /jams)
    if (u.match(/\/app\/orgs\/[^/]+\/jams$/) && (init.method ?? "GET") === "POST") {
      return json({ id: "jam_created_1" });
    }
    // Message post (POST /jams/:id/message)
    if (u.match(/\/app\/orgs\/[^/]+\/jams\/[^/]+\/message$/) && (init.method ?? "GET") === "POST") {
      return json({ id: "msg_1", deduped: false });
    }
    // Events (GET /jams/:id/events)
    if (u.match(/\/app\/orgs\/[^/]+\/jams\/[^/]+\/events(\?|$)/) && (init.method ?? "GET") === "GET") {
      const items = events.map((e) => e.item ?? e).filter(Boolean);
      return json({ items, cursor: "c1" });
    }
    // NDJSON event stream
    if (u.includes("/events/stream")) {
      const ndjson = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
      return new Response(ndjson, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      });
    }
    // Jam delete
    if (u.includes("/jams/delete")) {
      return json({ deleted: true });
    }
    return json({ error: `unmocked ${u}` }, 500);
  };
  return { fetchImpl, calls, enrolled, shared };
}

const assistantEvent = (text, state = "final", id = "ev_1") => ({
  kind: "event",
  item: {
    id,
    kind: "assistant",
    payload: {
      blocks: [{ type: "tool_use", toolName: "message_user", args: { text, state } }],
      usage: { inputTokens: 10, outputTokens: 3 },
      stopReason: "end_turn",
    },
  },
});

function executorCredentials(overrides = {}) {
  return {
    refreshToken: "client-jwt-stored",
    providerSpecificData: {
      sessionId: "sess_1",
      orgId: "org_1",
      deviceId: "dev_1",
      jamId: "jam_existing_1",
    },
    ...overrides,
  };
}

// ── Login flow ────────────────────────────────────────────────────────────────

it("sendCapyCode runs the native Clerk email-code flow and returns a flowId", async () => {
  const { fetchImpl, calls } = fakeCapyServer();
  const r = await sendCapyCode("a@b.co", { fetchImpl });
  assert.ok(r.flowId);
  assert.ok(r.expiresIn > 0);

  for (const c of calls) {
    if (!c.url.includes("clerk.capy.ai")) continue;
    assert.ok(c.url.includes("_is_native=1"), `missing _is_native: ${c.url}`);
    assert.ok(c.url.includes("__clerk_api_version="));
    assert.equal(c.init.headers.Origin, "capy://app");
  }
  const prep = calls.find((c) => c.url.includes("prepare_first_factor"));
  assert.equal(new URLSearchParams(prep.init.body).get("email_address_id"), "idn_1");
});

it("loginCapyByCode verifies the code and assembles a connection after model access is proven", async () => {
  const { fetchImpl, calls } = fakeCapyServer();
  const { flowId } = await sendCapyCode("a@b.co", { fetchImpl });
  const r = await loginCapyByCode({ flowId, code: "123456" }, { fetchImpl });

  assert.equal(r.sessionId, "sess_1");
  assert.equal(r.userId, "user_1");
  assert.equal(r.orgId, "org_1");
  assert.equal(r.deviceId, "dev_1");
  assert.equal(r.sessionJwt, "fixture-session-jwt");
  assert.equal(r.modelCount, 1);
  assert.equal(r.clientJwt, "client-jwt-5");
  // Reuses the existing idle jam
  assert.equal(r.jamId, "jam_existing_1");

  const mint = calls.find((c) => c.url.includes("/sessions/sess_1/tokens"));
  assert.equal(mint.init.headers.Origin, "capy://app");
  assert.equal(mint.init.headers.Authorization, "Bearer client-jwt-4");

  const orgCall = calls.find((c) => c.url.includes("/app/organizations"));
  assert.equal(orgCall.init.headers.Authorization, "Bearer fixture-session-jwt");
});

it("rejects a wrong code with wrong_code and does not consume the account", async () => {
  const { fetchImpl } = fakeCapyServer();
  const { flowId } = await sendCapyCode("a@b.co", { fetchImpl });
  await assert.rejects(
    loginCapyByCode({ flowId, code: "000000" }, { fetchImpl }),
    (e) => e.code === "wrong_code",
  );
});

it("refuses to store a connection when the account cannot list models", async () => {
  const { fetchImpl } = fakeCapyServer({ models: [] });
  const { flowId } = await sendCapyCode("a@b.co", { fetchImpl });
  await assert.rejects(
    loginCapyByCode({ flowId, code: "123456" }, { fetchImpl }),
    (e) => e.code === "no_model_access",
  );
});

it("refuses an unknown/expired flowId", async () => {
  const { fetchImpl } = fakeCapyServer();
  await assert.rejects(
    loginCapyByCode({ flowId: "nope", code: "123456" }, { fetchImpl }),
    (e) => e.code === "flow_expired",
  );
});

it("provisions a new jam when no idle jam exists and a device is available", async () => {
  const { fetchImpl } = fakeCapyServer({ jamList: [] });
  const { flowId } = await sendCapyCode("a@b.co", { fetchImpl });
  const r = await loginCapyByCode({ flowId, code: "123456" }, { fetchImpl });
  assert.equal(r.jamId, "jam_created_1");
});

it("enrolls a device and shares it when the account has none", async () => {
  const { fetchImpl, enrolled, shared } = fakeCapyServer({ jamList: [], devices: [] });
  const { flowId } = await sendCapyCode("a@b.co", { fetchImpl });
  const r = await loginCapyByCode({ flowId, code: "123456" }, { fetchImpl });

  // Enrolled with the wire enum the endpoint demands, not host strings.
  assert.equal(enrolled.length, 1, "expected exactly one enroll call");
  assert.equal(enrolled[0].arch, process.arch === "arm64" ? "arm64" : "x86_64");
  assert.ok(["win32", "darwin", "linux"].includes(enrolled[0].os));
  assert.deepEqual(enrolled[0].heldOrgIds, []);
  assert.deepEqual(enrolled[0].deviceIds, []);

  // The enrolled device is offline, but it is what a jam gets created against.
  assert.equal(r.deviceId, "dev_enrolled");
  assert.equal(r.deviceEnrolled, true);
  assert.equal(r.deviceConnected, false);

  // Shared so every org member can use it, not just whoever enrolled it.
  assert.equal(shared.length, 1);
  assert.deepEqual(shared[0].body, { access: "shared" });
});

it("does not enroll when the account already has a device", async () => {
  const { fetchImpl, enrolled, shared } = fakeCapyServer();
  const { flowId } = await sendCapyCode("a@b.co", { fetchImpl });
  const r = await loginCapyByCode({ flowId, code: "123456" }, { fetchImpl });
  assert.equal(enrolled.length, 0, "must not enroll over an existing device");
  assert.equal(shared.length, 0);
  assert.equal(r.deviceEnrolled, false);
  assert.equal(r.deviceId, "dev_1");
});

it("still logs in when enroll fails, leaving deviceId null", async () => {
  const inner = fakeCapyServer({ jamList: [], devices: [] });
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith("/devices/enroll")) {
      return new Response(JSON.stringify({ _tag: "capy/InvalidRequest" }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }
    return inner.fetchImpl(url, init);
  };
  const { flowId } = await sendCapyCode("a@b.co", { fetchImpl });
  const r = await loginCapyByCode({ flowId, code: "123456" }, { fetchImpl });
  assert.equal(r.deviceId, null);
  assert.equal(r.deviceEnrolled, false);
  // Login is not blocked by an enrollment failure — the executor reports it.
  assert.equal(r.modelCount, 1);
});

it("leaves jamId null when jam creation fails, so the executor retries on demand", async () => {
  // Enrolling succeeds (so deviceId is set) but the jam create is rejected —
  // the connection is still stored, and the executor tries again per request.
  const inner = fakeCapyServer({ jamList: [], devices: [] });
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.match(/\/orgs\/[^/]+\/jams$/) && (init.method ?? "GET") === "POST") {
      return new Response(JSON.stringify({ _tag: "capy/InvalidRequest", message: "This device is offline" }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }
    return inner.fetchImpl(url, init);
  };
  const { flowId } = await sendCapyCode("a@b.co", { fetchImpl });
  const r = await loginCapyByCode({ flowId, code: "123456" }, { fetchImpl });
  assert.equal(r.jamId, null);
  assert.equal(r.deviceId, "dev_enrolled", "the enrolled device is still recorded");
});

// ── Wiring ────────────────────────────────────────────────────────────────────

it("registers a specialized executor and registry entry", async () => {
  const { getExecutor, hasSpecializedExecutor } = await import("../../open-sse/executors/index.js");
  const REGISTRY = (await import("../../open-sse/providers/registry/index.js")).default;
  const entry = REGISTRY.find((r) => r.id === "capy");
  assert.ok(entry, "capy registry entry missing");
  assert.equal(entry.category, "oauth");
  assert.ok(entry.models.length > 0);
  assert.ok(entry.passthroughModels);
  assert.ok(hasSpecializedExecutor("capy"));
  assert.equal(getExecutor("capy").constructor.name, "CapyExecutor");
});

// ── Executor ──────────────────────────────────────────────────────────────────

async function readSse(response) {
  const text = await response.text();
  return {
    text,
    chunks: text
      .split("\n\n")
      .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
      .map((l) => JSON.parse(l.slice(6))),
    done: text.includes("data: [DONE]"),
  };
}

it("streams a Capy agent turn as OpenAI SSE via reused jam + message post", async () => {
  const { fetchImpl, calls } = fakeCapyServer({
    events: [assistantEvent("pong")],
  });
  const executor = new CapyExecutor("capy", { fetchImpl });
  const persisted = [];
  const { response } = await executor.execute({
    model: "particle/particle-1",
    body: { messages: [{ role: "user", content: "ping" }] },
    stream: true,
    credentials: executorCredentials(),
    onCredentialsRefreshed: async (c) => persisted.push(c),
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const { chunks, done } = await readSse(response);
  assert.equal(chunks[0].choices[0].delta.role, "assistant");
  const text = chunks.map((c) => c.choices[0].delta?.content ?? "").join("");
  assert.equal(text, "pong");
  const last = chunks[chunks.length - 1];
  assert.equal(last.choices[0].finish_reason, "stop");
  assert.equal(last.usage.total_tokens, 13);
  assert.ok(done);

  // Message was posted to the reused jam, not a new one
  const msg = calls.find((c) => c.url.includes("/message") && c.init.method === "POST");
  assert.ok(msg, "should post a message to the jam");
  const msgBody = JSON.parse(msg.init.body);
  assert.equal(msgBody.text, "User: ping");
  assert.equal(msgBody.model.modelId, "particle/particle-1");

  // No jam creation needed when reusing an existing one
  const create = calls.find((c) => c.url.match(/\/jams$/) && c.init.method === "POST");
  assert.ok(!create, "should not create a new jam when one is reused");

  // No cleanup — jam is reused across requests
  await new Promise((r) => setTimeout(r, 20));
  const del = calls.find((c) => c.url.includes("/jams/delete"));
  assert.ok(!del, "should not delete the reused jam");

  // Rotated client JWT was persisted through onCredentialsRefreshed
  assert.equal(persisted.at(-1).refreshToken, "client-jwt-5");
});

it("returns one chat.completion JSON when stream=false", async () => {
  const { fetchImpl } = fakeCapyServer({
    events: [assistantEvent("hi there")],
  });
  const executor = new CapyExecutor("capy", { fetchImpl });
  const { response } = await executor.execute({
    model: "particle/particle-1",
    body: { messages: [{ role: "user", content: "hi" }] },
    stream: false,
    credentials: executorCredentials(),
  });
  const json = await response.json();
  assert.equal(json.object, "chat.completion");
  assert.equal(json.choices[0].message.content, "hi there");
  assert.equal(json.choices[0].finish_reason, "stop");
});

it("flattens multi-turn OpenAI messages into the jam message text", async () => {
  const { fetchImpl, calls } = fakeCapyServer({
    events: [assistantEvent("ok")],
  });
  const executor = new CapyExecutor("capy", { fetchImpl });
  await executor.execute({
    model: "m",
    body: {
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "assistant", content: "hi" },
        { role: "user", content: "next" },
      ],
    },
    stream: false,
    credentials: executorCredentials(),
  });
  const msg = calls.find((c) => c.url.includes("/message") && c.init.method === "POST");
  const text = JSON.parse(msg.init.body).text;
  assert.ok(text.includes("System: be terse"));
  assert.ok(text.includes("User: hello"));
  assert.ok(text.includes("Assistant: hi"));
  assert.ok(text.endsWith("User: next"));
});

it("surfaces a synthetic 401 so chatCore retries via refreshCredentials", async () => {
  const { fetchImpl } = fakeCapyServer();
  const wrapped = async (url, init) => {
    if (String(url).includes("/tokens")) {
      return new Response(JSON.stringify({ errors: [{ code: "expired" }] }), { status: 401, headers: { "content-type": "application/json" } });
    }
    return fetchImpl(url, init);
  };
  const executor = new CapyExecutor("capy", { fetchImpl: wrapped });
  const { response } = await executor.execute({
    model: "m",
    body: { messages: [{ role: "user", content: "x" }] },
    stream: true,
    credentials: executorCredentials(),
  });
  assert.equal(response.status, 401);
});

it("creates a jam on demand when no jamId is persisted (device available)", async () => {
  const { fetchImpl, calls } = fakeCapyServer({
    events: [assistantEvent("ok")],
    jamList: [],
  });
  const executor = new CapyExecutor("capy", { fetchImpl });
  const { response } = await executor.execute({
    model: "m",
    body: { messages: [{ role: "user", content: "x" }] },
    stream: false,
    credentials: executorCredentials({ providerSpecificData: { sessionId: "sess_1", orgId: "org_1", deviceId: "dev_1" } }),
  });
  const json = await response.json();
  assert.equal(json.choices[0].message.content, "ok");
  const create = calls.find((c) => c.url.match(/\/jams$/) && c.init.method === "POST");
  assert.ok(create, "should create a jam when none is persisted");
  assert.equal(JSON.parse(create.init.body).device.deviceId, "dev_1");
});

it("ad model glm-5.3-flash-ads is in the registry and passes through", async () => {
  const REGISTRY = (await import("../../open-sse/providers/registry/index.js")).default;
  const entry = REGISTRY.find((r) => r.id === "capy");
  const adModel = entry.models.find((m) => m.id === "zai/glm-5.3-flash-ads");
  assert.ok(adModel, "glm-5.3-flash-ads must be in the registry");
  assert.equal(entry.passthroughModels, true);
});
