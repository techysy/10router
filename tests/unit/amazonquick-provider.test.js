/**
 * Amazon Quick provider: registry wiring, the cookie-session credential
 * shape, the AWS EventStream decoder, tier → performanceMode mapping,
 * and the executor's conversation-id session bridging (first turn sends
 * a transcript, later turns ride the server-side conversation).
 *
 * Wire protocol live-verified 2026-11-21 by replaying the web client's
 * own requests outside the browser. No network in these tests —
 * proxyAwareFetch is stubbed per test (same pattern as
 * qwenwork-provider.test.js).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { proxyAwareFetchMock } = vi.hoisted(() => ({ proxyAwareFetchMock: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: proxyAwareFetchMock }));

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { getCapabilitiesForModel, PROVIDER_CAPABILITIES } from "../../open-sse/providers/capabilities.js";
import {
  amazonQuickChatUrl,
  amazonQuickListConversationsUrl,
  buildAmazonQuickHeaders,
  looksLikeAmazonQuickCurl,
  parseAmazonQuickCurl,
  resolveAmazonQuickCredentials,
} from "../../open-sse/shared/amazonquick/constants.js";
import {
  AMAZONQUICK_TIERS,
  amazonQuickPerformanceModeFor,
  resolveAmazonQuickModels,
} from "../../open-sse/services/amazonquickModels.js";
import { AmazonQuickExecutor, __test__ } from "../../open-sse/executors/amazonquick.js";

const { crc32, parseEventFrame, EventStreamDecoder, eventFromFrame } = __test__;

// ─── EventStream frame encoder (test-side mirror of the wire format) ────────

function encodeFrame(headersObj, payloadObj) {
  const payload = new TextEncoder().encode(
    typeof payloadObj === "string" ? payloadObj : JSON.stringify(payloadObj),
  );
  const headerParts = [];
  for (const [name, value] of Object.entries(headersObj)) {
    const nameBytes = new TextEncoder().encode(name);
    const valueBytes = new TextEncoder().encode(value);
    const part = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
    let o = 0;
    part[o++] = nameBytes.length;
    part.set(nameBytes, o);
    o += nameBytes.length;
    part[o++] = 7; // string type
    part[o++] = (valueBytes.length >> 8) & 0xff;
    part[o++] = valueBytes.length & 0xff;
    part.set(valueBytes, o);
    headerParts.push(part);
  }
  const headersLength = headerParts.reduce((n, p) => n + p.length, 0);
  const totalLength = 12 + headersLength + payload.length + 4;
  const frame = new Uint8Array(totalLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, totalLength);
  view.setUint32(4, headersLength);
  view.setUint32(8, crc32(frame.subarray(0, 8)));
  let o = 12;
  for (const p of headerParts) {
    frame.set(p, o);
    o += p.length;
  }
  frame.set(payload, o);
  view.setUint32(totalLength - 4, crc32(frame.subarray(0, totalLength - 4)));
  return frame;
}

const eventFrame = (eventType, payload) =>
  encodeFrame({ ":event-type": eventType, ":message-type": "event", ":content-type": "application/json" }, payload);

function eventStreamResponse(frames, { headers = {}, splitAt = -1 } = {}) {
  const stream = new ReadableStream({
    start(controller) {
      if (splitAt > 0) {
        // Deliver the byte stream in awkward slices to prove the
        // decoder buffers partial frames.
        const all = frames.reduce((acc, f) => {
          const merged = new Uint8Array(acc.length + f.length);
          merged.set(acc);
          merged.set(f, acc.length);
          return merged;
        }, new Uint8Array(0));
        for (let i = 0; i < all.length; i += splitAt) {
          controller.enqueue(all.slice(i, i + splitAt));
        }
      } else {
        for (const f of frames) controller.enqueue(f);
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "application/x-amz-eventstream", ...headers },
  });
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const FAKE_COOKIE = "JSESSIONID=fake-session; aws-ds-access-token=fake-token";
const KEY_FIELD = "api" + "Key";

function makeCredentials(psdOverrides = {}) {
  return {
    provider: "amazonquick",
    [KEY_FIELD]: FAKE_COOKIE,
    providerSpecificData: { awsAccountId: "123456789012", csrf: "csrf-token-1", ...psdOverrides },
  };
}

beforeEach(() => {
  proxyAwareFetchMock.mockReset();
  __test__.clearSessions();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Registry ────────────────────────────────────────────────────────────────

describe("Amazon Quick provider registry", () => {
  const entry = REGISTRY.find((e) => e.id === "amazonquick");

  it("registers as a cookie-credential apikey-style provider (no OAuth)", () => {
    expect(entry).toBeDefined();
    expect(entry.alias).toBe("aq");
    expect(entry.category).toBe("apikey");
    expect(entry.authModes).toEqual(["apikey"]);
    expect(entry.authType).toBe("cookie");
    expect(entry.hasOAuth).toBeUndefined();
    expect(entry.hasProviderSpecificData).toBe(true);
    expect(entry.transport.baseUrl).toBe("https://quick.aws.com");
    expect(PROVIDERS.amazonquick).toBeDefined();
  });

  it("publishes exactly the three performance tiers as static models", () => {
    expect(entry.models.map((m) => m.id)).toEqual(["fast", "smart", "advanced"]);
    expect(PROVIDER_MODELS.aq.map((m) => m.id)).toEqual(["fast", "smart", "advanced"]);
    expect(resolveAmazonQuickModels().map((m) => m.id)).toEqual(["fast", "smart", "advanced"]);
    expect(AMAZONQUICK_TIERS.map((t) => t.performanceMode)).toEqual(["FAST", "SMART", "ADVANCED"]);
  });

  it("resolves capabilities from the provider rows (not the default floor)", () => {
    for (const tier of ["fast", "smart", "advanced"]) {
      const caps = getCapabilitiesForModel("amazonquick", tier);
      expect(caps.vision).toBe(true);
      expect(caps.search).toBe(true);
      expect(caps.contextWindow).toBe(200000);
    }
    expect(PROVIDER_CAPABILITIES.aq).toBe(PROVIDER_CAPABILITIES.amazonquick);
  });
});

// ─── Credentials + URLs + headers ────────────────────────────────────────────

describe("Amazon Quick credential resolution", () => {
  it("reads cookie from the credential field and account/csrf from PSD", () => {
    const creds = resolveAmazonQuickCredentials(makeCredentials());
    expect(creds).toEqual({
      cookie: FAKE_COOKIE,
      awsAccountId: "123456789012",
      csrf: "csrf-token-1",
      missing: [],
    });
  });

  it("prefers an explicit PSD cookie over the credential field", () => {
    const creds = resolveAmazonQuickCredentials(makeCredentials({ cookie: "JSESSIONID=psd-wins" }));
    expect(creds.cookie).toBe("JSESSIONID=psd-wins");
  });

  it("names every missing field", () => {
    const creds = resolveAmazonQuickCredentials({ providerSpecificData: {} });
    expect(creds.missing).toEqual(["cookie", "awsAccountId", "csrf"]);
  });

  it("rejects a non-numeric legacy awsAccountId instead of putting it in the URL", () => {
    const creds = resolveAmazonQuickCredentials({
      [KEY_FIELD]: FAKE_COOKIE,
      providerSpecificData: { awsAccountId: "sn/account/oops", csrf: "csrf-token-1" },
    });
    expect(creds.awsAccountId).toBe("");
    expect(creds.missing).toContain("awsAccountId");
  });

  it("builds the qbsproxy chat + list URLs with the csrf as mbtc", () => {
    expect(amazonQuickChatUrl("123456789012", "csrf token")).toBe(
      "https://quick.aws.com/sn/account/123456789012/qbsproxy/quicksight/accounts/123456789012/conversations/chat?mbtc=csrf%20token",
    );
    expect(amazonQuickListConversationsUrl("123456789012", "csrf-token-1")).toBe(
      "https://quick.aws.com/sn/account/123456789012/qbsproxy/quicksight/accounts/123456789012/conversations?mbtc=csrf-token-1",
    );
  });

  it("does not mistake a plain cookie value containing 'curl' for a curl paste", () => {
    const creds = resolveAmazonQuickCredentials({
      [KEY_FIELD]: "session=curling-value",
      providerSpecificData: { awsAccountId: "123456789012", csrf: "csrf-token-1" },
    });
    expect(creds.cookie).toBe("session=curling-value");
    expect(creds.missing).toEqual([]);
    expect(looksLikeAmazonQuickCurl("session=curling-value")).toBe(false);
  });

  it("sends cookie + csrf headers and NO Authorization header", () => {
    const headers = buildAmazonQuickHeaders({ cookie: FAKE_COOKIE, csrf: "csrf-token-1" });
    expect(headers.Cookie).toBe(FAKE_COOKIE);
    expect(headers["x-amzn-csrf-token"]).toBe("csrf-token-1");
    expect(headers["x-amzn-target"]).toBe("api");
    expect(headers.Authorization).toBeUndefined();
  });
});

// ─── Copy-as-cURL paste (single-box credential form) ─────────────────────────

// Chrome "Copy as cURL (bash)": cookies ride -b, the csrf rides both
// the mbtc= query param (URL-encoded) and the x-amzn-csrf-token header.
const FAKE_CURL_B_FLAG = [
  "curl 'https://quick.aws.com/sn/account/123456789012/qbsproxy/quicksight/accounts/123456789012/conversations?mbtc=abc%2Fdef%3D' \\",
  "  -H 'accept: application/json, text/plain, */*' \\",
  "  -H 'x-amzn-target: api' \\",
  "  -H 'x-amzn-csrf-token: header-value-loses' \\",
  `  -b '${FAKE_COOKIE}'`,
].join("\n");

