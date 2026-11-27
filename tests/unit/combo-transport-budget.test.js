// Issue #176: a combo whose first member's upstream is transport-dead (accepts
// TCP, never returns response headers) took the full DELIVERY budget to hand off.
// Worst case measured by the reporter: 4 attempts × 60s connect timeout +
// 3 × 3s retry delays ≈ 249s for one seat — because the probe reused the delivery
// timeout, mapped the exception onto the 502 retry ladder, and remembered nothing
// across requests.
//
// These tests drive the REAL BaseExecutor against REAL sockets, not mocks of
// itself: a blackhole server that accepts and never answers is exactly the failure
// shape the issue describes.
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from "vitest";
import http from "node:http";
import { BaseExecutor } from "../../open-sse/executors/base.js";
import { handleComboChat } from "../../open-sse/services/combo.js";
import {
  isTransportCooling,
  recordTransportFailure,
  recordTransportSuccess,
  resetAllBreakers,
  transportCoolingRemainingMs,
  TRANSPORT_TRIP_THRESHOLD,
} from "../../open-sse/services/comboTransportBreaker.js";
import { markTransportFault, isTransportFault, createErrorResult } from "../../open-sse/utils/error.js";
import { COMBO_PROBE_TIMEOUT_MS } from "../../open-sse/config/runtimeConfig.js";

let blackholePort = 0;
let healthyPort = 0;
let blackholeServer;
let healthyServer;
let blackholeConnections = 0;

beforeAll(async () => {
  // Accepts the socket, then never writes a byte.
  blackholeServer = http.createServer(() => { /* deliberately never responds */ });
  blackholeServer.on("connection", () => { blackholeConnections++; });
  healthyServer = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "pong" }, finish_reason: "stop" }] }));
  });
  await new Promise((r) => blackholeServer.listen(0, "127.0.0.1", r));
  await new Promise((r) => healthyServer.listen(0, "127.0.0.1", r));
  blackholePort = blackholeServer.address().port;
  healthyPort = healthyServer.address().port;
});

afterAll(() => {
  blackholeServer?.close();
  healthyServer?.close();
});

beforeEach(() => resetAllBreakers());

function makeExecutor(baseUrl) {
  const ex = new BaseExecutor("mock", {
    baseUrls: [`${baseUrl}/v1/chat/completions`],
    headers: {},
    retry: {},
    timeoutMs: 60000,
    format: "openai",
  });
  ex.buildUrl = () => `${baseUrl}/v1/chat/completions`;
  ex.transformRequest = (model, body) => body;
  ex.buildHeaders = () => ({ "content-type": "application/json" });
  return ex;
}

const body = { model: "x", messages: [{ role: "user", content: "ping" }] };

