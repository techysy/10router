// Split parallel tool calls whose upstream reuses one index (#175).
//
// qwen4-max (qwc/qw) emits every new tool call with `index: 0` — the second call
// arrives with a fresh id AND a fresh function name, but the index never
// advances. Measured on the live gateway 2026-11-27:
//
//   {id:"toolu_8a12…", index:0, function:{name:"get_weather", arguments:""}}
//   {index:0, function:{arguments:"{\"city\": \"Bei"}}      ← fragment of call #1
//   {index:0, function:{arguments:"jing\"}"}}                ← fragment of call #1
//   {id:"toolu_9c34…", index:0, function:{name:"get_time", arguments:""}}  ← call #2
//
// Every accumulator downstream keys on `tc.index ?? 0`, so both calls landed in
// one slot: name "get_weatherget_time", arguments
// `{"city": "Beijing"}{"zone": "UTC"}` — unparseable, and the Responses lane
// emitted two output_item.added at the same output_index, the second silently
// overwriting the first.
//
// The discriminator is the id/name BOUNDARY, not the chunk count. A legitimate
// upstream sends the name once and then bare argument fragments on the same
// index; those must keep merging. So a slot only moves when the chunk positively
// announces a DIFFERENT call:
//   - a new non-empty id that no slot has claimed yet, or
//   - a non-empty name that differs from the name already recorded on that slot.
// An id already seen is a repeat, not a new call (GLM/fireworks re-send id on
// every argument chunk); an empty name is not an announcement at all.
//
// Deliberately NOT a per-chunk counter: that would shatter the legal index=0
// argument fragments every well-behaved upstream sends.
//
// Slot numbering stays DENSE and low (0,1,2,…), deliberately: a client that
// accumulates by array position would otherwise see a huge sparse hole. Two
// rules keep that safe:
//   - a first sighting of a wire index is honoured verbatim, so a well-behaved
//     0,1,2 stream is byte-for-byte untouched;
//   - a slot is only handed out for a repair, and then only the lowest number no
//     call has taken yet. If such a slot collides with a wire index the upstream
//     starts using later, the NEW arrival moves to the next free number instead
//     of rewriting an index already emitted — rewriting one would desynchronize a
//     client that has been accumulating live.

const LEDGER_KEY = "__toolCallIndexLedger";

/** Per-stream bookkeeping, kept under one key so it cannot collide with a translator's own fields. */
function ledger(state) {
  if (!state[LEDGER_KEY]) {
    state[LEDGER_KEY] = {
      // wire index -> slot index downstream should accumulate under
      remap: new Map(),
      // slot index -> { id, name } last announced for that slot
      slots: new Map(),
      // every id claimed this stream, so a repeated id never opens a slot
      claimedIds: new Set(),
      // every slot number already taken by a call (adopted or repaired)
      usedSlots: new Set(),
      repaired: false,
    };
  }
  return state[LEDGER_KEY];
}

/** Lowest slot number no call has taken yet. */
function freeSlot(l) {
  let n = 0;
  while (l.usedSlots.has(n)) n++;
  return n;
}

/**
 * Resolve the accumulator slot for one streaming tool_call delta.
 *
 * Returns the upstream index unchanged in every ordinary case (including a
 * missing index, which still means 0). Only a positively-announced new call on
 * an already-occupied index gets a fresh slot.
 *
 * @param {object} state  per-stream state object (translator state, stream closure, or a local `{}`)
 * @param {object} tc     one entry of choice.delta.tool_calls
 * @returns {number} slot index to accumulate under
 */
export function resolveToolCallIndex(state, tc) {
  const wireIdx = Number.isInteger(tc?.index) ? tc.index : 0;
  if (!state || typeof state !== "object") return wireIdx;

  const l = ledger(state);
  const id = typeof tc?.id === "string" && tc.id ? tc.id : null;
  const name = typeof tc?.function?.name === "string" && tc.function.name ? tc.function.name : null;

  const current = l.remap.get(wireIdx);

  // First chunk on this wire index: adopt it as-is. No repair, no assumptions.
  if (current === undefined) {
    // Except when a repair already handed out this number: that call has been
    // announced to the client under it, so THIS arrival yields and takes the
    // next free slot. Only reachable after a repair (an untouched wire index is
    // never in usedSlots), so ordinary streams stay byte-identical.
    const adopted = l.usedSlots.has(wireIdx) ? freeSlot(l) : wireIdx;
    l.remap.set(wireIdx, adopted);
    l.slots.set(adopted, { id, name });
    l.usedSlots.add(adopted);
    if (adopted !== wireIdx) l.repaired = true;
    if (id) l.claimedIds.add(id);
    return adopted;
  }

  const slot = l.slots.get(current) || { id: null, name: null };
  const newId = id && !l.claimedIds.has(id);
  const renamed = name && slot.name && name !== slot.name;

  // Not a new call — a fragment, or a repeated id/name. Keep merging.
  if (!newId && !renamed) {
    if (id && !slot.id) slot.id = id;
    if (name && !slot.name) slot.name = name;
    if (id) l.claimedIds.add(id);
    l.slots.set(current, slot);
    return current;
  }

  // A different call is being announced on an index already in use. Give it its
  // own slot and point this wire index at it; later fragments (no id, no name)
  // follow the remap and land on the new call.
  const fresh = freeSlot(l);
  l.usedSlots.add(fresh);
  l.remap.set(wireIdx, fresh);
  l.slots.set(fresh, { id, name });
  if (id) l.claimedIds.add(id);
  l.repaired = true;
  return fresh;
}

/**
 * Repair `choice.delta.tool_calls[].index` in place on one parsed upstream
 * chunk. Call this once per chunk, before any accumulator or translator sees it.
 *
 * In place so every downstream consumer — chat JSON aggregation, the Responses
 * translator, Claude/Antigravity/Kiro translation — reads corrected indices from
 * one place instead of each re-deriving them.
 *
 * @returns {boolean} true when at least one index was rewritten
 */
export function repairToolCallIndices(state, chunk) {
  const choices = chunk?.choices;
  if (!Array.isArray(choices)) return false;
  let changed = false;
  for (const choice of choices) {
    const calls = choice?.delta?.tool_calls;
    if (!Array.isArray(calls)) continue;
    for (const tc of calls) {
      if (!tc || typeof tc !== "object") continue;
      const before = Number.isInteger(tc.index) ? tc.index : 0;
      const resolved = resolveToolCallIndex(state, tc);
      if (resolved !== before) {
        tc.index = resolved;
        changed = true;
      } else if (tc.index === undefined && toolCallIndicesWereRepaired(state)) {
        // Materialize a missing index only once a repair has happened on this
        // stream: before that, leave the upstream's spelling alone so ordinary
        // streams stay byte-identical.
        tc.index = resolved;
      }
    }
  }
  return changed;
}

/** True when this stream needed at least one index repair (for logging/tests). */
export function toolCallIndicesWereRepaired(state) {
  return state?.[LEDGER_KEY]?.repaired === true;
}