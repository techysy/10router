// Issue #184: "OpenAI Responses + CodeBuddy CN → tool calls keep breaking, lots of
// stop in the translation layer", reported on 1.8.3.
//
// The first suspect was #175 (parallel calls sharing one index). This file settles
// it with CAPTURED upstream bytes rather than inference: the SSE below was recorded
// straight from copilot.tencent.com on 2026-11-27 using a live NAS credential, with
// the request body our codebuddy-cn executor sends. CodeBuddy numbers every parallel
// call correctly (0,1,2 with a fresh id+name per call), so the #175 repair never
// fires on this traffic — which also means 1.8.3 and any build after d27ed6004
// produce byte-identical Responses events for it. The guard below is what keeps that
// true: if CodeBuddy ever starts reusing an index, this test turns red and the fix
// is already in place to handle it.
import { describe, expect, it } from "vitest";
import "../translator/registerAll.js";
import {
  repairToolCallIndices,
  toolCallIndicesWereRepaired,
} from "../../open-sse/translator/concerns/toolCallIndex.js";
import { initState, translateResponse } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

// Captured: glm-5.2 asked for three parallel calls. Trimmed to the frames that
// carry tool_calls / finish_reason; argument fragments kept verbatim.
const CAPTURED = [
  { index: 0, id: "call_a5fb84c95ae84749b1324eb0", type: "function", function: { name: "get_weather", arguments: "" } },
  { index: 0, function: { arguments: '{"q": ' } },
  { index: 0, function: { arguments: '"Beiji' } },
  { index: 0, function: { arguments: 'ng"}' } },
  { index: 1, id: "call_20861fbf768e4751be4bd3cc", type: "function", function: { name: "get_time", arguments: "" } },
  { index: 1, function: { arguments: '{"q": ' } },
  { index: 1, function: { arguments: '"UTC"' } },
  { index: 1, function: { arguments: "}" } },
  { index: 2, id: "call_00348f1136be45458a703bc7", type: "function", function: { name: "read_file", arguments: "" } },
  { index: 2, function: { arguments: '{"q": "src/a.ts"}' } },
];

const chunkOf = (toolCalls) => ({
  id: "chatcmpl-captured",
  object: "chat.completion.chunk",
  created: 1795784000,
  model: "glm-5.2",
  choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }],
});

const finishChunk = {
  id: "chatcmpl-captured",
  object: "chat.completion.chunk",
  choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
};

function runThroughResponsesLane(chunks) {
  const state = initState(FORMATS.OPENAI_RESPONSES);
  const events = [];
  for (const c of chunks) {
    repairToolCallIndices(state, c);
    for (const r of translateResponse(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, c, state)) {
      if (r) events.push(r.event !== undefined ? r.data : r);
    }
  }
  for (const r of translateResponse(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, finishChunk, state)) {
    if (r) events.push(r.event !== undefined ? r.data : r);
  }
  for (const r of translateResponse(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, null, state)) {
    if (r) events.push(r.event !== undefined ? r.data : r);
  }
  return { events, state };
}

describe("CodeBuddy CN upstream wire (#184 captured traffic)", () => {
  it("numbers parallel calls correctly, so the #175 repair never fires", () => {
    const state = {};
    for (const tc of CAPTURED) repairToolCallIndices(state, chunkOf([tc]));
    expect(toolCallIndicesWereRepaired(state)).toBe(false);
  });

  it("three parallel calls become three distinct function_call items", () => {
    const { events } = runThroughResponsesLane(CAPTURED.map((tc) => chunkOf([tc])));
    const added = events.filter((e) => e.type === "response.output_item.added" && e.item?.type === "function_call");
    expect(added).toHaveLength(3);
    expect(added.map((e) => e.output_index)).toEqual([0, 1, 2]);
    expect(added.map((e) => e.item.name)).toEqual(["get_weather", "get_time", "read_file"]);

    const done = events.filter((e) => e.type === "response.output_item.done" && e.item?.type === "function_call");
    expect(done).toHaveLength(3);
    for (const e of done) expect(() => JSON.parse(e.item.arguments)).not.toThrow();
  });

  it("response.completed carries all three calls and never a bare stop", () => {
    const { events } = runThroughResponsesLane(CAPTURED.map((tc) => chunkOf([tc])));
    const completed = events.find((e) => e.type === "response.completed");
    expect(completed).toBeTruthy();
    const fns = (completed.response.output || []).filter((i) => i.type === "function_call");
    expect(fns).toHaveLength(3);
    expect(fns.map((f) => f.name)).toEqual(["get_weather", "get_time", "read_file"]);
    // The reported symptom was "many stop". A clean tool turn must not end in a
    // text-message item, and must not be booked as `stop`.
    expect(completed.response.output.some((i) => i.type === "message")).toBe(false);
    expect(events.filter((e) => e.type === "response.output_text.delta")).toHaveLength(0);
  });

  it("an interleaved fragment stream still keeps the calls apart", () => {
    // CodeBuddy sends calls sequentially; a harness that interleaves them must
    // not be merged. Same ids, alternating fragments.
    const interleaved = [
      CAPTURED[0], CAPTURED[4], CAPTURED[8],
      CAPTURED[1], CAPTURED[5], CAPTURED[9],
      CAPTURED[2], CAPTURED[6],
      CAPTURED[3], CAPTURED[7],
    ];
    const state = {};
    for (const tc of interleaved) repairToolCallIndices(state, chunkOf([tc]));
    expect(toolCallIndicesWereRepaired(state)).toBe(false);

    const { events } = runThroughResponsesLane(interleaved.map((tc) => chunkOf([tc])));
    const done = events.filter((e) => e.type === "response.output_item.done" && e.item?.type === "function_call");
    expect(done).toHaveLength(3);
    const byName = Object.fromEntries(done.map((e) => [e.item.name, JSON.parse(e.item.arguments)]));
    expect(byName).toEqual({
      get_weather: { q: "Beijing" },
      get_time: { q: "UTC" },
      read_file: { q: "src/a.ts" },
    });
  });
});
