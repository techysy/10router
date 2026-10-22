/**
 * Relay carrier selection — the "环形单向闭环接力" rules:
 *   1. single-point dead-burn (carrier keeps 100% while healthy);
 *   2. forward-only, never jump back (a refilled earlier account stays parked);
 *   3. aggressive pre-switch at the red zone (< 5% live remaining), unknown
 *      remaining never pre-switches.
 *
 * The percentage driving rule 3 is the SHORT window (fastest-resetting, see
 * usage/expiryExtractor.js) — not "the smallest remaining across every
 * bucket". Fixtures set `shortWindowRemaining` accordingly.
 */
import { describe, it, expect } from "vitest";
import { selectRelayCarrier, RELAY_RED_ZONE_PCT } from "../../open-sse/services/relaySelection.js";

const conn = (id, { remaining, lastUsedAt, priority } = {}) => ({
  id,
  shortWindowRemaining: remaining,
  lastUsedAt,
  priority,
});

describe("selectRelayCarrier", () => {
  it("single connection is always the carrier, no step", () => {
    const r = selectRelayCarrier([conn("a", { remaining: 1 })]);
    expect(r.connection.id).toBe("a");
    expect(r.stepped).toBe(false);
  });

  it("empty pool returns null", () => {
    expect(selectRelayCarrier([])).toBeNull();
  });

  it("rule 1: keeps a healthy carrier even when an earlier account refilled to 100%", () => {
    // Ring order [a, b]; b carries and is fine; a refilled — must NOT cut back.
    const ring = [conn("a", { remaining: 100 }), conn("b", { remaining: 60, lastUsedAt: "2026-10-14T10:00:00Z" })];
    const r = selectRelayCarrier(ring);
    expect(r.connection.id).toBe("b");
    expect(r.stepped).toBe(false);
  });

  it("rule 3: steps forward when the carrier crosses the red zone", () => {
    const ring = [conn("a", { remaining: 100 }), conn("b", { remaining: 4, lastUsedAt: "2026-10-14T10:00:00Z" }), conn("c", { remaining: 80 })];
    const r = selectRelayCarrier(ring);
    expect(r.connection.id).toBe("c");
    expect(r.stepped).toBe(true);
  });

  it("rule 2: steps FORWARD only — wraps past the end back to the head", () => {
    // Carrier is the LAST ring slot and is red; forward wraps to a (head).
    const ring = [conn("a", { remaining: 90 }), conn("b", { remaining: 2, lastUsedAt: "2026-10-14T12:00:00Z" })];
    const r = selectRelayCarrier(ring);
    expect(r.connection.id).toBe("a");
    expect(r.stepped).toBe(true);
  });

  it("rule 2: a refilled earlier account stays parked — the step goes forward, not to the head", () => {
    // Ring [a, b, c]; b carries and is red. a is full (100%) but EARLIER in the
    // ring: cutting back to it mid-stream is the jitter the design forbids.
    // The step must land on c, the NEXT slot.
    const ring = [
      conn("a", { remaining: 100 }),
      conn("b", { remaining: 2, lastUsedAt: "2026-10-14T12:00:00Z" }),
      conn("c", { remaining: 40 }),
    ];
    const r = selectRelayCarrier(ring);
    expect(r.connection.id).toBe("c");
    expect(r.stepped).toBe(true);
  });

  it("wrap-around: forward past the end lands on the head when it is the only healthy slot", () => {
    // Ring [a, b, c]; c carries (red), b red → wrap to a. This is the ring
    // closing (3→1), not a jump-back.
    const ring = [
      conn("a", { remaining: 70 }),
      conn("b", { remaining: 3 }),
      conn("c", { remaining: 1, lastUsedAt: "2026-10-14T12:00:00Z" }),
    ];
    const r = selectRelayCarrier(ring);
    expect(r.connection.id).toBe("a");
    expect(r.stepped).toBe(true);
  });

  it("no prior carrier: initial pick is the ring head and is NOT a handoff", () => {
    const ring = [conn("a", { remaining: 70 }), conn("b", { remaining: 90 })];
    const r = selectRelayCarrier(ring);
    expect(r.connection.id).toBe("a");
    expect(r.stepped).toBe(false);
  });

  it("unknown remaining does not pre-switch: carrier burns on until data arrives", () => {
    const ring = [conn("a", { remaining: 50 }), conn("b", { lastUsedAt: "2026-10-14T12:00:00Z" })];
    const r = selectRelayCarrier(ring);
    expect(r.connection.id).toBe("b");
    expect(r.stepped).toBe(false);
  });

  it("a fully drained carrier (remaining 0) steps forward", () => {
    const ring = [conn("a", { remaining: 80 }), conn("b", { remaining: 0, lastUsedAt: "2026-10-14T12:00:00Z" })];
    const r = selectRelayCarrier(ring);
    expect(r.connection.id).toBe("a");
    expect(r.stepped).toBe(true);
  });

  it("all red: falls back to the ring head so the 429/lock path handles it", () => {
    const ring = [conn("a", { remaining: 2 }), conn("b", { remaining: 1, lastUsedAt: "2026-10-14T12:00:00Z" })];
    const r = selectRelayCarrier(ring);
    expect(r.connection.id).toBe("a");
    expect(r.stepped).toBe(true);
  });

  it("threshold is exactly the red zone: 5% is still healthy, 4.9% is not", () => {
    expect(RELAY_RED_ZONE_PCT).toBe(5);
    const mk = (rem) => [conn("a", { remaining: 90 }), conn("b", { remaining: rem, lastUsedAt: "2026-10-14T12:00:00Z" }), conn("c", { remaining: 70 })];
    expect(selectRelayCarrier(mk(5)).connection.id).toBe("b");
    expect(selectRelayCarrier(mk(4.9)).connection.id).toBe("c");
  });

  it("does not mutate the ring", () => {
    const ring = [conn("a", { remaining: 90 }), conn("b", { remaining: 2, lastUsedAt: "2026-10-14T12:00:00Z" })];
    const snapshot = ring.map((c) => c.id);
    selectRelayCarrier(ring);
    expect(ring.map((c) => c.id)).toEqual(snapshot);
  });
});
