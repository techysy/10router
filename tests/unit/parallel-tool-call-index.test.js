// Issue #175: parallel tool calls whose upstream reuses index 0.
//
// The wire shape below is not invented — it was captured on the live gateway
// (NAS, qwc/qwen4-max, 2026-11-27) while forcing two parallel tool calls:
// the second call arrives with a NEW id and a NEW name but `index: 0` again.
// Before the fix, non-streaming chat returned ONE call named
// "get_weatherget_time" with arguments `{"city": "Beijing"}{"zone": "UTC"}`,
// and the Responses lane emitted two output_item.added at output_index 1.
//
// The guards matter as much as the fix: a well-behaved upstream sends the name
// once and then bare argument fragments on the SAME index. Those must keep
// merging — a per-chunk counter would shatter every normal stream.
import { describe, expect, it } from "vitest";
import "../translator/registerAll.js";
import {
  resolveToolCallIndex,
  repairToolCallIndices,
  toolCallIndicesWereRepaired,
} from "../../open-sse/translator/concerns/toolCallIndex.js";
import { parseSSEToOpenAIResponse } from "../../open-sse/handlers/chatCore/sseToJsonHandler.js";
import { initState, translateResponse } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";

const callStart = (id, name, index = 0) => ({
  index,
  id,
  type: "function",
  function: { name, arguments: "" },
});
const argsFragment = (text, index = 0) => ({ index, function: { arguments: text } });

const chunk = (tc) => ({
  id: "chatcmpl-test",
  object: "chat.completion.chunk",
  choices: [{ index: 0, delta: { tool_calls: [tc] }, finish_reason: null }],
});

// The captured hostile stream: call #1 opens and streams its arguments, then
// call #2 opens on the SAME index with a different id and name.
function hostileDeltas() {
  return [
    callStart("toolu_8a123c97", "get_weather"),
    argsFragment('{"city": "Bei'),
    argsFragment('jing"}'),
    callStart("toolu_9c346c0f", "get_time"),
    argsFragment('{"zone": "UTC"}'),
  ];
}

// A normal upstream: one call, name once, then bare fragments on index 0.
function legalDeltas() {
  return [
    callStart("call_a", "get_weather"),
    argsFragment('{"city": "Bei'),
    argsFragment('jing"}'),
  ];
}

function sseOf(deltas) {
  return deltas.map((tc) => `data: ${JSON.stringify(chunk(tc))}\n\n`).join("")
    + `data: ${JSON.stringify({ id: "chatcmpl-test", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`
    + "data: [DONE]\n\n";
}

// Accumulate the way an OpenAI client does: key on index, append name/arguments.
function accumulate(chunks) {
  const calls = new Map();
  for (const c of chunks) {
    for (const tc of c?.choices?.[0]?.delta?.tool_calls || []) {
      const idx = tc.index ?? 0;
      if (!calls.has(idx)) calls.set(idx, { id: "", name: "", args: "" });
      const slot = calls.get(idx);
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name += tc.function.name;
      if (tc.function?.arguments) slot.args += tc.function.arguments;
    }
  }
  return calls;
}

