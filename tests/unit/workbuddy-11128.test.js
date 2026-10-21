/**
 * WorkBuddy / CodeBuddy 11128 — request-side sanitizing.
 *
 * Community measurement (MOONKEY0510/workbuddy_api, MIT) splits 11128 into two
 * request-side causes plus a genuine channel-level WAF:
 *   1. messages[].role === "developer" is not in the upstream role whitelist;
 *   2. the bare substring "11128" ANYWHERE in the body blocks the whole request
 *      (neighbouring 11148 / 11101 / 11115 pass).
 * Both are cleaned on the outbound path of codebuddy-cn / codebuddy-intl
 * (open-sse/executors/codebuddy-outbound.js). The channel-scope breaker is kept
 * as the fallback for 11128s that survive sanitizing, so the error classifier
 * must not change.
 */
import { describe, it, expect } from "vitest";

import { CodeBuddyExecutor } from "../../open-sse/executors/codebuddy-cn.js";
import { CodeBuddyIntlExecutor } from "../../open-sse/executors/codebuddy-intl.js";
import {
  sanitizeCodeBuddyOutbound,
  CODEBUDDY_SAFE_11128,
} from "../../open-sse/executors/codebuddy-outbound.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";
import { ERROR_RULES } from "../../open-sse/config/errorConfig.js";

const cn = new CodeBuddyExecutor();
const intl = new CodeBuddyIntlExecutor();

describe("11128 request-side cause 1 — developer role", () => {
  it("normalizes messages[].role developer → system on codebuddy-cn", () => {
    const input = {
      model: "glm-5.2",
      messages: [
        { role: "developer", content: "Follow the repository rules." },
        { role: "user", content: "hello" },
      ],
    };

    const out = cn.transformRequest("glm-5.2", input, false, {});

    expect(out.messages[0].role).toBe("system");
    // ...and the caller's object is untouched (deep copy, not in-place edit).
    expect(input.messages[0].role).toBe("developer");
  });

  it("is case/whitespace tolerant, leaves every other role alone", () => {
    const out = sanitizeCodeBuddyOutbound({
      messages: [
        { role: " Developer ", content: "a" },
        { role: "system", content: "b" },
        { role: "user", content: "c" },
        { role: "tool", content: "d" },
        { role: "assistant", content: "e" },
      ],
    });

    expect(out.messages.map((m) => m.role)).toEqual([
      "system",
      "system",
      "user",
      "tool",
      "assistant",
    ]);
  });

  it("never lets a developer role reach the intl wire (it folds system-level turns)", () => {
    const out = intl.transformRequest(
      "glm-5.2",
      {
        messages: [
          { role: "developer", content: "Follow the repository rules." },
          { role: "user", content: "hello" },
        ],
      },
      false,
      {},
    );

    expect(out.messages.some((m) => m.role === "developer")).toBe(false);
  });
});

