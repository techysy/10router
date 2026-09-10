// Codex's /responses schema validator implements no Unicode property escapes: a tool
// `pattern` carrying `\p{...}` 400s the whole request on every account (#3922), so the
// Codex dispatch path strips exactly those patterns and leaves everything else alone.
import { describe, expect, it } from "vitest";
import {
  hasUnicodePropertyEscape,
  stripCodexUnsupportedPatterns,
} from "../../open-sse/utils/codexToolSchema.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";

const ESCAPED = "^(?!__.*__$)[^\\p{Cc}\\p{Cf}]{1,200}$";

function normalizeTools(tools) {
  const executor = new CodexExecutor();
  const body = {
    model: "gpt-5.5",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "probe" }] }],
    tools,
    stream: true,
  };

  executor.transformRequest("gpt-5.5", body, true, {
    connectionId: "test-codex-schema-pattern",
    providerSpecificData: {},
  });

  return body.tools;
}

const paramsWith = (pattern) => ({
  type: "object",
  properties: { value: { type: "string", pattern, description: "keep me" } },
  required: ["value"],
});

describe("hasUnicodePropertyEscape", () => {
  it("detects property escapes", () => {
    expect(hasUnicodePropertyEscape("^\\p{Cc}$")).toBe(true);
    expect(hasUnicodePropertyEscape("^\\P{Cc}$")).toBe(true);
  });

  it("ignores an escaped backslash, which makes the p a literal", () => {
    // Two backslashes = one escaped backslash, so this matches a literal "p{Cc}".
    expect(hasUnicodePropertyEscape("^\\\\p{Cc}$")).toBe(false);
    // Three backslashes = escaped backslash + real property escape.
    expect(hasUnicodePropertyEscape("^\\\\\\p{Cc}$")).toBe(true);
  });

  it("ignores ordinary patterns and non-strings", () => {
    expect(hasUnicodePropertyEscape("^[a-z]{1,20}$")).toBe(false);
    expect(hasUnicodePropertyEscape(undefined)).toBe(false);
    expect(hasUnicodePropertyEscape({ pattern: "^\\p{Cc}$" })).toBe(false);
  });
});

describe("stripCodexUnsupportedPatterns", () => {
  it("drops only the offending pattern and keeps the rest of the node", () => {
    const schema = {
      type: "object",
      properties: {
        path: { type: "string", pattern: ESCAPED, description: "keep me" },
        name: { type: "string", pattern: "^[a-z]+$" },
      },
      required: ["path"],
    };
    const stats = { removed: 0 };

    const out = stripCodexUnsupportedPatterns(schema, stats);

    expect(stats.removed).toBe(1);
    expect(out.properties.path).not.toHaveProperty("pattern");
    expect(out.properties.path.description).toBe("keep me");
    expect(out.properties.name.pattern).toBe("^[a-z]+$");
  });

  it("returns the same reference when nothing needs stripping", () => {
    const schema = { type: "object", properties: { name: { type: "string" } } };

    expect(stripCodexUnsupportedPatterns(schema)).toBe(schema);
  });

  it("keeps untouched sub-nodes by reference", () => {
    const untouched = { type: "string" };
    const schema = { type: "object", properties: { a: untouched, b: { type: "string", pattern: ESCAPED } } };

    const out = stripCodexUnsupportedPatterns(schema);

    expect(out.properties.a).toBe(untouched);
  });

  it("walks arrays and nested schemas", () => {
    const schema = {
      anyOf: [
        { type: "string", pattern: ESCAPED },
        { type: "object", properties: { deep: { type: "string", pattern: ESCAPED } } },
      ],
    };
    const stats = { removed: 0 };

    const out = stripCodexUnsupportedPatterns(schema, stats);

    expect(stats.removed).toBe(2);
    expect(out.anyOf[0]).not.toHaveProperty("pattern");
    expect(out.anyOf[1].properties.deep).not.toHaveProperty("pattern");
  });

  it("never reads a property named `pattern` as the schema keyword", () => {
    const schema = { type: "object", properties: { pattern: ESCAPED } };
    const stats = { removed: 0 };

    const out = stripCodexUnsupportedPatterns(schema, stats);

    expect(stats.removed).toBe(0);
    expect(out.properties).toEqual({ pattern: ESCAPED });
  });
});

describe("CodexExecutor tool normalization: unsupported patterns", () => {
  it("strips the offending pattern from a function tool's parameters", () => {
    const tools = normalizeTools([{ type: "function", name: "Artifact", parameters: paramsWith(ESCAPED) }]);

    expect(tools[0].parameters.properties.value).not.toHaveProperty("pattern");
    expect(tools[0].parameters.properties.value.description).toBe("keep me");
    expect(tools[0].parameters.required).toEqual(["value"]);
  });

  it("leaves a compatible schema untouched", () => {
    const parameters = paramsWith("^[a-z]{1,20}$");

    const tools = normalizeTools([{ type: "function", name: "Lookup", parameters }]);

    expect(tools[0].parameters).toEqual(parameters);
  });

  it("covers the { function: { parameters } } shape", () => {
    const tools = normalizeTools([
      { type: "function", function: { name: "Wrapped", parameters: paramsWith(ESCAPED) } },
    ]);

    expect(tools[0].parameters.properties.value).not.toHaveProperty("pattern");
  });

  it("strips inside namespace sub-tools too", () => {
    const tools = normalizeTools([
      {
        type: "namespace",
        name: "fs",
        tools: [{ name: "read_file", parameters: paramsWith(ESCAPED) }],
      },
    ]);

    expect(tools[0].tools[0].parameters.properties.value).not.toHaveProperty("pattern");
  });

  it("keeps tools that were never affected", () => {
    const tools = normalizeTools([
      { type: "function", name: "Clean", parameters: paramsWith("^[a-z]+$") },
      { type: "function", name: "Dirty", parameters: paramsWith(ESCAPED) },
    ]);

    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe("Clean");
    expect(tools[1].name).toBe("Dirty");
  });
});