describe("resolveToolCallIndex — the id/name boundary discriminator", () => {
  it("keeps legal same-index argument fragments in one slot", () => {
    const state = {};
    const slots = legalDeltas().map((tc) => resolveToolCallIndex(state, tc));
    expect(slots).toEqual([0, 0, 0]);
    expect(toolCallIndicesWereRepaired(state)).toBe(false);
  });

  it("gives a new id + new name on a used index its own slot", () => {
    const state = {};
    const slots = hostileDeltas().map((tc) => resolveToolCallIndex(state, tc));
    // call #1 and its two fragments stay on the upstream's 0; call #2 and its
    // fragment share one repaired slot, distinct from 0.
    expect(slots[0]).toBe(0);
    expect(slots[1]).toBe(0);
    expect(slots[2]).toBe(0);
    expect(slots[3]).not.toBe(0);
    expect(slots[4]).toBe(slots[3]);
    expect(toolCallIndicesWereRepaired(state)).toBe(true);
  });

  it("does not split when the upstream repeats the SAME id on every chunk (GLM/fireworks)", () => {
    const state = {};
    const deltas = [
      callStart("call_x", "read_file"),
      { index: 0, id: "call_x", function: { arguments: '{"a":' } },
      { index: 0, id: "call_x", function: { arguments: "1}" } },
    ];
    expect(deltas.map((tc) => resolveToolCallIndex(state, tc))).toEqual([0, 0, 0]);
    expect(toolCallIndicesWereRepaired(state)).toBe(false);
  });

  it("does not split on an empty name (CodeBuddy CN repeats name:'')", () => {
    const state = {};
    const deltas = [
      callStart("call_y", "bash"),
      { index: 0, function: { name: "", arguments: '{"cmd":' } },
      { index: 0, function: { name: "", arguments: '"ls"}' } },
    ];
    expect(deltas.map((tc) => resolveToolCallIndex(state, tc))).toEqual([0, 0, 0]);
  });

  it("honours genuinely increasing indices verbatim", () => {
    const state = {};
    const deltas = [
      callStart("call_0", "read_file", 0),
      argsFragment('{"p":1}', 0),
      callStart("call_1", "read_file", 1),
      argsFragment('{"p":2}', 1),
    ];
    expect(deltas.map((tc) => resolveToolCallIndex(state, tc))).toEqual([0, 0, 1, 1]);
    expect(toolCallIndicesWereRepaired(state)).toBe(false);
  });

  it("keeps repaired slots dense, never rewriting one already announced", () => {
    const state = {};
    // index 0 reused for a second call, then the upstream legitimately uses 1.
    const deltas = [
      callStart("a", "f"),
      callStart("b", "g"),
      callStart("c", "h", 1),
    ];
    const slots = deltas.map((tc) => resolveToolCallIndex(state, tc));
    // call #1 keeps 0, the repaired call #2 keeps the 1 it was already given,
    // and the late legit arrival yields to 2 rather than displacing it.
    expect(slots).toEqual([0, 1, 2]);
    expect(new Set(slots).size).toBe(3);
  });

  it("handles three calls all announced on index 0", () => {
    const state = {};
    const deltas = [
      callStart("a", "f"), argsFragment("{}"),
      callStart("b", "g"), argsFragment("{}"),
      callStart("c", "h"), argsFragment("{}"),
    ];
    expect(deltas.map((tc) => resolveToolCallIndex(state, tc))).toEqual([0, 0, 1, 1, 2, 2]);
  });

  it("treats a name-only new call (no id) as a boundary too", () => {
    const state = {};
    const deltas = [
      { index: 0, function: { name: "f", arguments: "{}" } },
      { index: 0, function: { name: "g", arguments: "{}" } },
    ];
    expect(deltas.map((tc) => resolveToolCallIndex(state, tc))).toEqual([0, 1]);
  });

  it("is per-stream: two independent states do not share bookkeeping", () => {
    const a = {};
    const b = {};
    hostileDeltas().forEach((tc) => resolveToolCallIndex(a, tc));
    expect(legalDeltas().map((tc) => resolveToolCallIndex(b, tc))).toEqual([0, 0, 0]);
  });

  it("tolerates a missing index and junk entries without throwing", () => {
    const state = {};
    expect(resolveToolCallIndex(state, { id: "z", function: { name: "f" } })).toBe(0);
    expect(resolveToolCallIndex(state, {})).toBe(0);
    expect(() => repairToolCallIndices(state, { choices: [{ delta: { tool_calls: [null, 3, {}] } }] })).not.toThrow();
    expect(() => repairToolCallIndices(state, null)).not.toThrow();
    expect(() => repairToolCallIndices(state, { choices: "nope" })).not.toThrow();
  });
});