describe("11128 request-side cause 2 — bare 11128 substring", () => {
  it("rewrites 11128 in message content (string form)", () => {
    const input = {
      model: "glm-5.2",
      messages: [{ role: "user", content: "previous error was 11128, what now?" }],
    };

    const out = cn.transformRequest("glm-5.2", input, false, {});

    expect(out.messages[0].content).toBe(`previous error was ${CODEBUDDY_SAFE_11128}, what now?`);
    // caller untouched
    expect(input.messages[0].content).toBe("previous error was 11128, what now?");
  });

  it("recurses into typed content blocks, tool_calls arguments, tool schemas and metadata", () => {
    const out = sanitizeCodeBuddyOutbound({
      model: "glm-5.2",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "code=11128 in a block" }],
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "1", type: "function", function: { name: "f", arguments: '{"err":"11128"}' } },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "f",
            description: "returns 11128 on failure",
            parameters: { type: "object", properties: { note: { type: "string", default: "11128" } } },
          },
        },
      ],
      metadata: { nested: { lastError: "Code=11128" } },
      prompt_cache_key: "11128-cache",
    });

    expect(out.messages[0].content[0].text).toBe("code=11-128 in a block");
    expect(out.messages[1].tool_calls[0].function.arguments).toBe('{"err":"11-128"}');
    expect(out.tools[0].function.description).toBe("returns 11-128 on failure");
    expect(out.tools[0].function.parameters.properties.note.default).toBe("11-128");
    expect(out.metadata.nested.lastError).toBe("Code=11-128");
    expect(out.prompt_cache_key).toBe("11-128-cache");
  });

  it("rewrites every occurrence, including ones embedded in longer digit runs", () => {
    const out = sanitizeCodeBuddyOutbound({ messages: [{ role: "user", content: "11128 11128 x11128 111280" }] });
    expect(out.messages[0].content).toBe("11-128 11-128 x11-128 11-1280");
    expect(out.messages[0].content.includes("11128")).toBe(false);
  });

  it("does NOT touch neighbouring error codes (11148 / 11101 / 11115)", () => {
    const text = "11148 11101 11115 6004 10001";
    const out = sanitizeCodeBuddyOutbound({ messages: [{ role: "user", content: text }] });
    expect(out.messages[0].content).toBe(text);
  });

  it("does not touch look-alike text", () => {
    for (const text of ["1112 8", "1112-8", "1128", "1112", "111 28"]) {
      const out = sanitizeCodeBuddyOutbound({ messages: [{ role: "user", content: text }] });
      expect(out.messages[0].content, text).toBe(text);
    }
  });

  it("leaves numeric values alone (a number cannot be rewritten without changing its type)", () => {
    const out = sanitizeCodeBuddyOutbound({ max_tokens: 11128, messages: [] });
    expect(out.max_tokens).toBe(11128);
  });
});

describe("deep copy / fail-open contract", () => {
  it("returns a fresh tree; nested objects are not shared with the input", () => {
    const input = {
      model: "glm-5.2",
      messages: [{ role: "developer", content: "hello" }],
      tools: [{ type: "function", function: { name: "f" } }],
    };
    const out = sanitizeCodeBuddyOutbound(input);

    expect(out).not.toBe(input);
    expect(out.messages).not.toBe(input.messages);
    expect(out.messages[0]).not.toBe(input.messages[0]);
    expect(out.tools[0]).not.toBe(input.tools[0]);
    expect(input.messages[0].role).toBe("developer");
  });

  it("fail-open: an unclonable (cyclic) body is returned untouched instead of throwing", () => {
    const input = { messages: [{ role: "user", content: "11128" }] };
    input.self = input;

    const out = sanitizeCodeBuddyOutbound(input);
    expect(out).toBe(input);
  });

  it("passes non-object bodies through unchanged", () => {
    expect(sanitizeCodeBuddyOutbound(null)).toBeNull();
    expect(sanitizeCodeBuddyOutbound("11128")).toBe("11128");
  });
});

describe("channelScope stays as the fallback (rules untouched)", () => {
  it("still classifies the real 11128 payload as channel-level", () => {
    const real =
      '[400]: {"code":11128,"msg":"Illegal API invocation from an unapproved channel"}';
    const res = checkFallbackError(400, real);
    expect(res.channelScope).toBe(true);
    expect(res.cooldownMs).toBeGreaterThan(0);
  });

  it("does not channel-block other CodeBuddy codes", () => {
    for (const code of [11148, 11101, 11115, 6004, 11133]) {
      expect(checkFallbackError(400, `{"code":${code}}`).channelScope, String(code)).toBe(false);
    }
  });

  it("keeps both 11128 rules in the config", () => {
    const scoped = ERROR_RULES.filter((r) => r.channelScope === true).map((r) => r.text);
    expect(scoped).toEqual(["unapproved channel", "illegal api invocation"]);
  });
});