// Firefox-style "Copy as cURL": double quotes, cookie + csrf as headers,
// no mbtc in the URL.
const FAKE_CURL_HEADER_FORM = [
  'curl "https://quick.aws.com/sn/account/123456789012/qbsproxy/quicksight/accounts/123456789012/conversations/chat" \\',
  '  -H "User-Agent: Mozilla/5.0" \\',
  `  -H "Cookie: ${FAKE_COOKIE}" \\`,
  '  -H "x-amzn-csrf-token: csrf-token-1" \\',
  '  --data-raw "{\\"userMessage\\":\\"hi\\"}"',
].join("\n");

describe("Amazon Quick Copy-as-cURL credential paste", () => {
  it("extracts cookie from -b, account from the URL, csrf from decoded mbtc", () => {
    expect(looksLikeAmazonQuickCurl(FAKE_CURL_B_FLAG)).toBe(true);
    expect(parseAmazonQuickCurl(FAKE_CURL_B_FLAG)).toEqual({
      cookie: FAKE_COOKIE,
      awsAccountId: "123456789012",
      csrf: "abc/def=",
    });
    const creds = resolveAmazonQuickCredentials({ [KEY_FIELD]: FAKE_CURL_B_FLAG, providerSpecificData: {} });
    expect(creds).toEqual({
      cookie: FAKE_COOKIE,
      awsAccountId: "123456789012",
      csrf: "abc/def=",
      missing: [],
    });
  });

  it("extracts cookie and csrf from -H headers when there is no -b / mbtc", () => {
    expect(parseAmazonQuickCurl(FAKE_CURL_HEADER_FORM)).toEqual({
      cookie: FAKE_COOKIE,
      awsAccountId: "123456789012",
      csrf: "csrf-token-1",
    });
    const creds = resolveAmazonQuickCredentials({ [KEY_FIELD]: FAKE_CURL_HEADER_FORM, providerSpecificData: {} });
    expect(creds.missing).toEqual([]);
    expect(creds.cookie).toBe(FAKE_COOKIE);
    expect(creds.csrf).toBe("csrf-token-1");
  });

  it("names the missing field when the pasted curl has no csrf anywhere", () => {
    const noCsrf = [
      "curl 'https://quick.aws.com/sn/account/123456789012/qbsproxy/quicksight/accounts/123456789012/conversations' \\",
      `  -b '${FAKE_COOKIE}'`,
    ].join("\n");
    const creds = resolveAmazonQuickCredentials({ [KEY_FIELD]: noCsrf, providerSpecificData: {} });
    expect(creds.cookie).toBe(FAKE_COOKIE);
    expect(creds.awsAccountId).toBe("123456789012");
    expect(creds.missing).toEqual(["csrf"]);
  });

  it("a fresh curl paste wins over stale providerSpecificData values", () => {
    const freshCurl = [
      "curl 'https://quick.aws.com/sn/account/999888777666/qbsproxy/quicksight/accounts/999888777666/conversations?mbtc=fresh%2Fcsrf' \\",
      "  -b 'JSESSIONID=fresh-session'",
    ].join("\n");
    const creds = resolveAmazonQuickCredentials({
      [KEY_FIELD]: freshCurl,
      providerSpecificData: { awsAccountId: "123456789012", csrf: "csrf-token-1" },
    });
    expect(creds).toEqual({
      cookie: "JSESSIONID=fresh-session",
      awsAccountId: "999888777666",
      csrf: "fresh/csrf",
      missing: [],
    });
  });
});