describe("non-streaming chat aggregation splits the reused index (#175 repro)", () => {
  it("yields two separately parseable calls instead of one glued call", () => {
    const parsed = parseSSEToOpenAIResponse(sseOf(hostileDeltas()), "qwc/qwen4-max");
    const calls = parsed.choices[0].message.tool_calls;
    expect(calls).toHaveLength(2);
    expect(calls[0].function.name).toBe("get_weather");
    expect(calls[1].function.name).toBe("get_time");
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ city: "Beijing" });
    expect(JSON.parse(calls[1].function.arguments)).toEqual({ zone: "UTC" });
    expect(calls[0].id).toBe("toolu_8a123c97");
    expect(calls[1].id).toBe("toolu_9c346c0f");
  });

  it("leaves a legal single-call stream as exactly one call", () => {
    const parsed = parseSSEToOpenAIResponse(sseOf(legalDeltas()), "qwc/qwen4-max");
    const calls = parsed.choices[0].message.tool_calls;
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("get_weather");
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ city: "Beijing" });
  });
});

async function runStream(input, transform) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(c) { c.enqueue(encoder.encode(input)); c.close(); },
  });
  const reader = stream.pipeThrough(transform).getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

const parseOut = (text) => text.split("\n")
  .filter((l) => l.trim().startsWith("data:"))
  .map((l) => l.trim().slice(5).trim())
  .filter((p) => p && p !== "[DONE]")
  .map((p) => { try { return JSON.parse(p); } catch { return null; } })
  .filter(Boolean);

describe("streaming passthrough forwards corrected indices on the wire", () => {
  it("rewrites the second call's index so a client accumulator keeps them apart", async () => {
    const out = await runStream(sseOf(hostileDeltas()), createPassthroughStreamWithLogger("qwc", null, "qwen4-max"));
    const calls = accumulate(parseOut(out));
    expect(calls.size).toBe(2);
    expect(calls.get(0).name).toBe("get_weather");
    expect(calls.get(1).name).toBe("get_time");
    expect(JSON.parse(calls.get(0).args)).toEqual({ city: "Beijing" });
    expect(JSON.parse(calls.get(1).args)).toEqual({ zone: "UTC" });
  });

  it("does not touch a legal stream's indices", async () => {
    const out = await runStream(sseOf(legalDeltas()), createPassthroughStreamWithLogger("qwc", null, "qwen4-max"));
    const calls = accumulate(parseOut(out));
    expect(calls.size).toBe(1);
    expect(JSON.parse(calls.get(0).args)).toEqual({ city: "Beijing" });
  });
});

describe("chat → Responses translation keeps parallel calls in separate output items", () => {
  const collect = (deltas) => {
    const state = initState(FORMATS.OPENAI_RESPONSES);
    const out = [];
    const push = (r) => { if (r) out.push(r.event !== undefined ? r.data : r); };
    for (const tc of deltas) {
      const c = chunk(tc);
      repairToolCallIndices(state, c);
      for (const r of translateResponse(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, c, state)) push(r);
    }
    for (const r of translateResponse(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }, state)) push(r);
    for (const r of translateResponse(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, null, state)) push(r);
    return out.filter(Boolean);
  };

  it("emits two function_call items at distinct output_index values", () => {
    const out = collect(hostileDeltas());
    const added = out.filter((e) => e.type === "response.output_item.added" && e.item?.type === "function_call");
    expect(added).toHaveLength(2);
    expect(new Set(added.map((e) => e.output_index)).size).toBe(2);

    const done = out.filter((e) => e.type === "response.output_item.done" && e.item?.type === "function_call");
    expect(done).toHaveLength(2);
    expect(done.map((e) => e.item.name).sort()).toEqual(["get_time", "get_weather"]);
    for (const e of done) expect(() => JSON.parse(e.item.arguments)).not.toThrow();
  });

  it("carries BOTH calls in response.completed output", () => {
    const out = collect(hostileDeltas());
    const completed = out.find((e) => e.type === "response.completed");
    const fns = (completed?.response?.output || []).filter((i) => i.type === "function_call");
    expect(fns).toHaveLength(2);
    expect(fns.map((f) => f.name).sort()).toEqual(["get_time", "get_weather"]);
    expect(JSON.parse(fns.find((f) => f.name === "get_weather").arguments)).toEqual({ city: "Beijing" });
    expect(JSON.parse(fns.find((f) => f.name === "get_time").arguments)).toEqual({ zone: "UTC" });
  });

  it("a legal single call still produces exactly one function_call item", () => {
    const out = collect(legalDeltas());
    const done = out.filter((e) => e.type === "response.output_item.done" && e.item?.type === "function_call");
    expect(done).toHaveLength(1);
    expect(JSON.parse(done[0].item.arguments)).toEqual({ city: "Beijing" });
  });
});

