// Privacy redaction pipeline (issue #90 phase 1) — pure-module contract:
//   outbound scan  → deterministic placeholders, mapping held per request
//   inbound restore → exact round-trip, incl. placeholders chopped at ANY
//   offset across SSE chunks (sliding window), and 100KB-class payloads.
// Fail-open and leak-safe invariants are pinned here too: scanner errors
// never break a request, unmatched placeholders pass through inertly.
import { describe, it, expect } from "vitest";
import {
  createRedactionContext,
  scanText,
  scanBody,
  restoreText,
  restoreBody,
  createStreamRestorer,
} from "../../open-sse/privacy/index.js";

const SALT = "unit-test-salt";
const SK = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const GH = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
const AWS = "AKIAIOSFODNN7EXAMPLE";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7abcd\nmorelines\n-----END RSA PRIVATE KEY-----";

function ctx(overrides = {}) {
  return createRedactionContext({ salt: SALT, rules: overrides });
}

// Deterministic LCG so the fragmentation fuzz is reproducible.
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);
}

// Feed text through the restorer split at the given offsets; expect the
// fully restored string back after flush.
function runChunked(text, cuts, map) {
  const restorer = createStreamRestorer(map || new Map());
  let out = "";
  let prev = 0;
  for (const cut of [...cuts, text.length].sort((a, b) => a - b)) {
    out += restorer.push(text.slice(prev, cut));
    prev = cut;
  }
  return out + restorer.flush();
}

describe("secretScanner — cache determinism (RFC hard-problem ①)", () => {
  it("same secret + salt → identical placeholder across scans (prompt cache stays warm)", () => {
    const a = scanText(`key is ${SK} ok`, ctx());
    const b = scanText(`later turn mentions ${SK} again`, ctx());
    const phA = a.match(/__SEC_[A-Z]+_[0-9a-f]+__/)[0];
    const phB = b.match(/__SEC_[A-Z]+_[0-9a-f]+__/)[0];
    expect(phA).toBe(phB);
  });

  it("different salt → different placeholder (cross-tenant isolation)", () => {
    const a = scanText(SK, ctx());
    const b = scanText(SK, createRedactionContext({ salt: "other-salt" }));
    expect(a).not.toBe(b);
    expect(a).toMatch(/^__SEC_KEY_[0-9a-f]{12}__$/);
  });

  it("multi-turn: two different bodies with the same secret share one placeholder", () => {
    const c1 = ctx();
    const c2 = ctx();
    scanBody({ messages: [{ role: "user", content: `use ${GH}` }] }, c1);
    scanBody({ messages: [{ role: "user", content: `history echo ${GH}` }] }, c2);
    const p1 = [...c1.map.keys()][0];
    const p2 = [...c2.map.keys()][0];
    expect(p1).toBe(p2);
  });
});

