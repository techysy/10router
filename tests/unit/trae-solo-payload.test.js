import { describe, it, expect } from "vitest";

import { buildTraeSoloPayload, sanitizeTraeSoloModelName } from "../../open-sse/executors/trae-solo.js";

// The upstream rebuilds nothing: it rejects unknown keys and four OpenAI shapes
// outright. These cases pin the four transforms plus the whitelist.
describe("trae-solo payload rebuild", () => {
  it("keeps tools, serializes parameters to a string and flattens tool_choice", () => {
    const body = {
      model: "kimi-k2.5",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            description: "read a file",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "read_file" } },
      temperature: 0.2,
      top_p: "0.9", // non-numeric must be dropped, not forwarded
      stream_options: { include_usage: true },
      thinking: { type: "enabled" },
      prompt_cache_key: "must-not-leak",
    };

    const out = buildTraeSoloPayload(body, "kimi-k2.5");

    expect(out.function).toBe("solo_work_lite");
    expect(out.stream).toBe(true);
    expect(out.model).toBe("kimi-k2.5");
    expect(out.config_name).toBe("kimi-k2.5");
    expect(out.prompt_max_tokens).toBe(168000);
    expect(out.max_tokens).toBe(1000000);

    expect(out.tool_choice).toBe("read_file");
    expect(out.tools).toHaveLength(1);
    expect(typeof out.tools[0].function.parameters).toBe("string");
    expect(JSON.parse(out.tools[0].function.parameters)).toEqual(body.tools[0].function.parameters);

    // sampling whitelist: numbers only
    expect(out.temperature).toBe(0.2);
    expect(out).not.toHaveProperty("top_p");
    // unknown keys are not forwarded
    expect(out).not.toHaveProperty("stream_options");
    expect(out).not.toHaveProperty("thinking");
    expect(out).not.toHaveProperty("prompt_cache_key");
  });

  it("rename developer to system and assistant tool_calls to function_call", () => {
    const out = buildTraeSoloPayload(
      {
        model: "glm-5.2",
        messages: [
          { role: "developer", content: "rules" },
          { role: "user", content: "read /tmp/a" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"/tmp/a"}' } },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "ok" },
          // Orphan tool result (client trimmed the assistant turn)
          { role: "tool", tool_call_id: "call_missing", content: "drop me" },
        ],
      },
      "glm-5.2"
    );

    expect(out.messages[0].role).toBe("system");
    const assistant = out.messages[2];
    // the array stays; the inner `function` field is renamed to `function_call`
    expect(assistant.tool_calls).toHaveLength(1);
    expect(assistant.tool_calls[0]).not.toHaveProperty("function");
    expect(assistant.tool_calls[0].function_call.name).toBe("read_file");
    expect(assistant.tool_calls[0].function_call.arguments).toBe('{"path":"/tmp/a"}');
    // string content becomes a text block
    expect(out.messages[1].content).toEqual([{ type: "text", text: "read /tmp/a" }]);
    // orphan tool result is dropped
    expect(out.messages.filter((m) => m.role === "tool")).toHaveLength(1);
  });

  it("tool_choice none suppresses tools, and unnamed calls take the placeholder down", () => {
    const none = buildTraeSoloPayload({
      model: "m",
      messages: [],
      tools: [{ type: "function", function: { name: "f", parameters: {} } }],
      tool_choice: "none",
    });
    expect(none).not.toHaveProperty("tools");
    expect(none).not.toHaveProperty("tool_choice");

    const unnamed = buildTraeSoloPayload({
      model: "m",
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", tool_calls: [{ id: "c1", function: { arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: "orphan" },
      ],
    });
    expect(unnamed.messages).toHaveLength(1);
    expect(unnamed.messages[0].role).toBe("user");
  });

  it("normalizes model names without splitting on slash", () => {
    expect(sanitizeTraeSoloModelName("kimi-k2.5-solo")).toBe("kimi-k2.5");
    expect(sanitizeTraeSoloModelName("x-solo-intl")).toBe("x-solo");
    expect(sanitizeTraeSoloModelName("deepseek-ai/deepseek-v4-pro")).toBe("deepseek-ai/deepseek-v4-pro");
    // blank model falls back to the reference default config
    expect(buildTraeSoloPayload({ model: "", messages: [] }).config_name).toBe("glm-5.2");
  });
});