// ─── Tier mapping ────────────────────────────────────────────────────────────

describe("Amazon Quick tier → performanceMode", () => {
  it("maps bare and prefixed model ids, defaulting unknown to SMART", () => {
    expect(amazonQuickPerformanceModeFor("fast")).toBe("FAST");
    expect(amazonQuickPerformanceModeFor("amazonquick/smart")).toBe("SMART");
    expect(amazonQuickPerformanceModeFor("aq/advanced")).toBe("ADVANCED");
    expect(amazonQuickPerformanceModeFor("something-else")).toBe("SMART");
    expect(amazonQuickPerformanceModeFor("")).toBe("SMART");
  });
});

// ─── EventStream decoder ─────────────────────────────────────────────────────

describe("Amazon Quick EventStream decoder", () => {
  it("parses a complete frame's headers and JSON payload", () => {
    const frame = eventFrame("textMessageEvent", { textMessage: "2", conversationId: "conv-1" });
    const parsed = parseEventFrame(frame);
    expect(parsed.headers[":event-type"]).toBe("textMessageEvent");
    expect(parsed.payload).toEqual({ textMessage: "2", conversationId: "conv-1" });
  });

  it("reassembles frames split across pushes and splits batched frames", () => {
    const a = eventFrame("textMessageEvent", { textMessage: "he" });
    const b = eventFrame("textMessageEvent", { textMessage: "llo" });
    const all = new Uint8Array(a.length + b.length);
    all.set(a);
    all.set(b, a.length);
    const decoder = new EventStreamDecoder();
    const out = [];
    for (let i = 0; i < all.length; i += 7) {
      out.push(...decoder.push(all.slice(i, i + 7)));
    }
    expect(out.map((f) => f.payload.textMessage)).toEqual(["he", "llo"]);
  });

  it("rejects a frame whose CRC was tampered with", () => {
    const frame = eventFrame("textMessageEvent", { textMessage: "x" });
    frame[frame.length - 6] ^= 0xff;
    expect(() => parseEventFrame(frame)).toThrow(/CRC mismatch/);
  });

  it("classifies exception frames and wrapped payloads", () => {
    const ex = encodeFrame(
      { ":message-type": "exception", ":exception-type": "InternalFailure" },
      { message: "boom" },
    );
    expect(eventFromFrame(parseEventFrame(ex))).toEqual({
      kind: "exception",
      eventType: "InternalFailure",
      payload: { message: "boom" },
    });
    const wrapped = { headers: {}, payload: { textMessageEvent: { textMessage: "hi" } } };
    expect(eventFromFrame(wrapped)).toEqual({
      kind: "event",
      eventType: "textMessageEvent",
      payload: { textMessage: "hi" },
    });
  });
});

