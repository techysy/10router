// classifyConnectionCooldown is the single source of truth for #46's
// partial-vs-total question, and it lives in a pure module precisely so it can
// be tested for real — the JSX components that consume it cannot be imported
// under tests/vitest.config.js (environment: "node", no JSX transform), so
// their coverage is necessarily source-text only. The logic itself is pinned
// here instead.
import { describe, it, expect } from "vitest";
import { classifyConnectionCooldown } from "@/shared/utils/connectionCooldown.js";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const at = (ms) => new Date(NOW + ms).toISOString();

describe("classifyConnectionCooldown", () => {
  it("reports a connection with no locks as active", () => {
    const out = classifyConnectionCooldown({ testStatus: "active" }, NOW);
    expect(out.state).toBe("active");
    expect(out.lockedModels).toEqual([]);
    expect(out.accountLocked).toBe(false);
    expect(out.earliestUntil).toBeNull();
  });

  it("treats an expired model lock as recovered (issue #46's core case)", () => {
    // A stale lock must never keep a row red. This is the regression the
    // reporter hit: the account looked dead while it had long since recovered.
    const out = classifyConnectionCooldown(
      { testStatus: "unavailable", modelLock_gemini: at(-1000) },
      NOW,
    );
    expect(out.state).toBe("active");
    expect(out.lockedModels).toEqual([]);
  });

  it("reports a live per-model lock as partial, not unavailable", () => {
    const out = classifyConnectionCooldown(
      { testStatus: "unavailable", modelLock_gemini: at(60_000) },
      NOW,
    );
    // The point of #46: siblings on this connection still serve traffic.
    expect(out.state).toBe("partial");
    expect(out.lockedModels).toEqual(["gemini"]);
    expect(out.accountLocked).toBe(false);
  });

  it("keeps the model name in lockedModels (the row needs to show WHICH model)", () => {
    const out = classifyConnectionCooldown(
      { modelLock_claude: at(60_000), modelLock_gemini: at(120_000) },
      NOW,
    );
    expect(out.state).toBe("partial");
    expect(out.lockedModels.sort()).toEqual(["claude", "gemini"]);
  });

  it("reports a live account-wide lock as unavailable", () => {
    const out = classifyConnectionCooldown(
      { testStatus: "unavailable", modelLock___all: at(60_000) },
      NOW,
    );
    expect(out.state).toBe("unavailable");
    expect(out.accountLocked).toBe(true);
    // The account-wide lock is not a model; it must not be listed as one.
    expect(out.lockedModels).toEqual([]);
  });

  it("lets an account-wide lock outrank a simultaneous per-model lock", () => {
    const out = classifyConnectionCooldown(
      { modelLock___all: at(60_000), modelLock_gemini: at(60_000) },
      NOW,
    );
    expect(out.state).toBe("unavailable");
    expect(out.accountLocked).toBe(true);
    expect(out.lockedModels).toEqual(["gemini"]); // still reported, just not dominant
  });

  it("reports a stale account flag with no live lock as recovered (active)", () => {
    // The lazily-cleared account-level flag with nothing left locked means the
    // account recovered — this is the reading all three previous call sites
    // relied on, and folding it in is why the expired-lock case above is safe.
    const out = classifyConnectionCooldown({ testStatus: "unavailable" }, NOW);
    expect(out.state).toBe("active");
    expect(out.lockedModels).toEqual([]);
  });

  describe("earliestUntil", () => {
    it("skips expired locks and returns the soonest LIVE one", () => {
      // Regression guard for the raw-vs-filtered split the two JSX copies had:
      // one of them sorted lock strings with no expiry check, so the countdown
      // chip could display a lock that had already lapsed.
      const out = classifyConnectionCooldown(
        { modelLock_a: at(-60_000), modelLock_b: at(120_000), modelLock_c: at(300_000) },
        NOW,
      );
      expect(out.earliestUntil).toBe(at(120_000));
    });

    it("returns null when every lock has expired", () => {
      const out = classifyConnectionCooldown({ modelLock_a: at(-1) }, NOW);
      expect(out.earliestUntil).toBeNull();
    });
  });

  it("ignores empty, null and unparseable lock values instead of throwing", () => {
    for (const bad of [null, "", "not-a-date", undefined]) {
      const out = classifyConnectionCooldown({ modelLock_a: bad }, NOW);
      expect(out.state).toBe("active");
      expect(out.earliestUntil).toBeNull();
    }
  });

  it("tolerates a missing or empty connection", () => {
    for (const empty of [null, undefined, {}]) {
      expect(classifyConnectionCooldown(empty, NOW).state).toBe("active");
    }
  });

  it("preserves non-error statuses untouched (only 'unavailable' is re-read)", () => {
    // A connection whose credentials genuinely failed keeps its own status —
    // this helper is about cooldown scope, not about re-deciding auth failures.
    expect(classifyConnectionCooldown({ testStatus: "error" }, NOW).state).toBe("error");
    expect(classifyConnectionCooldown({ testStatus: "unknown" }, NOW).state).toBe("unknown");
  });

  it("a genuine credential failure outranks a live model lock", () => {
    // Code-review finding on the #46 fix: "partial" must not mask a real
    // auth failure. testStatus "error" is written by credential-test flows;
    // a stale live lock from an earlier 429 must not soften it into an amber
    // partial (which computeConnectionStats counts as CONNECTED).
    expect(
      classifyConnectionCooldown({ testStatus: "error", modelLock_gpt: at(60_000) }, NOW).state,
    ).toBe("error");
    expect(
      classifyConnectionCooldown({ testStatus: "expired", modelLock_gpt: at(60_000) }, NOW).state,
    ).toBe("expired");
  });

  it("needs-reauth outranks everything, locks included (P2-11)", () => {
    // The one state that needs a human must not hide behind an amber
    // "partial" (per-model lock) or a red-but-retryable "unavailable"
    // (account-wide lock). A successful request cannot clear it either —
    // see clearAccountError.
    expect(
      classifyConnectionCooldown({ testStatus: "needs-reauth", modelLock_gpt: at(60_000) }, NOW).state,
    ).toBe("needs-reauth");
    expect(
      classifyConnectionCooldown({ testStatus: "needs-reauth", modelLock___all: at(60_000) }, NOW).state,
    ).toBe("needs-reauth");
    // No locks at all: still needs-reauth (unlike "unavailable", which is
    // re-read as a stale flag → recovered).
    expect(classifyConnectionCooldown({ testStatus: "needs-reauth" }, NOW).state).toBe("needs-reauth");
  });
});

