/**
 * WorkBuddy / CodeBuddy request-id reuse.
 *
 * The upstream WAF treats a burst of distinct request ids on one logical
 * request (retry inside the executor, or account fallback across the pool) as
 * suspicious — every attempt looked like a brand-new request. The id must stay
 * the same for the whole logical request:
 *   1. prefer a request-id header the downstream client supplied;
 *   2. otherwise derive it from a stable hash of the outbound body
 *      (messages + model included, so different requests still differ).
 * X-Conversation-ID keeps its existing session-derived logic.
 */
import { describe, it, expect } from "vitest";

import { CodeBuddyExecutor } from "../../open-sse/executors/codebuddy-cn.js";
import { CodeBuddyIntlExecutor } from "../../open-sse/executors/codebuddy-intl.js";
import { buildCodeBuddyConversationHeaders } from "../../open-sse/executors/codebuddy-outbound.js";

const cn = new CodeBuddyExecutor();
const intl = new CodeBuddyIntlExecutor();

const HEX32 = /^[a-f0-9]{32}$/;

function headersFor(exec, credentials, body) {
  return exec.buildHeaders(credentials, true, "https://example.invalid/v2/chat/completions", "glm-5.2", body);
}

function creds(connectionId = "conn-a", rawHeaders = {}) {
  return { accessToken: "token", connectionId, rawHeaders };
}

const BODY_A = {
  model: "glm-5.2",
  messages: [
    { role: "system", content: "be terse" },
    { role: "user", content: "hello" },
  ],
};

describe("stable request id across retries / account switches", () => {
  it("same body → same X-Conversation-Request-ID and X-Request-ID (codebuddy-cn)", () => {
    const first = headersFor(cn, creds(), BODY_A);
    const second = headersFor(cn, creds(), BODY_A);

    expect(first["X-Conversation-Request-ID"]).toBe(second["X-Conversation-Request-ID"]);
    expect(first["X-Request-ID"]).toBe(second["X-Request-ID"]);
    expect(first["X-Conversation-Message-ID"]).toBe(first["X-Conversation-Request-ID"]);
    expect(first["X-Conversation-Request-ID"]).toMatch(HEX32);
  });

  it("equal bodies built as separate objects still share the id (account fallback re-translates)", () => {
    const clone = JSON.parse(JSON.stringify(BODY_A));
    expect(headersFor(cn, creds(), BODY_A)["X-Request-ID"]).toBe(
      headersFor(cn, creds(), clone)["X-Request-ID"],
    );
  });

  it("different messages → different id", () => {
    const other = { ...BODY_A, messages: [...BODY_A.messages, { role: "user", content: "again" }] };
    expect(headersFor(cn, creds(), BODY_A)["X-Request-ID"]).not.toBe(
      headersFor(cn, creds(), other)["X-Request-ID"],
    );
  });

  it("different model → different id", () => {
    const other = { ...BODY_A, model: "deepseek-v4-pro" };
    expect(headersFor(cn, creds(), BODY_A)["X-Request-ID"]).not.toBe(
      headersFor(cn, creds(), other)["X-Request-ID"],
    );
  });

  it("retry path: transformRequest + buildHeaders twice yields the same id", () => {
    const source = JSON.parse(JSON.stringify(BODY_A));
    const firstBody = cn.transformRequest("glm-5.2", source, false, {});
    const first = headersFor(cn, creds(), firstBody);

    const secondBody = cn.transformRequest("glm-5.2", JSON.parse(JSON.stringify(BODY_A)), false, {});
    const second = headersFor(cn, creds(), secondBody);

    expect(second["X-Conversation-Request-ID"]).toBe(first["X-Conversation-Request-ID"]);
  });

  it("holds on codebuddy-intl too", () => {
    const first = headersFor(intl, creds("conn-intl"), BODY_A);
    const second = headersFor(intl, creds("conn-intl"), BODY_A);
    expect(first["X-Request-ID"]).toBe(second["X-Request-ID"]);

    const other = { ...BODY_A, messages: [{ role: "user", content: "different" }] };
    expect(headersFor(intl, creds("conn-intl"), other)["X-Request-ID"]).not.toBe(first["X-Request-ID"]);
  });
});

describe("downstream request-id header takes priority", () => {
  it("passes through a downstream 32-hex id byte-for-byte", () => {
    const supplied = "0123456789abcdef0123456789abcdef";
    const h = headersFor(cn, creds("conn-a", { "x-conversation-request-id": supplied }), BODY_A);
    expect(h["X-Conversation-Request-ID"]).toBe(supplied);
    expect(h["X-Request-ID"]).toBe(supplied);
  });

  it("uses the client id even when the body changes (the client owns the logical request)", () => {
    const raw = { "x-conversation-request-id": "client-req-1" };
    const a = headersFor(cn, creds("conn-a", raw), BODY_A);
    const b = headersFor(cn, creds("conn-b", raw), { ...BODY_A, model: "deepseek-v4-pro" });
    expect(a["X-Request-ID"]).toBe(b["X-Request-ID"]);
    expect(a["X-Request-ID"]).toMatch(HEX32); // non-hex input is hashed into the expected shape
  });

  it("falls back to x-request-id / x-client-request-id (case-insensitive map)", () => {
    const viaRequestId = headersFor(cn, creds("conn-a", { "X-Request-ID": "req-abc" }), BODY_A);
    const viaClientId = headersFor(cn, creds("conn-a", { "X-Client-Request-Id": "req-abc" }), BODY_A);
    expect(viaRequestId["X-Request-ID"]).toBe(viaClientId["X-Request-ID"]);
  });

  it("ignores empty header values", () => {
    const h = headersFor(cn, creds("conn-a", { "x-request-id": "   " }), BODY_A);
    expect(h["X-Request-ID"]).toMatch(HEX32);
    expect(h["X-Request-ID"]).toBe(headersFor(cn, creds("conn-a"), BODY_A)["X-Request-ID"]);
  });
});

describe("X-Conversation-ID keeps the session-derived logic", () => {
  it("is 32-hex and independent of the body for one connection", () => {
    const a = headersFor(cn, creds("session-conn-1"), BODY_A);
    const b = headersFor(cn, creds("session-conn-1"), { ...BODY_A, model: "other-model" });
    expect(a["X-Conversation-ID"]).toMatch(HEX32);
    expect(b["X-Conversation-ID"]).toBe(a["X-Conversation-ID"]);
  });

  it("differs across connections", () => {
    const a = headersFor(cn, creds("session-conn-2"), BODY_A);
    const b = headersFor(cn, creds("session-conn-3"), BODY_A);
    expect(a["X-Conversation-ID"]).not.toBe(b["X-Conversation-ID"]);
  });

  it("still emits the full header family", () => {
    const h = buildCodeBuddyConversationHeaders(creds("session-conn-4"), BODY_A, "codebuddy-cn");
    expect(h["X-Agent-Intent"]).toBe("craft");
    expect(h["X-Agent-Type"]).toBe("main");
    expect(h["X-Conversation-ID"]).toMatch(HEX32);
    expect(h["X-Conversation-Request-ID"]).toMatch(HEX32);
    expect(h["X-Conversation-Message-ID"]).toMatch(HEX32);
    expect(h["X-Request-ID"]).toMatch(HEX32);
  });
});