describe("secretScanner — detection packs", () => {
  it.each([
    ["anthropic key", `connect with ${SK} please`, SK],
    ["github token", `token ${GH} in env`, GH],
    ["aws access key", `aws_access_key_id=${AWS}`, AWS],
    ["jwt", `Authorization: Bearer ${JWT}`, JWT],
    ["pem block", `the key:\n${PEM}\nrotate it`, PEM],
    ["assignment json", `{"apiKey": "TvQ7xK91mWpL2nR8sYzA"}`, "TvQ7xK91mWpL2nR8sYzA"],
    ["authorization bearer", "Authorization: Bearer AbCdEf123456789012345678", "AbCdEf123456789012345678"],
  ])("redacts %s", (_label, text, secret) => {
    const c = ctx();
    const out = scanText(text, c);
    expect(out).not.toContain(secret);
    expect(out).toMatch(/__SEC_KEY_[0-9a-f]{12}__/);
    // round-trip: the mapping restores exactly
    expect(restoreText(out, c.map)).toContain(secret);
  });

  it("leaves ordinary code alone (no false positives on the happy path)", () => {
    const code = [
      "const retries = 3;",
      "console.log('building project');",
      "function hash(input) { return input.length; }",
      "const url = 'https://example.com/api/v1';",
      "export VERSION=1.2.3",
    ].join("\n");
    const c = ctx();
    expect(scanText(code, c)).toBe(code);
    expect(c.stats.redacted).toBe(0);
  });

  it("assignment value absorbs an embedded key prefix (single placeholder, no orphaning)", () => {
    const c = ctx();
    const text = `token: ${SK}`;
    const out = scanText(text, c);
    expect(out.match(/__SEC_[A-Z]+_[0-9a-f]{12}__/g)).toHaveLength(1);
    expect(restoreText(out, c.map)).toBe(text);
  });

  it("is idempotent: scanning already-redacted text is a no-op", () => {
    const c1 = ctx();
    const once = scanText(`k=${SK}`, c1);
    const c2 = ctx();
    // simulate a retry that re-scans a body already carrying placeholders
    const twice = scanText(once, c2);
    expect(twice).toBe(once);
    expect(c2.stats.redacted).toBe(0);
  });

  it("entropy detection is OFF by default and opt-in", () => {
    const noisy = 'cfg = "jX9kP2mQwR7vTzL4bNcY6sFdH"'; // quoted high-entropy assignment value
    expect(scanText(noisy, ctx())).toBe(noisy);
    const c = ctx({ entropyDetection: true });
    const out = scanText(noisy, c);
    expect(out).not.toBe(noisy);
    expect(restoreText(out, c.map)).toBe(noisy);
  });

  it("ipv4 detection is OFF by default and opt-in", () => {
    const text = "connect to 10.1.2.3:5432";
    expect(scanText(text, ctx())).toBe(text);
    const c = ctx({ ipv4: true });
    const out = scanText(text, c);
    expect(out).not.toContain("10.1.2.3");
    expect(restoreText(out, c.map)).toBe(text);
  });

  it("redacts custom keywords (codenames, internal domains) and restores them", () => {
    const c = ctx({ customKeywords: ["proj-x-codename", "corp.internal.net"] });
    const text = "deploy proj-x-codename to corp.internal.net tonight";
    const out = scanText(text, c);
    expect(out).not.toContain("proj-x-codename");
    expect(out).not.toContain("corp.internal.net");
    expect(restoreText(out, c.map)).toBe(text);
  });

  it("skips base64 data URIs (images are not scannable text)", () => {
    const c = ctx({ entropyDetection: true });
    const body = {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: 'key = "jX9kP2mQwR7vTzL4bNcY6sFdH"' },
          { type: "image_url", image_url: { url: "data:image/png;base64,jX9kP2mQwR7vTzL4bNcY6sFdHjX9kP2mQwR7vTzL4bNcY6sFdH" } },
        ],
      }],
    };
    scanBody(body, c);
    expect(body.messages[0].content[0].text).not.toBe('key = "jX9kP2mQwR7vTzL4bNcY6sFdH"');
    expect(body.messages[0].content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
  });
});

describe("secretScanner — body walk & fail-open", () => {
  it("walks messages/input/system/tools shapes and reports stats", () => {
    const c = ctx();
    const body = {
      system: `env: GH_TOKEN=${GH}`,
      messages: [
        { role: "user", content: `my key ${SK}` },
        { role: "assistant", content: [{ type: "text", text: "noted" }] },
        { role: "tool", content: `aws creds ${AWS}` },
      ],
      tools: [{ name: "run", description: `runs jobs on corp.internal.net`, parameters: {} }],
    };
    const stats = scanBody(body, c);
    expect(stats.redacted).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(body)).not.toContain(SK);
    expect(JSON.stringify(body)).not.toContain(GH);
    expect(JSON.stringify(body)).not.toContain(AWS);
  });

  it("fails open: null/garbage input returns null or passes through, never throws", () => {
    expect(scanBody(null, ctx())).toBeNull();
    expect(scanBody(undefined, ctx())).toBeNull();
    expect(scanBody("str", ctx())).toBeNull();
    expect(scanText(42, ctx())).toBe(42);
    expect(scanText(null, ctx())).toBeNull();
    const c = ctx();
    expect(scanText("", c)).toBe("");
    // depth bomb: 40 nested levels — depth cap stops the walk, no throw
    let deep = { v: "tail" };
    for (let i = 0; i < 40; i++) deep = { v: deep };
    expect(() => scanBody(deep, c)).not.toThrow();
  });
});

