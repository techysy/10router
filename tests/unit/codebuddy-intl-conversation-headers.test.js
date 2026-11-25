// CodeBuddy intl conversation-header family (HTTP 400 code 11128
// "conversation id missing"): the gateway answers every chat request without
// ALL THREE of X-Conversation-ID / -Request-ID / -Message-ID with 11128
// (live A/B 2026-10-25 — any two still 11128). Pins the header derivation:
// uuid-shaped conversation id stable per conversation, message↔request id
// mirroring, idempotency across passes, and body session-field forwarding.
import { describe, it, expect } from "vitest";
import { CodeBuddyIntlExecutor } from "../../open-sse/executors/codebuddy-intl.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

const exec = new CodeBuddyIntlExecutor();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_V5_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function creds(extra = {}) {
  return { apiKey: "cb_test_key", connectionId: "conn-1", ...extra };
}

function body(extra = {}) {
  return { model: "glm-5.2", messages: [{ role: "user", content: "hello world" }], ...extra };
}

function buildHeaders(credentials, transformedBody) {
  return exec.buildHeaders(credentials, true, "https://www.codebuddy.ai/v2/chat/completions", "glm-5.2", transformedBody);
}

describe("codebuddy-intl conversation headers (11128 gate)", () => {
  it("sets the full family with a uuid-shaped stable conversation id", () => {
    const h = buildHeaders(creds(), body());
    expect(h["X-Conversation-ID"]).toMatch(UUID_V5_RE);
    expect(h["X-Conversation-Request-ID"]).toMatch(UUID_RE);
    expect(h["X-Conversation-Message-ID"]).toBe(h["X-Conversation-Request-ID"]);
    expect(h["X-Request-ID"]).toBe(h["X-Conversation-Message-ID"]);
    expect(h["X-Agent-Intent"]).toBe("craft");
    expect(h["X-Agent-Type"]).toBe("main");
  });

  it("keeps one conversation id per body session_id across connections", () => {
    const a = buildHeaders(creds({ connectionId: "conn-1" }), body({ session_id: "sess-1" }));
    const b = buildHeaders(creds({ connectionId: "conn-2" }), body({ session_id: "sess-1" }));
    const c = buildHeaders(creds({ connectionId: "conn-1" }), body({ session_id: "sess-2" }));
    expect(a["X-Conversation-ID"]).toBe(b["X-Conversation-ID"]);
    expect(a["X-Conversation-ID"]).not.toBe(c["X-Conversation-ID"]);
  });

  it("prompt_cache_key and conversation_id also key the conversation", () => {
    const viaCache = buildHeaders(creds(), body({ prompt_cache_key: "pc-1" }));
    const viaConv = buildHeaders(creds(), body({ conversation_id: "pc-1" }));
    expect(viaCache["X-Conversation-ID"]).toBe(viaConv["X-Conversation-ID"]);
  });

  it("stays stable across turns of one connection without session fields", () => {
    const turn1 = buildHeaders(creds(), body({ messages: [{ role: "user", content: "first question" }] }));
    const turn2 = buildHeaders(creds(), body({ messages: [{ role: "user", content: "follow-up" }] }));
    expect(turn2["X-Conversation-ID"]).toBe(turn1["X-Conversation-ID"]);
  });

  it("message id is fresh per build but mirrored into X-Request-ID", () => {
    const h1 = buildHeaders(creds(), body());
    const h2 = buildHeaders(creds(), body());
    expect(h2["X-Conversation-Message-ID"]).not.toBe(h1["X-Conversation-Message-ID"]);
    expect(h2["X-Request-ID"]).toBe(h2["X-Conversation-Message-ID"]);
  });

  it("transformRequest forwards session_id / prompt_cache_key / conversation_id", () => {
    const out = exec.transformRequest("glm-5.2", body({ session_id: "s-1", prompt_cache_key: "p-1", conversation_id: "c-1" }), true, creds());
    expect(out.session_id).toBe("s-1");
    expect(out.prompt_cache_key).toBe("p-1");
    expect(out.conversation_id).toBe("c-1");
    expect(out.stream).toBe(true);
  });

  it("transformRequest does not invent empty session fields", () => {
    const out = exec.transformRequest("glm-5.2", body(), true, creds());
    expect(out.session_id).toBeUndefined();
    expect(out.prompt_cache_key).toBeUndefined();
    expect(out.conversation_id).toBeUndefined();
  });
});

describe("11128 intl gate is channel-scoped in ERROR_RULES", () => {
  it("conversation-id-missing on codebuddy-intl scopes to the channel", () => {
    const r = checkFallbackError(400, '[400]: {"code":11128,"message":"conversation id missing"}', 0, "codebuddy-intl");
    expect(r.channelScope).toBe(true);
    expect(r.shouldFallback).toBe(true);
  });

  it("request illegal scopes to the channel too", () => {
    const r = checkFallbackError(400, "11128 request illegal", 0, "codebuddy-intl");
    expect(r.channelScope).toBe(true);
  });

  it("the same text on another provider does not trigger the intl rule", () => {
    const r = checkFallbackError(400, "conversation id missing", 0, "oxion");
    expect(r.channelScope).toBeFalsy();
  });
});
