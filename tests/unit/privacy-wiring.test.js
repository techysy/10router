// Privacy pipeline phase 2 — mainline wiring (issue #90).
//
// Pins the three invariants the phase 2 review called out:
//   1. per-attempt redaction on a DEEP COPY (retry on a trusted channel must
//      never receive placeholders minted for a failed untrusted one);
//   2. the structured-chunk restorer rides every streaming output layer
//      (translate + passthrough) BEFORE serialization, with per-field windows;
//   3. both non-streaming exits reverse the mapping before the client sees it.
// Plus behavioral tests for createChunkRestorer and the opt-in switch.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import {
  privacyEnabledFor,
  createRedactionContext,
  scanBody,
  createChunkRestorer,
  restoreBody,
} from "../../open-sse/privacy/index.js";

const SALT = "wiring-test-salt";
const SECRET = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const read = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

function ctx() {
  return createRedactionContext({ salt: SALT });
}

describe("privacyEnabledFor — explicit opt-in only (zero upgrade behavior change)", () => {
  it.each([
    ["no credentials", null, false],
    ["no privacy block", { providerSpecificData: {} }, false],
    ["privacy: true", { providerSpecificData: { privacy: true } }, true],
    ["privacy: {enabled:true}", { providerSpecificData: { privacy: { enabled: true } } }, true],
    ["privacy: {enabled:false}", { providerSpecificData: { privacy: { enabled: false } } }, false],
    ["privacy: {}", { providerSpecificData: { privacy: {} } }, false],
  ])("%s → %j", (_label, credentials, expected) => {
    expect(privacyEnabledFor(credentials)).toBe(expected);
  });
});

describe("createChunkRestorer — per-field sliding windows over structured chunks", () => {
  const scanned = ctx();
  scanBody({ messages: [{ role: "user", content: `key ${SECRET}` }] }, scanned);
  const { map } = scanned;

  it("reassembles a placeholder split across three content deltas (openai shape)", () => {
    const r = createChunkRestorer(map);
    const ph = [...map.keys()][0];
    const mid = Math.floor(ph.length / 3);
    const chunks = [
      { choices: [{ delta: { content: "your key: " } }] },
      { choices: [{ delta: { content: ph.slice(0, mid) } }] },
      { choices: [{ delta: { content: ph.slice(mid) } }] },
    ];
    let out = "";
    for (const c of chunks) {
      r.restoreChunk(c);
      out += c.choices[0].delta.content;
    }
    expect(out).toBe(`your key: ${SECRET}`);
    expect(out).not.toContain("__SEC_");
  });

  it("content and tool-call arguments are independent windows (no cross-stream pollution)", () => {
    const r = createChunkRestorer(map);
    const ph = [...map.keys()][0];
    // BOTH streams carry the same placeholder, each split across its own two
    // chunks — the windows must not feed each other's state.
    const c1 = { choices: [{ delta: { content: ph.slice(0, 8), tool_calls: [{ index: 0, function: { arguments: `{"k":"${ph.slice(0, 10)}` } }] } }] };
    const c2 = { choices: [{ delta: { content: ph.slice(8), tool_calls: [{ index: 0, function: { arguments: `${ph.slice(10)}"}` } }] } }] };
    r.restoreChunk(c1);
    r.restoreChunk(c2);
    // content stream: first half held, second half completes → full secret
    expect(c1.choices[0].delta.content + c2.choices[0].delta.content).toBe(SECRET);
    // arguments stream (its own window): JSON reassembles with the secret inside
    expect(c1.choices[0].delta.tool_calls[0].function.arguments + c2.choices[0].delta.tool_calls[0].function.arguments).toBe(`{"k":"${SECRET}"}`);
  });

  it("non-payload fields (id, model, finish_reason) are never touched or held", () => {
    const r = createChunkRestorer(map);
    const chunk = { id: "chatcmpl-trailing_underscore_", model: "gpt-x_", choices: [{ delta: {}, finish_reason: null }] };
    expect(r.restoreChunk(chunk)).toBe(false);
    expect(chunk.id).toBe("chatcmpl-trailing_underscore_");
    expect(chunk.model).toBe("gpt-x_");
  });

  it("thinking / delta / text fields ride their own windows (claude + responses shapes)", () => {
    const r = createChunkRestorer(map);
    const ph = [...map.keys()][0];
    const claude = { delta: { type: "text_delta", text: ph.slice(0, 10) } };
    const claude2 = { delta: { type: "text_delta", text: ph.slice(10) } };
    r.restoreChunk(claude);
    r.restoreChunk(claude2);
    expect(claude.delta.text + claude2.delta.text).toBe(SECRET);

    const responses = { type: "response.output_text.delta", delta: ph };
    r.restoreChunk(responses);
    expect(responses.delta).toBe(SECRET);
  });

  it("a stream ending mid-placeholder accounts for the held fragment via flushLost", () => {
    const r = createChunkRestorer(map);
    const ph = [...map.keys()][0];
    const chunk = { choices: [{ delta: { content: `ends with ${ph.slice(0, 9)}` } }] };
    r.restoreChunk(chunk);
    // the viable partial tail was held, not emitted
    expect(chunk.choices[0].delta.content.endsWith(ph.slice(0, 2))).toBe(false);
    const lost = r.flushLost();
    expect(lost.length).toBeGreaterThan(0);
    expect(lost.length).toBeLessThanOrEqual(24);
    expect(lost + "rest").not.toContain(SECRET); // inert either way
  });

  it("fail-open: garbage chunks return false and never throw", () => {
    const r = createChunkRestorer(map);
    expect(r.restoreChunk(null)).toBe(false);
    expect(r.restoreChunk("str")).toBe(false);
    expect(createChunkRestorer(new Map()).restoreChunk({ choices: [{ delta: { content: "x__SEC_" } }] })).toBe(false);
  });
});