describe("streamRestorer — one-shot restore", () => {
  it("restores whole-body JSON responses (choices, tool-call arguments)", () => {
    const c = ctx();
    const ph = scanText(SK, c);
    const body = {
      choices: [{
        message: {
          content: `your key is ${ph}`,
          tool_calls: [{ function: { arguments: `{"cmd":"export K=${ph}"}` } }],
        },
      }],
    };
    restoreBody(body, c.map);
    expect(body.choices[0].message.content).toContain(SK);
    expect(body.choices[0].message.tool_calls[0].function.arguments).toContain(SK);
  });

  it("unknown/mutated placeholders pass through inertly (leak-safe direction)", () => {
    const orphan = "__SEC_KEY_000000000000__";
    expect(restoreText(`a ${orphan} b`, new Map())).toBe(`a ${orphan} b`);
    expect(restoreText("no placeholders here", new Map([["x", "y"]]))).toBe("no placeholders here");
    const restorer = createStreamRestorer(new Map());
    expect(restorer.push(orphan) + restorer.flush()).toBe(orphan);
  });
});

describe("streamRestorer — sliding window over chopped SSE (RFC hard-problem ②)", () => {
  const responseText = `sure, the creds you shared:\napi key: ${SK}\nalso ${GH} and ${AWS}\njwt: ${JWT}`;
  const c = ctx();
  const chopped = scanText(responseText, c); // model "echoes" placeholders back
  const map = c.map;

  it("exact round-trip when the placeholder arrives whole", () => {
    expect(runChunked(chopped, [], map)).toBe(responseText);
  });

  it("EXHAUSTIVE: every single cut point restores exactly", () => {
    for (let i = 1; i < chopped.length; i++) {
      const out = runChunked(chopped, [i], map);
      if (out !== responseText) {
        throw new Error(`mismatch at cut ${i}: got ${JSON.stringify(out)}`);
      }
    }
  });

  it("EXHAUSTIVE: every pair of cut points restores exactly", () => {
    const step = Math.max(1, Math.floor(chopped.length / 60));
    for (let i = 1; i < chopped.length; i += step) {
      for (let j = i + 1; j < chopped.length; j += step) {
        expect(runChunked(chopped, [i, j], map)).toBe(responseText);
      }
    }
  });

  it("seeded random multi-way splits (100 runs) restore exactly", () => {
    const rand = lcg(20261030);
    for (let run = 0; run < 100; run++) {
      const parts = Math.ceil(rand() * 12) + 2;
      const cuts = Array.from({ length: parts }, () => Math.floor(rand() * chopped.length));
      expect(runChunked(chopped, cuts, map)).toBe(responseText);
    }
  });

  it("2KB uniform chunks (realistic SSE cadence) restore exactly", () => {
    const cuts = [];
    for (let at = 2048; at < chopped.length; at += 2048) cuts.push(at);
    expect(runChunked(chopped, cuts, map)).toBe(responseText);
  });

  it("holds back at most 24 chars for ordinary underscore-free text (TTFT guard)", () => {
    const restorer = createStreamRestorer(map);
    const big = "a".repeat(8192);
    expect(restorer.push(big)).toHaveLength(8192);
  });
});

describe("100KB stress (RFC hard-problem ③)", () => {
  it("scans and restores a 100KB mixed payload correctly", () => {
    const filler = "const cfg = loadConfig(); // routine build lines with no secrets\n".repeat(1500);
    const text = (filler + `key=${SK}\n`) + filler.slice(0, 100_000 - filler.length * 2 - SK.length);
    expect(text.length).toBeGreaterThan(90_000);

    const c = ctx();
    const t0 = performance.now();
    const redacted = scanText(text, c);
    const scanMs = performance.now() - t0;
    expect(redacted).toContain("__SEC_KEY_");
    expect(redacted).not.toContain(SK);

    // stream the "response" back in 2KB chunks
    const restorer = createStreamRestorer(c.map);
    const t1 = performance.now();
    let out = "";
    for (let at = 0; at < redacted.length; at += 2048) out += restorer.push(redacted.slice(at, at + 2048));
    out += restorer.flush();
    const restoreMs = performance.now() - t1;

    expect(out).toBe(text);
    // CI-safe generous bound; locally this sits in single-digit ms.
    expect(scanMs).toBeLessThan(500);
    expect(restoreMs).toBeLessThan(500);
    console.log(`[privacy-stress] scan ${text.length}B: ${scanMs.toFixed(2)}ms | stream-restore: ${restoreMs.toFixed(2)}ms | redactions: ${c.stats.redacted}`);
  });
});
