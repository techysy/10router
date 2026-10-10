// #46 — the per-model cooldown rule used to be hand-rolled in three places
// (providerCardOrder.js, ConnectionRow.js, ConnectionsCard.js) and each copy
// filtered lock expiry differently, so the countdown chip could display a lock
// that had already lapsed while the badge said the account was fine.
//
// The three consumers are now one line each over
// src/shared/utils/connectionCooldown.js, which IS unit-tested for real
// (unit/connection-cooldown.test.js). The two components cannot be: they are
// React .js files with JSX and tests/vitest.config.js runs environment "node"
// with no JSX transform, so importing them throws. Per the repo convention
// (see tests/unit/disabled-models-ux.test.js:9) these are guarded by
// source-text assertions — which is the ONLY thing that can catch the two
// component copies drifting apart, since no import-based test can reach them.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const rootDir = resolve(__dirname, "../..");
const read = (rel) => readFileSync(resolve(rootDir, rel), "utf8");

const CONNECTION_ROW = "src/app/(dashboard)/dashboard/providers/[id]/ConnectionRow.js";
const CONNECTIONS_CARD = "src/app/(dashboard)/dashboard/providers/components/ConnectionsCard.js";

describe("model-lock cooldown is decided in one place (#46)", () => {
  for (const rel of [CONNECTION_ROW, CONNECTIONS_CARD]) {
    it(`${rel} delegates to classifyConnectionCooldown`, () => {
      const src = read(rel);
      expect(src).toMatch(/import \{ classifyConnectionCooldown, sameConnectionCooldown \} from "@\/shared\/utils\/connectionCooldown"/);
      // Lazy useState init (first-paint correctness) + bail-out tick
      expect(src).toContain("useState(() => classifyConnectionCooldown(connection))");
      expect(src).toContain("sameConnectionCooldown(prev, next) ? prev : next");
    });

    it(`${rel} no longer re-derives lock expiry inline`, () => {
      const src = read(rel);
      // The old copies filtered modelLock_* and compared against Date.now()
      // themselves. Any surviving copy is a second source of truth — the exact
      // thing that let the chip and the badge disagree.
      expect(src).not.toMatch(/Object\.entries\(connection\)[\s\S]{0,200}modelLock_/);
    });
  }

  it("providerCardOrder delegates instead of hand-rolling the rule", () => {
    const src = read("src/shared/utils/providerCardOrder.js");
    expect(src).toContain("classifyConnectionCooldown");
    expect(src).not.toMatch(/startsWith\("modelLock_"\)/);
  });

  // The usage page's per-connection pill was a FOURTH site and the worst face
  // of the bug: it read conn.testStatus raw, with no cooldown awareness at all,
  // so one model's 429 kept it red for the entire lock window.
  it("the usage page's connection pill classifies instead of reading testStatus raw", () => {
    const rel = "src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js";
    const src = read(rel);
    expect(src).toContain("classifyConnectionCooldown");
    expect(src).toContain('connState === "partial"');
    // The red/green decision must not go through the raw flag again.
    expect(src).not.toMatch(/conn\.testStatus === "unavailable"/);
  });

  // P2-11: same label requirement on the usage page's per-connection pill —
  // it was a fourth site in #46 and it renders connState raw for unknown
  // states, so "needs-reauth" needs its own branch there too.
  it("the usage page's pill labels and reddens 'needs-reauth'", () => {
    const src = read("src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js");
    expect(src).toContain('connState === "needs-reauth"');
    expect(src).toContain('translate("Needs re-auth")');
  });

  it("the cooldown countdown only renders for a live lock", () => {
    // isCooldown must come from the classified state, not from a separately
    // recomputed boolean that could disagree with it.
    for (const rel of [CONNECTION_ROW, CONNECTIONS_CARD]) {
      const src = read(rel);
      expect(src).toMatch(/const isCooldown = effectiveStatus === "partial" \|\| effectiveStatus === "unavailable";/);
    }
  });

  it("both rows label the new 'partial' state in words, not the raw token", () => {
    for (const rel of [CONNECTION_ROW, CONNECTIONS_CARD]) {
      const src = read(rel);
      expect(src).toContain('effectiveStatus === "partial" ? translate("Partial")');
    }
  });

  // P2-11: "needs-reauth" would otherwise render as the raw token — the one
  // state that needs a human action must read like an instruction. Both copies
  // carry the same ternary chain (pin the chain, not just the presence of the
  // string, so one copy cannot grow the branch while the other lags).
  it("both rows label the 'needs-reauth' state, in the same ternary chain as 'partial'", () => {
    for (const rel of [CONNECTION_ROW, CONNECTIONS_CARD]) {
      const src = read(rel);
      expect(src).toContain('effectiveStatus === "needs-reauth"');
      expect(src).toContain('translate("Needs re-auth")');
      expect(src).toMatch(
        /effectiveStatus === "needs-reauth"[\s\S]{0,80}translate\("Needs re-auth"\)[\s\S]{0,80}effectiveStatus === "partial" \? translate\("Partial"\)/
      );
    }
  });
});

describe("the two connection rows agree on how errors read (#46)", () => {
  it("ConnectionsCard routes lastError through translateQuotaError", () => {
    // It used to render the raw upstream JSON (up to 500 chars, stored
    // verbatim) into a 300px red span, so one connection showed a friendly
    // sentence on the provider page and a wall of JSON on the media page.
    const src = read(CONNECTIONS_CARD);
    expect(src).toContain("translateQuotaError(connection.lastError)");
    expect(src).not.toMatch(/title=\{connection\.lastError\}/);
  });

  it("ConnectionRow keeps its existing translation of lastError", () => {
    const src = read(CONNECTION_ROW);
    expect(src).toContain("translateQuotaError(connection.lastError)");
  });
});

describe("getStatusVariant can express 'partial' (#46)", () => {
  it("maps partial to the warning variant, and warning exists on Badge", () => {
    // Guarded here as well as in unit/connection-status-variant.test.js: that
    // file proves the mapping, this one proves the variant is actually
    // renderable, so a Badge rewrite cannot silently break the amber state.
    const badge = read("src/shared/components/Badge.js");
    expect(badge).toMatch(/warning:\s*"[^"]*yellow[^"]*"/);
  });
});