describe("chat → Claude translation keeps parallel tool_use blocks apart", () => {
  const collect = (deltas) => {
    const state = initState(FORMATS.CLAUDE);
    const out = [];
    for (const tc of deltas) {
      const c = chunk(tc);
      repairToolCallIndices(state, c);
      for (const r of translateResponse(FORMATS.OPENAI, FORMATS.CLAUDE, c, state)) out.push(r);
    }
    const fin = { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] };
    for (const r of translateResponse(FORMATS.OPENAI, FORMATS.CLAUDE, fin, state)) out.push(r);
    for (const r of translateResponse(FORMATS.OPENAI, FORMATS.CLAUDE, null, state)) out.push(r);
    return out.filter(Boolean);
  };

  it("emits two tool_use blocks with parseable inputs", () => {
    const out = collect(hostileDeltas());
    const starts = out.filter((e) => e.type === "content_block_start" && e.content_block?.type === "tool_use");
    expect(starts).toHaveLength(2);
    expect(starts.map((s) => s.content_block.name).sort()).toEqual(["get_time", "get_weather"]);
    const partials = out.filter((e) => e.delta?.type === "input_json_delta");
    expect(partials).toHaveLength(2);
    const bodies = partials.map((p) => JSON.parse(p.delta.partial_json));
    expect(bodies).toEqual(expect.arrayContaining([{ city: "Beijing" }, { zone: "UTC" }]));
  });

  it("a legal single call still produces one tool_use block", () => {
    const out = collect(legalDeltas());
    const starts = out.filter((e) => e.type === "content_block_start" && e.content_block?.type === "tool_use");
    expect(starts).toHaveLength(1);
    expect(starts[0].content_block.name).toBe("get_weather");
  });
});

describe("chat → Antigravity/Gemini translation keeps parallel functionCall parts apart", () => {
  it("emits two functionCall parts with distinct args", () => {
    const state = initState(FORMATS.ANTIGRAVITY);
    const out = [];
    for (const tc of hostileDeltas()) {
      const c = chunk(tc);
      repairToolCallIndices(state, c);
      for (const r of translateResponse(FORMATS.OPENAI, FORMATS.ANTIGRAVITY, c, state)) out.push(r);
    }
    const fin = { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] };
    for (const r of translateResponse(FORMATS.OPENAI, FORMATS.ANTIGRAVITY, fin, state)) out.push(r);

    const parts = out.filter(Boolean).flatMap((r) => {
      const payload = r?.response || r;
      return payload?.candidates?.[0]?.content?.parts || [];
    });
    const fns = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    expect(fns).toHaveLength(2);
    expect(fns.map((f) => f.name).sort()).toEqual(["get_time", "get_weather"]);
    expect(fns.find((f) => f.name === "get_weather").args).toEqual({ city: "Beijing" });
    expect(fns.find((f) => f.name === "get_time").args).toEqual({ zone: "UTC" });
  });
});

describe("translate lane repairs indices before the translator sees them", () => {
  it("chat→Claude through the real transform stream splits the calls", async () => {
    const out = await runStream(
      sseOf(hostileDeltas()),
      createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.CLAUDE, "qwc", null, null, "qwen4-max"),
    );
    const events = parseOut(out);
    const starts = events.filter((e) => e.type === "content_block_start" && e.content_block?.type === "tool_use");
    expect(starts).toHaveLength(2);
    expect(starts.map((s) => s.content_block.name).sort()).toEqual(["get_time", "get_weather"]);
  });

  it("chat→Responses through the real transform stream splits the calls", async () => {
    const out = await runStream(
      sseOf(hostileDeltas()),
      createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, "qwc", null, null, "qwen4-max"),
    );
    const events = parseOut(out);
    const done = events.filter((e) => e.type === "response.output_item.done" && e.item?.type === "function_call");
    expect(done).toHaveLength(2);
    expect(new Set(done.map((e) => e.output_index)).size).toBe(2);
  });
});