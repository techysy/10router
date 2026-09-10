/**
 * Regression for #3905 — Claude tool `type` defaulting must stay provider-scoped.
 *
 * Anthropic's tool schema lets `type` be omitted, and that legacy typeless shape is
 * what our own openai→claude translator emits. Two kinds of Anthropic-compatible
 * gateway disagree about it:
 *
 *   - MiniMax's Claude surface rejects the typeless shape (error 2013), so it needs
 *     `type: "custom"` stamped on every tool.
 *   - DeepSeek's Claude surface (`/anthropic/v1/messages`) whitelists tool `type` to
 *     its own web_search_* variants and answers HTTP 400 `unknown variant \`custom\``,
 *     so stamping it there breaks every Claude Code request routed to DeepSeek and
 *     surfaces to the client as a persistent 503.
 *
 * A blanket "default it everywhere" fix satisfies one and breaks the other. The
 * defaulting is therefore gated on the `requireClaudeToolType` provider quirk, and
 * `shouldDefaultClaudeToolType()` is the single decision point — tested directly
 * rather than through the handler, which needs a live executor.
 *
 * The last block is a wiring tripwire: chatCore.js is glue that cannot be driven from
 * this environment (it needs credentials, an executor and the DB), so the regression
 * it guards — someone re-introducing the unconditional stamp — is asserted against
 * the source text, as elsewhere in this suite for un-renderable glue.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDERS } from "../../open-sse/providers/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { defaultClaudeToolType, shouldDefaultClaudeToolType } from "../../open-sse/translator/concerns/toolCall.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TYPELESS_TOOL = [
  { name: "get_weather", description: "weather", input_schema: { type: "object" } },
];

/** Providers that can serve a Claude-format request, directly or via a transport. */
const CLAUDE_CAPABLE = Object.entries(PROVIDERS)
  .filter(([, p]) => p.format === FORMATS.CLAUDE
    || (Array.isArray(p.transports) && p.transports.some(t => t.format === FORMATS.CLAUDE)))
  .map(([id]) => id)
  .sort();

describe("Claude tool `type` defaulting is provider-scoped (#3905)", () => {
  it("gates on the requireClaudeToolType quirk, not on the request format alone", () => {
    expect(shouldDefaultClaudeToolType("minimax", FORMATS.CLAUDE, TYPELESS_TOOL, PROVIDERS)).toBe(true);
    expect(shouldDefaultClaudeToolType("minimax-cn", FORMATS.CLAUDE, TYPELESS_TOOL, PROVIDERS)).toBe(true);
  });

  it("leaves typeless endpoints typeless", () => {
    // DeepSeek is the endpoint this regression is named after: it is Claude-capable
    // (see the transport assertion below) and must never receive `type: "custom"`.
    expect(shouldDefaultClaudeToolType("deepseek", FORMATS.CLAUDE, TYPELESS_TOOL, PROVIDERS)).toBe(false);
    for (const provider of ["anthropic", "claude", "glm", "kimi", "opencode-go", "xiaomi-mimo", "xiaomi-tokenplan"]) {
      expect(shouldDefaultClaudeToolType(provider, FORMATS.CLAUDE, TYPELESS_TOOL, PROVIDERS)).toBe(false);
    }
  });

  it("never fires outside Claude-format requests or without tools", () => {
    expect(shouldDefaultClaudeToolType("minimax", FORMATS.OPENAI, TYPELESS_TOOL, PROVIDERS)).toBe(false);
    expect(shouldDefaultClaudeToolType("minimax", FORMATS.CLAUDE, undefined, PROVIDERS)).toBe(false);
    expect(shouldDefaultClaudeToolType("minimax", FORMATS.CLAUDE, null, PROVIDERS)).toBe(false);
    expect(shouldDefaultClaudeToolType("minimax", FORMATS.CLAUDE, "not-an-array", PROVIDERS)).toBe(false);
    // Unknown provider / missing registry must not throw.
    expect(shouldDefaultClaudeToolType("nope", FORMATS.CLAUDE, TYPELESS_TOOL, PROVIDERS)).toBe(false);
    expect(shouldDefaultClaudeToolType("minimax", FORMATS.CLAUDE, TYPELESS_TOOL, undefined)).toBe(false);
  });

  it("asserts the DeepSeek Claude transport that makes the guard necessary", () => {
    // If this ever disappears, the guard matters less — and this test should be revisited.
    const claudeTransport = (PROVIDERS.deepseek?.transports || [])
      .find(t => t.format === FORMATS.CLAUDE);
    expect(claudeTransport?.baseUrl).toBe("https://api.deepseek.com/anthropic/v1/messages");
  });

  it("declares the quirk on exactly the MiniMax providers (registry tripwire)", () => {
    const declaring = CLAUDE_CAPABLE
      .filter(id => PROVIDERS[id]?.quirks?.requireClaudeToolType === true);
    expect(declaring).toEqual(["minimax", "minimax-cn"]);
    // The tripwire is only meaningful if the list actually contains the risky ends.
    expect(CLAUDE_CAPABLE).toContain("deepseek");
    expect(CLAUDE_CAPABLE).toContain("claude");
  });
});

describe("defaultClaudeToolType", () => {
  it("stamps only tools that lack a usable type", () => {
    const stamped = defaultClaudeToolType([
      { name: "no_type", input_schema: {} },
      { name: "null_type", type: null, input_schema: {} },
      { name: "empty_type", type: "", input_schema: {} },
      { name: "unknown_type", type: "nope_123", input_schema: {} },
    ]);
    expect(stamped.map(t => t.type)).toEqual(["custom", "custom", "custom", "nope_123"]);
  });

  it("passes Anthropic built-in tool types through untouched", () => {
    const builtins = [
      { name: "computer", type: "computer_20250124", display_width_px: 1024 },
      { name: "bash", type: "bash_20250124" },
      { name: "search", type: "web_search_20250305", max_uses: 5 },
      { name: "already", type: "custom", input_schema: {} },
    ];
    const result = defaultClaudeToolType(builtins);
    expect(result).toEqual(builtins);
  });

  it("does not mutate the caller's tools array or its objects", () => {
    const tools = [{ name: "get_weather", input_schema: {} }];
    defaultClaudeToolType(tools);
    expect(tools[0].type).toBeUndefined();
    expect(tools).toHaveLength(1);
  });

  it("tolerates a missing tools array", () => {
    expect(defaultClaudeToolType(undefined)).toBeUndefined();
    expect(defaultClaudeToolType(null)).toBeNull();
    expect(defaultClaudeToolType("nope")).toBe("nope");
    expect(defaultClaudeToolType([])).toEqual([]);
  });
});

describe("chatCore wiring (source tripwire)", () => {
  const chatCoreSrc = fs.readFileSync(
    path.join(__dirname, "..", "..", "open-sse", "handlers", "chatCore.js"),
    "utf8"
  );

  it("routes the decision through shouldDefaultClaudeToolType", () => {
    expect(chatCoreSrc).toMatch(
      /if \(shouldDefaultClaudeToolType\(provider, finalFormat, translatedBody\.tools, PROVIDERS\)\) \{/
    );
  });

  it("cannot regress to the unconditional format-only stamp", () => {
    // The e08ac6da shape: `finalFormat === FORMATS.CLAUDE && Array.isArray(tools)`.
    expect(chatCoreSrc).not.toMatch(
      /if \(finalFormat === FORMATS\.CLAUDE && Array\.isArray\(translatedBody\.tools\)\)/
    );
  });
});