// ─── Executor ────────────────────────────────────────────────────────────────

describe("AmazonQuickExecutor", () => {
  const executor = new AmazonQuickExecutor();

  it("answers 401 naming the missing fields when credentials are incomplete", async () => {
    const { response } = await executor.execute({
      model: "smart",
      body: { messages: [{ role: "user", content: "hi" }] },
      credentials: { providerSpecificData: {} },
    });
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.message).toContain("awsAccountId");
    expect(body.error.message).toContain("csrf");
    expect(proxyAwareFetchMock).not.toHaveBeenCalled();
  });

  it("first turn: posts the proven chat shape and streams deltas as OpenAI SSE", async () => {
    proxyAwareFetchMock.mockResolvedValue(eventStreamResponse(
      [
        eventFrame("textMessageEvent", { textMessage: "2", conversationId: "conv-1", systemMessageId: "s1", userMessageId: "u1", messageId: "m1" }),
        eventFrame("metadataEvent", { finalTextMessage: "2" }),
      ],
      { headers: { "x-amzn-conversation-id": "conv-1" }, splitAt: 5 },
    ));

    const { response, url } = await executor.execute({
      model: "smart",
      body: { messages: [{ role: "user", content: "1+1等于几" }] },
      credentials: makeCredentials(),
    });

    expect(url).toContain("/sn/account/123456789012/qbsproxy/quicksight/accounts/123456789012/conversations/chat?mbtc=csrf-token-1");
    const [fetchUrl, fetchOpts] = proxyAwareFetchMock.mock.calls[0];
    expect(fetchUrl).toBe(url);
    expect(fetchOpts.headers.Cookie).toBe(FAKE_COOKIE);
    expect(fetchOpts.headers["x-amzn-csrf-token"]).toBe("csrf-token-1");
    expect(fetchOpts.headers.Authorization).toBeUndefined();
    const sent = JSON.parse(fetchOpts.body);
    expect(sent.userMessage).toBe("1+1等于几");
    expect(sent.awsAccountId).toBe("123456789012");
    expect(sent.surfaceType).toBe("WEB_EXPERIENCE");
    expect(sent.temporaryChat).toBe(false);
    expect(sent.performanceMode).toBe("SMART");
    expect(sent.additionalChatContext).toEqual({ chatOptions: { disableWebSearch: false } });
    expect(sent.conversationId).toBeUndefined();
    expect(typeof sent.userMetadata.localTimezone).toBe("string");

    const sse = await response.text();
    expect(sse).toContain('"content":"2"');
    expect(sse).toContain('"finish_reason":"stop"');
    expect(sse).toContain("data: [DONE]");
  });

  it("second turn: rides the stored conversationId and sends only the new message", async () => {
    proxyAwareFetchMock.mockResolvedValue(eventStreamResponse(
      [
        eventFrame("textMessageEvent", { textMessage: "2", conversationId: "conv-1" }),
        eventFrame("metadataEvent", { finalTextMessage: "2" }),
      ],
      { headers: { "x-amzn-conversation-id": "conv-1" } },
    ));
    const credentials = makeCredentials();
    const first = await executor.execute({
      model: "smart",
      body: { messages: [{ role: "user", content: "1+1等于几" }] },
      credentials,
    });
    await first.response.text(); // drain → session store runs

    proxyAwareFetchMock.mockReset();
    proxyAwareFetchMock.mockResolvedValue(eventStreamResponse(
      [eventFrame("textMessageEvent", { textMessage: "5", conversationId: "conv-1" })],
      { headers: { "x-amzn-conversation-id": "conv-1" } },
    ));
    const second = await executor.execute({
      model: "advanced",
      body: {
        messages: [
          { role: "user", content: "1+1等于几" },
          { role: "assistant", content: "2" },
          { role: "user", content: "再加3呢" },
        ],
      },
      credentials,
    });
    const sent = JSON.parse(proxyAwareFetchMock.mock.calls[0][1].body);
    expect(sent.conversationId).toBe("conv-1");
    expect(sent.userMessage).toBe("再加3呢");
    expect(sent.performanceMode).toBe("ADVANCED");
    const sse = await second.response.text();
    expect(sse).toContain('"content":"5"');
  });

  it("session miss with history: flattens a transcript into the first userMessage", async () => {
    proxyAwareFetchMock.mockResolvedValue(eventStreamResponse(
      [eventFrame("textMessageEvent", { textMessage: "ok", conversationId: "conv-9" })],
    ));
    await executor.execute({
      model: "fast",
      body: {
        messages: [
          { role: "system", content: "Be terse." },
          { role: "user", content: "q1" },
          { role: "assistant", content: "a1" },
          { role: "user", content: "q2" },
        ],
      },
      credentials: makeCredentials(),
    });
    const sent = JSON.parse(proxyAwareFetchMock.mock.calls[0][1].body);
    expect(sent.conversationId).toBeUndefined();
    expect(sent.userMessage).toContain("[System]\nBe terse.");
    expect(sent.userMessage).toContain("User: q1");
    expect(sent.userMessage).toContain("Assistant: a1");
    expect(sent.userMessage).toContain("User: q2");
    expect(sent.performanceMode).toBe("FAST");
  });

  it("flushes the metadata finalText tail the deltas missed", async () => {
    proxyAwareFetchMock.mockResolvedValue(eventStreamResponse(
      [
        eventFrame("textMessageEvent", { textMessage: "Hel", conversationId: "conv-2" }),
        eventFrame("metadataEvent", { finalTextMessage: "Hello" }),
      ],
    ));
    const { response } = await executor.execute({
      model: "smart",
      body: { messages: [{ role: "user", content: "say hello" }] },
      credentials: makeCredentials(),
    });
    const sse = await response.text();
    expect(sse).toContain('"content":"Hel"');
    expect(sse).toContain('"content":"lo"');
  });

  it("turns an immediate exception frame into an HTTP error, not fake text", async () => {
    proxyAwareFetchMock.mockResolvedValue(eventStreamResponse(
      [encodeFrame({ ":message-type": "exception", ":exception-type": "ThrottlingException" }, { message: "slow down" })],
    ));
    const { response } = await executor.execute({
      model: "smart",
      body: { messages: [{ role: "user", content: "hi" }] },
      credentials: makeCredentials(),
    });
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error.message).toContain("slow down");
  });

  it("maps an upstream 403 to the session-expired hint", async () => {
    proxyAwareFetchMock.mockResolvedValue(new Response("forbidden", { status: 403 }));
    const { response } = await executor.execute({
      model: "smart",
      body: { messages: [{ role: "user", content: "hi" }] },
      credentials: makeCredentials(),
    });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.message).toContain("session cookie is expired or invalid");
  });
});
