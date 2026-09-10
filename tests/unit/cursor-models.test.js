import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearCursorModelCache,
  parseCursorUsableModels,
  resolveCursorModels,
} from "../../open-sse/services/cursorModels.js";

// cursorModels.js talks to Cursor over node:http2 — agent.api5.cursor.sh is
// HTTP/2-only and undici cannot speak h2 — so an earlier revision's
// `global.fetch = vi.fn()` never intercepted anything and both network tests below
// hit the live endpoint. "fetches the account-specific catalog" could therefore
// never pass (the live endpoint answers 415/403 without real credentials), and
// "fails open" only passed while that live call failed *faster than vitest's 5s
// test timeout*: any slower and vitest killed the test and reported
// `STACK_TRACE_ERROR` (its timeout sentinel), which the regression gate saw as a
// pass→fail regression unrelated to any code change.
// Mock the transport instead: deterministic, offline, and the cache / fail-open
// paths are still the ones under test.
const h2 = vi.hoisted(() => ({
  status: 200,
  body: new Uint8Array(),
  requests: [],
  sessions: 0,
  origin: null,
}));

vi.mock("http2", async () => {
  const { EventEmitter } = await import("node:events");

  class FakeRequest extends EventEmitter {
    constructor(headers) {
      super();
      this.headers = headers;
      this.sent = undefined;
    }

    end(body) {
      this.sent = body;
      queueMicrotask(() => {
        this.emit("response", { ":status": h2.status });
        if (h2.body?.length) this.emit("data", Buffer.from(h2.body));
        this.emit("end");
      });
    }
  }

  class FakeSession extends EventEmitter {
    request(headers) {
      const request = new FakeRequest(headers);
      h2.requests.push(request);
      return request;
    }

    close() {
      this.closed = true;
    }
  }

  return {
    default: {
      connect(origin) {
        h2.sessions += 1;
        h2.origin = origin;
        return new FakeSession();
      },
    },
  };
});

function varint(value) {
  const bytes = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return Uint8Array.from(bytes);
}

function field(fieldNumber, value) {
  return Uint8Array.from([(fieldNumber << 3) | 2, ...varint(value.length), ...value]);
}

function text(value) {
  return new TextEncoder().encode(value);
}

function concat(...parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function model(id, name) {
  return field(1, concat(field(1, text(id)), field(4, text(name))));
}

describe("Cursor live model catalog", () => {
  beforeEach(() => {
    clearCursorModelCache();
    h2.status = 200;
    h2.body = new Uint8Array();
    h2.requests = [];
    h2.sessions = 0;
    h2.origin = null;
  });

  afterEach(() => {
    clearCursorModelCache();
  });

  it("decodes the GetUsableModels protobuf response", () => {
    const payload = concat(
      model("default", "Auto"),
      model("gpt-5.3-codex", "GPT 5.3 Codex"),
      model("gpt-5.3-codex", "Duplicate"),
    );

    expect(parseCursorUsableModels(payload)).toEqual([
      { id: "default", name: "Auto" },
      { id: "gpt-5.3-codex", name: "GPT 5.3 Codex" },
    ]);
  });

  it("fetches the account-specific catalog and caches it", async () => {
    h2.status = 200;
    h2.body = concat(model("claude-4.6-opus", "Claude 4.6 Opus"));
    const credentials = {
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    };

    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });
    // Second call is served from the in-process catalog cache: no new h2 session.
    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });

    expect(h2.sessions).toBe(1);
    expect(h2.requests).toHaveLength(1);
    expect(h2.origin).toBe("https://agent.api5.cursor.sh");
    expect(h2.requests[0].headers).toEqual(expect.objectContaining({
      ":method": "POST",
      ":path": "/agent.v1.AgentService/GetUsableModels",
      ":scheme": "https",
      ":authority": "agent.api5.cursor.sh",
      "content-type": "application/proto",
      accept: "application/proto",
    }));
    // Unary call: no request body.
    expect(h2.requests[0].sent).toBeUndefined();
  });

  it("fails open when the Cursor catalog request fails", async () => {
    h2.status = 403;
    h2.body = new Uint8Array();

    await expect(resolveCursorModels({
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    })).resolves.toBeNull();
  });
});
