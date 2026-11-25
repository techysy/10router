import { describe, expect, it } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { initState } from "../../open-sse/translator/index.js";
import { openaiToOpenAIResponsesResponse } from "../../open-sse/translator/response/openai-responses.js";

// targetFormat === OPENAI is the direct openai -> openai-responses route, which is
// the only one where flush() reaches this translator (see the flushReachesUs note
// above the finish_reason branch).
function newState() {
  return { ...initState(FORMATS.OPENAI_RESPONSES), targetFormat: FORMATS.OPENAI };
}

function textChunk(text, index = 0) {
  return { id: "chatcmpl-1", choices: [{ index, delta: { content: text } }] };
}

function reasoningChunk(text, index = 0) {
  return { id: "chatcmpl-1", choices: [{ index, delta: { reasoning_content: text } }] };
}

function toolChunk(toolCalls, content, index = 0) {
  return { id: "chatcmpl-1", choices: [{ index, delta: { tool_calls: toolCalls, content } }] };
}

function finishChunk(usage) {
  return { id: "chatcmpl-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage };
}

function runChunks(chunks, state = newState()) {
  const events = [];
  for (const chunk of chunks) {
    for (const event of openaiToOpenAIResponsesResponse(chunk, state)) events.push(event);
  }
  return { state, events };
}

function completedResponse(events) {
  const completed = events.find((event) => event.event === "response.completed");
  expect(completed, "expected a response.completed event").toBeTruthy();
  return completed.data.response;
}

function doneItems(events) {
  return events
    .filter((event) => event.event === "response.output_item.done")
    .map((event) => event.data.item);
}

function expectOutputLifecycle(events, types) {
  const added = events.filter((event) => event.event === "response.output_item.added");
  const done = events.filter((event) => event.event === "response.output_item.done");
  expect(added.map((event) => event.data.item.type)).toEqual(types);
  expect(added.map((event) => event.data.output_index)).toEqual(types.map((_, index) => index));
  expect(done).toHaveLength(added.length);

  // Every part, delta and done must refer to an already announced item, with
  // the same index/id pair. Completion order can differ for parallel tools.
  const announced = new Map();
  const closed = new Set();
  for (const event of events) {
    const { data } = event;
    if (data.output_index === undefined) continue;
    const id = data.item?.id ?? data.item_id;
    expect(Number.isInteger(data.output_index)).toBe(true);
    expect(id).toBeTruthy();
    if (event.event === "response.output_item.added") {
      expect(announced.has(id)).toBe(false);
      announced.set(id, data.output_index);
    } else {
      expect(announced.has(id)).toBe(true);
      expect(data.output_index).toBe(announced.get(id));
      expect(closed.has(id)).toBe(false);
      if (event.event === "response.output_item.done") closed.add(id);
    }
  }
  expect(closed.size).toBe(added.length);

  const response = completedResponse(events);
  const orderedDone = [...done].sort((a, b) => a.data.output_index - b.data.output_index);
  expect(response.output).toEqual(orderedDone.map((event) => event.data.item));
  expect(response.output.map((item) => item.id)).toEqual(added.map((event) => event.data.item.id));
  for (const event of done) {
    expect(response.output[event.data.output_index]).toEqual(event.data.item);
  }
  expect(events.filter((event) => event.event === "response.completed")).toHaveLength(1);
  expect(events.map((event) => event.data.sequence_number)).toEqual(events.map((_, index) => index + 1));
  return response;
}

describe("response.completed output (#4307)", () => {
  // The regression: sendCompleted() built the response object without an `output`
  // key at all, so response.completed arrived with no output even though the
  // message had already been streamed. Clients that build the final result from
  // the terminal event (Codex 等 Responses 客户端不回放事件流) printed
  // the text and then treated the turn as empty.
  it("repeats the streamed message in response.completed", () => {
    const state = newState();
    openaiToOpenAIResponsesResponse(textChunk("O"), state);
    openaiToOpenAIResponsesResponse(textChunk("K"), state);
    const response = completedResponse(openaiToOpenAIResponsesResponse(null, state));

    expect(response.status).toBe("completed");
    expect(Array.isArray(response.output)).toBe(true);
    expect(response.output).toHaveLength(1);
    expect(response.output[0]).toMatchObject({ type: "message", role: "assistant" });
    expect(response.output[0].content[0]).toMatchObject({ type: "output_text", text: "OK" });
  });

  it("matches exactly the items already delivered in response.output_item.done", () => {
    const { events } = runChunks([
      textChunk("hello"),
      finishChunk({ prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 }),
    ]);
    const response = completedResponse(events);
    const streamed = doneItems(events);

    expect(streamed).toHaveLength(1);
    expect(response.output).toEqual(streamed);
  });

  it("includes a function_call item", () => {
    const { events } = runChunks([
      {
        id: "chatcmpl-1",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
              ],
            },
          },
        ],
      },
      finishChunk({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
    ]);
    const response = completedResponse(events);

    expect(response.output).toHaveLength(1);
    expect(response.output[0]).toMatchObject({
      type: "function_call",
      name: "get_weather",
      arguments: '{"city":"Paris"}',
      call_id: "call_1",
    });
  });

  // Preserve the baseline test identity while exercising the real same-choice shape.
  it("orders output by output_index", () => {
    const { events } = runChunks([
      reasoningChunk("think"),
      reasoningChunk("ing"),
      textChunk("ans"),
      textChunk("wer"),
      finishChunk({ prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }),
    ]);
    const response = expectOutputLifecycle(events, ["reasoning", "message"]);

    expect(response.output[0].summary[0]).toEqual({ type: "summary_text", text: "thinking" });
    expect(response.output[1].content[0]).toMatchObject({ type: "output_text", text: "answer" });
  });

  it("preserves reasoning, message and tool call when every upstream index is zero", () => {
    const { state, events } = runChunks([
      reasoningChunk("Thinking"),
      textChunk("Looking it up"),
      toolChunk([{ index: 0, id: "call_0", function: { name: "lookup", arguments: '{"q":"x"}' } }]),
      { id: "chatcmpl-1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      null,
    ]);
    const response = expectOutputLifecycle(events, ["reasoning", "message", "function_call"]);

    expect(response.output).toEqual(doneItems(events));
    expect(response.output[2]).toMatchObject({ call_id: "call_0", name: "lookup", arguments: '{"q":"x"}' });
    expect(state.completedOutputItems.size).toBe(3);
    expect(openaiToOpenAIResponsesResponse(null, state)).toEqual([]);
  });

  it("keeps text and tool calls in the same delta at separate output indices", () => {
    const { events } = runChunks([
      toolChunk([{ index: 0, id: "call_0", function: { name: "lookup", arguments: '{"q":' } }], "Looking it up"),
      toolChunk([{ index: 0, function: { arguments: '"x"}' } }]),
      null,
    ]);
    const response = expectOutputLifecycle(events, ["message", "function_call"]);

    expect(response.output[0].content[0].text).toBe("Looking it up");
    expect(response.output[1].arguments).toBe('{"q":"x"}');
    const deltas = events.filter((event) => event.event === "response.function_call_arguments.delta");
    expect(deltas.map((event) => event.data.output_index)).toEqual([1, 1]);
    expect(deltas.map((event) => event.data.delta).join("")).toBe('{"q":"x"}');
  });

  it.each(["id", "name"])("maps parallel calls with split metadata (%s first) in announcement order", (firstField) => {
    const firstMetadata = firstField === "id"
      ? { id: "call_first", function: { arguments: '{"q":' } }
      : { function: { name: "lookup", arguments: '{"q":' } };
    const lastMetadata = firstField === "id"
      ? { function: { name: "lookup" } }
      : { id: "call_first" };
    const { events } = runChunks([
      textChunk("Searching"),
      toolChunk([
        { index: 0, ...firstMetadata },
        { index: 1, id: "call_second", function: { name: "lookup", arguments: '{"q":"second"' } },
      ]),
      toolChunk([{ index: 0, function: { arguments: '"first"' } }]),
      toolChunk([
        { index: 0, ...lastMetadata },
        { index: 1, function: { arguments: "}" } },
      ]),
      toolChunk([{ index: 0, function: { arguments: "}" } }]),
      finishChunk(),
      { id: "chatcmpl-1", choices: [], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } },
      null,
    ]);
    const response = expectOutputLifecycle(events, ["message", "function_call", "function_call"]);

    expect(response.output.slice(1)).toMatchObject([
      { id: "fc_call_second", call_id: "call_second", name: "lookup", arguments: '{"q":"second"}' },
      { id: "fc_call_first", call_id: "call_first", name: "lookup", arguments: '{"q":"first"}' },
    ]);
    for (const item of response.output.slice(1)) {
      const deltas = events.filter((event) => event.event === "response.function_call_arguments.delta" && event.data.item_id === item.id);
      expect(deltas.map((event) => event.data.delta).join("")).toBe(item.arguments);
    }
    expect(response.usage).toMatchObject({ input_tokens: 4, output_tokens: 3, total_tokens: 7 });
  });

  it("assigns compact output indices even when source choice and tool indices are sparse", () => {
    const { events } = runChunks([
      reasoningChunk("thinking", 7),
      textChunk("answer", 7),
      toolChunk([{ index: 9, id: "call_9", function: { name: "lookup", arguments: "{}" } }], undefined, 7),
      null,
    ]);
    expectOutputLifecycle(events, ["reasoning", "message", "function_call"]);
  });

  it("announces an id-only call before completing its fallback item", () => {
    const { events } = runChunks([
      textChunk("Looking it up"),
      toolChunk([{ index: 0, id: "call_0", function: { arguments: "{}" } }]),
      null,
    ]);
    const response = expectOutputLifecycle(events, ["message", "function_call"]);
    expect(response.output[1]).toMatchObject({ call_id: "call_0", name: "", arguments: "{}" });
  });

  it("keeps custom input unwrapped and separate from a parallel function call", () => {
    const state = newState();
    state.customToolNames = new Set(["exec"]);
    const { events } = runChunks([
      reasoningChunk("thinking"),
      textChunk("Running tools"),
      toolChunk([
        { index: 0, id: "call_exec", function: { arguments: '{"input":"return ' } },
        { index: 1, id: "call_lookup", function: { name: "lookup", arguments: '{"q":' } },
      ]),
      toolChunk([
        { index: 0, function: { name: "exec", arguments: '1;"}' } },
        { index: 1, function: { arguments: '"x"}' } },
      ]),
      null,
    ], state);
    const response = expectOutputLifecycle(events, ["reasoning", "message", "function_call", "custom_tool_call"]);

    expect(response.output[2]).toMatchObject({ call_id: "call_lookup", name: "lookup", arguments: '{"q":"x"}' });
    expect(response.output[3]).toMatchObject({ id: "ctc_call_exec", call_id: "call_exec", name: "exec", input: "return 1;" });
    expect(response.output[3]).not.toHaveProperty("arguments");
    const customDelta = events.filter((event) => event.event === "response.custom_tool_call_input.delta");
    expect(customDelta).toHaveLength(1);
    expect(customDelta[0].data).toMatchObject({ item_id: "ctc_call_exec", output_index: 3, delta: "return 1;" });
    const customDone = events.filter((event) => event.event === "response.custom_tool_call_input.done");
    expect(customDone).toHaveLength(1);
    expect(customDone[0].data).toMatchObject({ item_id: "ctc_call_exec", output_index: 3, input: "return 1;" });
    const functionDeltas = events.filter((event) => event.event === "response.function_call_arguments.delta");
    expect(functionDeltas.map((event) => event.data.item_id)).toEqual(["fc_call_lookup", "fc_call_lookup"]);
    expect(functionDeltas.map((event) => event.data.delta).join("")).toBe('{"q":"x"}');
  });

  it("reports an empty output array when nothing was produced", () => {
    const state = newState();
    const response = completedResponse(openaiToOpenAIResponsesResponse(null, state));
    expect(response.output).toEqual([]);
  });

  it("keeps the usage block alongside output", () => {
    const { events } = runChunks([
      textChunk("OK"),
      finishChunk({ prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }),
    ]);
    const response = completedResponse(events);

    expect(response.usage).toMatchObject({ input_tokens: 3, output_tokens: 1, total_tokens: 4 });
    expect(response.output).toHaveLength(1);
  });

  it("leaves the in-progress response.created output empty", () => {
    const { events } = runChunks([textChunk("hi")]);
    const created = events.find((event) => event.event === "response.created");
    expect(created.data.response.status).toBe("in_progress");
    expect(created.data.response.output).toEqual([]);
  });

  it("does not duplicate items when flush runs more than once", () => {
    const state = newState();
    openaiToOpenAIResponsesResponse(textChunk("once"), state);
    openaiToOpenAIResponsesResponse(null, state);
    const second = openaiToOpenAIResponsesResponse(null, state);

    expect(second).toEqual([]);
    expect(state.completedOutputItems.size).toBe(1);
  });
});