describe("combo probe budget (#176 cause 1+2): a dead member hands off in seconds", () => {
  it("un-throttled executor waits the full connect window and retries 3× (the 249s shape)", async () => {
    const ex = makeExecutor(`http://127.0.0.1:${blackholePort}`);
    ex.config.retry = {}; // DEFAULT_RETRY_CONFIG[502] = {attempts:3, delayMs:3000}
    const t0 = Date.now();
    await expect(ex.execute({
      model: "x", body, stream: false, credentials: { apiKey: "k" },
      timeoutMsOverride: 1000,   // short so the test stays fast; the ladder still multiplies it
    })).rejects.toBeTruthy();
    const elapsed = Date.now() - t0;
    // 4 attempts × 1s + 3 × 3s delay ≈ 13s — the ladder fired, which is the bug.
    expect(elapsed).toBeGreaterThanOrEqual(12000);
  }, 30000);

  it("probe path skips the transport retry ladder and uses the short budget", async () => {
    const ex = makeExecutor(`http://127.0.0.1:${blackholePort}`);
    const t0 = Date.now();
    const err = await ex.execute({
      model: "x", body, stream: false, credentials: { apiKey: "k" },
      timeoutMsOverride: 1000,
      noTransportRetry: true,
    }).catch((e) => e);
    const elapsed = Date.now() - t0;
    expect(err).toBeInstanceOf(Error);
    // One 1s window, no 3×3s ladder.
    expect(elapsed).toBeLessThan(3000);
  }, 20000);

  it("a healthy member still answers under probe options (override must not break the good path)", async () => {
    const ex = makeExecutor(`http://127.0.0.1:${healthyPort}`);
    const result = await ex.execute({
      model: "x", body, stream: false, credentials: { apiKey: "k" },
      timeoutMsOverride: 5000, noTransportRetry: true,
    });
    expect(result.response.status).toBe(200);
  });

  it("COMBO_PROBE_TIMEOUT_MS is shorter than the delivery window by design", () => {
    expect(COMBO_PROBE_TIMEOUT_MS).toBeLessThan(60000);
    expect(COMBO_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(1000);
  });
});

describe("transport fault marker", () => {
  it("round-trips on a Response and stays invisible to JSON/enumeration", () => {
    const res = markTransportFault(new Response("{}"));
    expect(isTransportFault(res)).toBe(true);
    expect(Object.keys(res)).not.toContain("transport-fault");
    expect(JSON.stringify({ res })).not.toContain("transport");
  });

  it("is not set when the verdict is false, and tolerates junk", () => {
    expect(isTransportFault(markTransportFault(new Response("{}"), false))).toBe(false);
    expect(isTransportFault(null)).toBe(false);
    expect(isTransportFault(undefined)).toBe(false);
    expect(() => markTransportFault(null)).not.toThrow();
  });

  it("createErrorResult carries the flag only when asked", () => {
    expect(createErrorResult(502, "x", null, null, { transport: true }).transport).toBe(true);
    expect(createErrorResult(502, "x").transport).toBeUndefined();
  });
});

describe("member transport breaker (cause 3): remembers across requests", () => {
  it("trips only after the threshold of consecutive transport faults", () => {
    for (let i = 1; i < TRANSPORT_TRIP_THRESHOLD; i++) {
      expect(recordTransportFailure("c", "dead/x").cooldownMs).toBe(0);
      expect(isTransportCooling("c", "dead/x")).toBe(false);
    }
    const trip = recordTransportFailure("c", "dead/x");
    expect(trip.cooldownMs).toBeGreaterThan(0);
    expect(isTransportCooling("c", "dead/x")).toBe(true);
    expect(transportCoolingRemainingMs("c", "dead/x")).toBeGreaterThan(0);
  });

  it("a real answer resets the streak — one HTTP response is not a transport fault", () => {
    for (let i = 0; i < TRANSPORT_TRIP_THRESHOLD; i++) recordTransportFailure("c", "m");
    expect(isTransportCooling("c", "m")).toBe(true);
    recordTransportSuccess("c", "m");
    expect(isTransportCooling("c", "m")).toBe(false);
    expect(recordTransportFailure("c", "m").cooldownMs).toBe(0);
  });

  it("escalates the window on repeat trips and caps it", () => {
    // Default windows are 5min base / 1h cap — a Date-only fake clock lets six
    // full cooldowns elapse instantly. Trips must survive the window expiring
    // (that is the whole point of `trips`), so each next trip doubles.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const tripMs = [];
      for (let round = 0; round < 6; round++) {
        for (let i = 0; i < TRANSPORT_TRIP_THRESHOLD; i++) tripMs.push(recordTransportFailure("esc", "dead").cooldownMs);
        vi.advanceTimersByTime(24 * 60 * 60 * 1000); // far past any window
        expect(isTransportCooling("esc", "dead")).toBe(false); // elapsed → probeable again
      }
      const nonzero = tripMs.filter((ms) => ms > 0);
      expect(nonzero[0]).toBe(5 * 60 * 1000);        // first trip = base
      expect(nonzero[1]).toBe(10 * 60 * 1000);       // doubling
      expect(nonzero[nonzero.length - 1]).toBe(60 * 60 * 1000); // capped at 1h
      expect(nonzero.length).toBe(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it("scopes state per (combo, member) — a cool member elsewhere is unaffected", () => {
    for (let i = 0; i < TRANSPORT_TRIP_THRESHOLD; i++) recordTransportFailure("comboA", "dead/x");
    expect(isTransportCooling("comboA", "dead/x")).toBe(true);
    expect(isTransportCooling("comboB", "dead/x")).toBe(false);
    expect(isTransportCooling("comboA", "live/y")).toBe(false);
  });

  it("without a combo name it is inert (no cross-request state to leak)", () => {
    expect(recordTransportFailure(null, "m").cooldownMs).toBe(0);
    expect(isTransportCooling(null, "m")).toBe(false);
  });
});

describe("combo seat loop integration", () => {
  // handleSingleModelChat hands the seat loop a Response (combo.js reads .ok /
  // .status / .headers / .clone()), so the fakes are real Responses too.
  const mkResult = (ok, transport = false) => {
    const res = new Response(
      ok
        ? JSON.stringify({ choices: [{ message: { content: "pong" }, finish_reason: "stop" }] })
        : JSON.stringify({ error: { message: ok ? "" : "upstream hung" } }),
      {
        status: ok ? 200 : 502,
        statusText: ok ? "OK" : "Bad Gateway",
        headers: { "content-type": "application/json" },
      },
    );
    return transport ? markTransportFault(res, true) : res;
  };

  it("defers a cooled member to the back instead of dropping it", async () => {
    for (let i = 0; i < TRANSPORT_TRIP_THRESHOLD; i++) recordTransportFailure("repro", "dead/x");
    expect(isTransportCooling("repro", "dead/x")).toBe(true);

    const tried = [];
    const handleSingleModel = async (_b, m) => {
      tried.push(m);
      return mkResult(true);
    };
    await handleComboChat({
      body: { messages: [{ role: "user", content: "ping" }] },
      models: ["dead/x", "live/y"],
      handleSingleModel,
      log: { info() {}, warn() {}, error() {} },
      comboName: "repro",
      comboStrategy: "fallback",
    });
    // live/y first; dead/x is NOT removed — it just moves to the back.
    expect(tried).toEqual(["live/y"]);
  });

  it("still runs the cooled member when everyone else fails (deferred, not dropped)", async () => {
    for (let i = 0; i < TRANSPORT_TRIP_THRESHOLD; i++) recordTransportFailure("repro2", "dead/x");
    const tried = [];
    const handleSingleModel = async (_b, m) => {
      tried.push(m);
      return m === "live/y" ? mkResult(false) : mkResult(true);
    };
    await handleComboChat({
      body: { messages: [{ role: "user", content: "ping" }] },
      models: ["dead/x", "live/y"],
      handleSingleModel,
      log: { info() {}, warn() {}, error() {} },
      comboName: "repro2",
      comboStrategy: "fallback",
    });
    expect(tried).toEqual(["live/y", "dead/x"]);
  });

  it("accumulates only transport faults; a real HTTP answer clears the streak", async () => {
    const handleSingleModel = async () => mkResult(false, true); // transport death
    const opts = {
      body: { messages: [{ role: "user", content: "ping" }] },
      models: ["dead/x"],
      handleSingleModel,
      log: { info() {}, warn() {}, error() {} },
      comboName: "acc",
      comboStrategy: "fallback",
    };
    await handleComboChat(opts);
    expect(isTransportCooling("acc", "dead/x")).toBe(false); // 1st fault: below threshold
    await handleComboChat(opts);
    expect(isTransportCooling("acc", "dead/x")).toBe(true);  // 2nd: trips

    // A seat that answered (even with an error status) is not transport-dead.
    resetAllBreakers();
    await handleComboChat({ ...opts, handleSingleModel: async () => mkResult(false, false) });
    await handleComboChat({ ...opts, handleSingleModel: async () => mkResult(false, false) });
    expect(isTransportCooling("acc", "dead/x")).toBe(false);
  });

  it("without a comboName the breaker stays out of the way entirely", async () => {
    const tried = [];
    await handleComboChat({
      body: { messages: [{ role: "user", content: "ping" }] },
      models: ["dead/x"],
      handleSingleModel: async (b, m) => { tried.push(m); return mkResult(false, true); },
      log: { info() {}, warn() {}, error() {} },
      comboName: null,
      comboStrategy: "fallback",
    });
    expect(tried).toEqual(["dead/x"]);
  });
});

describe("config-save invalidation", () => {
  it("resetComboRotation clears the breaker for that combo only", async () => {
    const { resetComboRotation } = await import("../../open-sse/services/combo.js");
    for (let i = 0; i < TRANSPORT_TRIP_THRESHOLD; i++) {
      recordTransportFailure("comboZ", "dead/x");
      recordTransportFailure("comboY", "dead/x");
    }
    expect(isTransportCooling("comboZ", "dead/x")).toBe(true);
    resetComboRotation("comboZ");
    expect(isTransportCooling("comboZ", "dead/x")).toBe(false);
    expect(isTransportCooling("comboY", "dead/x")).toBe(true);
  });

  it("a global settings reset clears everything", async () => {
    const { resetComboRotation } = await import("../../open-sse/services/combo.js");
    for (let i = 0; i < TRANSPORT_TRIP_THRESHOLD; i++) {
      recordTransportFailure("c1", "m");
      recordTransportFailure("c2", "m");
    }
    resetComboRotation();
    expect(isTransportCooling("c1", "m")).toBe(false);
    expect(isTransportCooling("c2", "m")).toBe(false);
  });
});