describe("round-trip: outbound scan → model echo → chunked restore → client", () => {
  it("client never sees a placeholder when the model echoes it in any fragmentation", () => {
    const c = ctx();
    const body = { messages: [{ role: "user", content: `use ${SECRET} in the test` }] };
    scanBody(body, c);
    const ph = [...c.map.keys()][0];

    // model "responds" with the placeholder, upstream tokenizer splits it
    const responseText = `sure, using ${ph} as the API key.`;
    const r = createChunkRestorer(c.map);
    let clientText = "";
    for (let at = 0; at < responseText.length; at += 3) {
      const chunk = { choices: [{ delta: { content: responseText.slice(at, at + 3) } }] };
      r.restoreChunk(chunk);
      clientText += chunk.choices[0].delta.content;
    }
    expect(clientText).toBe(`sure, using ${SECRET} as the API key.`);
    // whole-body restore agrees
    expect(restoreBody({ content: responseText }, c.map).content).toBe(`sure, using ${SECRET} as the API key.`);
  });
});

describe("mainline wiring pins (mount points and ordering)", () => {
  const chatCore = read("open-sse/handlers/chatCore.js");

  it("outbound scan mounts after account selection, before translation, on a deep copy", () => {
    const mount = chatCore.slice(chatCore.indexOf("// ── Privacy redaction"), chatCore.indexOf("let translatedBody"));
    expect(mount).toBeTruthy();
    expect(mount).toContain("privacyEnabledFor(credentials)");
    expect(mount).toContain("structuredClone(body)");
    expect(mount).toContain("createChunkRestorer(privacyCtx.map)");
    // fail-open: the whole mount is inside a try that nulls the ctx
    expect(mount).toContain("} catch (e) {");
    expect(mount).toContain("privacyCtx = null");
  });

  it("per-attempt semantics: the request-line metric and sharedCtx carry the ctx", () => {
    expect(chatCore).toContain("parts.push(`PRIV:${privacyCtx.stats.redacted}`)");
    expect(chatCore).toContain("reqTag, log, privacyCtx }");
  });

  it("stream.js translate layer restores structured chunks BEFORE formatSSE serializes", () => {
    const s = read("open-sse/utils/stream.js");
    const loop = s.slice(s.indexOf("for (const item of translated)"), s.indexOf("flush(controller)"));
    expect(loop.indexOf("privacyCtx?.chunkRestorer) privacyCtx.chunkRestorer.restoreChunk(item)")).toBeGreaterThan(-1);
    expect(loop.indexOf("formatSSE(item, sourceFormat)")).toBeGreaterThan(loop.indexOf("restoreChunk(item)"));
  });

  it("stream.js passthrough layer restores parsed chunks and re-serializes on change", () => {
    const s = read("open-sse/utils/stream.js");
    const passthrough = s.slice(s.indexOf("mode === STREAM_MODE.PASSTHROUGH) {"), s.indexOf("// Translate mode"));
    const at = passthrough.indexOf("restoreChunk(parsed)");
    expect(at).toBeGreaterThan(-1);
    // the very next statement forces re-serialization (the raw line still
    // carries the placeholder text the window just replaced)
    expect(passthrough.slice(at, at + 140)).toContain("fieldsInjected = true");
  });

  it("stream finish accounts for held placeholder fragments (restoreLost)", () => {
    const s = read("open-sse/utils/stream.js");
    expect(s).toContain("privacyCtx.chunkRestorer.flushLost()");
    expect(s).toContain("restoreLost");
    const sh = read("open-sse/handlers/chatCore/streamingHandler.js");
    expect(sh).toContain("contentObj?.restoreLost ? { restoreLost: contentObj.restoreLost } : {}");
  });

  it("streaming handler forwards privacyCtx into both stream factories", () => {
    const sh = read("open-sse/handlers/chatCore/streamingHandler.js");
    expect(sh).toContain("createSSETransformStreamWithLogger(FORMATS.OPENAI_RESPONSES, codexTarget, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, customToolNames, privacyCtx)");
    expect(sh).toContain("createPassthroughStreamWithLogger(provider, reqLogger, model, connectionId, body, onStreamComplete, apiKey, privacyCtx)");
  });

  it("both non-streaming exits reverse the mapping before restoreToolNames", () => {
    const nsh = read("open-sse/handlers/chatCore/nonStreamingHandler.js");
    expect(nsh).toContain("restoreBody(translatedResponse, privacyCtx.map)");
    expect(nsh.indexOf("restoreBody(translatedResponse")).toBeLessThan(nsh.indexOf("restoreToolNames(translatedResponse"));
    const sj = read("open-sse/handlers/chatCore/sseToJsonHandler.js");
    expect(sj.match(/restorePrivacy\(/g).length).toBeGreaterThanOrEqual(3); // 3 exits (helper is a `= (obj) =>` decl)
    expect(sj).toContain('from "../../privacy/streamRestorer.js"');
  });
});
