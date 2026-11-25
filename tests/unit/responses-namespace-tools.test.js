// Codex ships its tool set as Responses "namespace" declarations
// ({ type: "namespace", name: "functions", tools: [...] }) delivered in an
// `additional_tools` input item. Chat Completions has no namespace concept, so the
// Responses→Chat translator must spread each namespace into its member tools. Emitting
// the namespace itself instead declares a parameterless `functions`/`clock` tool and
// drops exec/sleep/spawn_agent, so the model calls the namespace name and the Codex
// harness answers "unsupported call: functions" (observed on xc/gpt-6-astra).
import { describe, it, expect } from "vitest";
import { openaiResponsesToOpenAIRequest } from "../../open-sse/translator/request/openai-responses.js";

// The two shapes Codex actually sends: a freeform `custom` tool and a `function` tool.
const CODEX_NAMESPACES = [
  {
    type: "namespace",
    name: "functions",
    description: "",
    tools: [
      { type: "custom", name: "exec", description: "Run JavaScript code to orchestrate tool calls" },
      {
        type: "function",
        name: "request_user_input",
        description: "Ask the user",
        parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
      },
    ],
  },
  {
    type: "namespace",
    name: "clock",
    description: "Tools for reading and waiting on time.",
    tools: [
      {
        type: "function",
        name: "sleep",
        description: "Sleep",
        parameters: { type: "object", properties: { ms: { type: "number" } }, required: ["ms"] },
      },
    ],
  },
];

function translateWithAdditionalTools(tools) {
  return openaiResponsesToOpenAIRequest(
    "xc/gpt-6-astra",
    {
      model: "xc/gpt-6-astra",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "run pwd" }] },
        { type: "additional_tools", role: "developer", tools },
      ],
    },
    true,
    null
  );
}

describe("responses→chat namespace tool expansion", () => {
  it("expands Codex namespaces into their member tools instead of the namespace names", () => {
    const out = translateWithAdditionalTools(CODEX_NAMESPACES);
    const names = out.tools.map((t) => t.function.name);

    expect(names).toEqual(["exec", "request_user_input", "sleep"]);
    // The namespace names themselves must never surface as callable tools.
    expect(names).not.toContain("functions");
    expect(names).not.toContain("clock");
  });

  it("keeps each member tool's parameters and marks custom tools for the response hop", () => {
    const out = translateWithAdditionalTools(CODEX_NAMESPACES);
    const byName = new Map(out.tools.map((t) => [t.function.name, t.function]));

    expect(byName.get("sleep").parameters.properties.ms).toEqual({ type: "number" });
    expect(byName.get("exec").parameters.required).toEqual(["input"]);
    // exec is a `custom` tool, so the response converter needs its name to emit custom_tool_call.
    // Consumers call `.has()`, so the marker must be a Set — an array trips
    // `b?.has is not a function` on the non-streaming/sse-to-json response path.
    expect(out._customToolNames).toBeInstanceOf(Set);
    expect(out._customToolNames.has("exec")).toBe(true);
  });

  it("expands namespaces nested inside namespaces", () => {
    const out = translateWithAdditionalTools([
      {
        type: "namespace",
        name: "collaboration",
        tools: [
          {
            type: "namespace",
            name: "agents",
            tools: [
              { type: "function", name: "spawn_agent", description: "spawn", parameters: { type: "object", properties: {} } },
            ],
          },
        ],
      },
    ]);

    expect(out.tools.map((t) => t.function.name)).toEqual(["spawn_agent"]);
  });

  it("still drops namespaces with no member tools", () => {
    const out = translateWithAdditionalTools([{ type: "namespace", name: "empty", tools: [] }]);
    expect(out.tools).toEqual([]);
  });

  it("leaves flat Responses function tools working alongside namespaces", () => {
    const out = translateWithAdditionalTools([
      { type: "function", name: "plain_fn", description: "plain", parameters: { type: "object", properties: {} } },
      ...CODEX_NAMESPACES,
    ]);

    expect(out.tools.map((t) => t.function.name)).toEqual([
      "plain_fn",
      "exec",
      "request_user_input",
      "sleep",
    ]);
  });
});