describe("sameConnectionCooldown", () => {
  // The components tick every second and must bail out of setState when the
  // classification is unchanged — classifyConnectionCooldown returns a fresh
  // object each call, so identity comparison would re-render a locked row
  // every second even though nothing visible changed.
  it("treats freshly-computed equal classifications as the same", async () => {
    const { sameConnectionCooldown } = await import("@/shared/utils/connectionCooldown.js");
    const conn = { modelLock_gpt: at(60_000), modelLock_claude: at(120_000) };
    const a = classifyConnectionCooldown(conn, NOW);
    const b = classifyConnectionCooldown(conn, NOW);
    expect(a).not.toBe(b);          // fresh objects...
    expect(sameConnectionCooldown(a, b)).toBe(true); // ...but identical content
  });

  it("distinguishes a real change (lock expired between ticks)", async () => {
    const { sameConnectionCooldown } = await import("@/shared/utils/connectionCooldown.js");
    const before = classifyConnectionCooldown({ modelLock_gpt: at(500) }, NOW);
    const after = classifyConnectionCooldown({ modelLock_gpt: at(-500) }, NOW);
    expect(sameConnectionCooldown(before, after)).toBe(false);
  });

  it("orders lockedModels into the comparison", async () => {
    const { sameConnectionCooldown } = await import("@/shared/utils/connectionCooldown.js");
    const a = classifyConnectionCooldown({ modelLock_gpt: at(60_000) }, NOW);
    const b = classifyConnectionCooldown({ modelLock_claude: at(60_000) }, NOW);
    expect(sameConnectionCooldown(a, b)).toBe(false);
  });
});

describe("earliestUntil agrees with the engine's own helper", () => {
  // classifyConnectionCooldown computes the soonest live expiry inline rather
  // than calling getEarliestModelLockUntil, because that helper reads the wall
  // clock itself and these tests need an injected `now`. That is a deliberate
  // duplication, so it is pinned here against the real function under the real
  // clock: if the two ever disagree, one of them is wrong and this goes red.
  it("matches getEarliestModelLockUntil for a mixed live/expired set", async () => {
    const { getEarliestModelLockUntil } = await import("open-sse/services/accountFallback.js");
    const soon = new Date(Date.now() + 60_000).toISOString();
    const later = new Date(Date.now() + 600_000).toISOString();
    const conn = {
      modelLock___all: null,
      modelLock_gone: new Date(Date.now() - 60_000).toISOString(),
      modelLock_soon: soon,
      modelLock_later: later,
    };
    expect(getEarliestModelLockUntil(conn)).toBe(soon);
    expect(classifyConnectionCooldown(conn).earliestUntil).toBe(soon);
  });

  it("matches getEarliestModelLockUntil when nothing is locked", async () => {
    const { getEarliestModelLockUntil } = await import("open-sse/services/accountFallback.js");
    const conn = { modelLock_gone: new Date(Date.now() - 60_000).toISOString() };
    expect(getEarliestModelLockUntil(conn)).toBeNull();
    expect(classifyConnectionCooldown(conn).earliestUntil).toBeNull();
  });
});
