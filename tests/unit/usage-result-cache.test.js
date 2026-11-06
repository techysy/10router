import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createUsageResultCache } from "../../src/lib/usageResultCache";

// GET /api/usage/[connectionId] wraps every upstream call in this cache — the
// aggregated /api/usage/quotas route has always coalesced + cached; this is the
// per-connection route catching up. Upstream consoles are rate-sensitive.

const OK = (n = 1) => ({ status: 200, body: { quotas: { "session (5h)": { used: n, total: 100 } } } });
const ERR = { status: 500, body: { error: "upstream boom" } };
const MSG = { status: 200, body: { message: "Usage API not implemented" } };

describe("createUsageResultCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves a quota result from cache within the fresh TTL (fn called once)", async () => {
    const cache = createUsageResultCache();
    const fn = vi.fn(async () => OK());
    await cache.run("c1", fn);
    await cache.run("c1", fn);
    await cache.run("c1", fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("refetches after the 5-min fresh TTL lapses", async () => {
    const cache = createUsageResultCache();
    const fn = vi.fn(async () => OK());
    await cache.run("c1", fn);
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await cache.run("c1", fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("force skips the fresh TTL but respects the 30s minimum interval", async () => {
    const cache = createUsageResultCache();
    const fn = vi.fn(async () => OK());
    await cache.run("c1", fn, { force: true });
    // within 30s: even force gets the settled result
    vi.advanceTimersByTime(10_000);
    await cache.run("c1", fn, { force: true });
    expect(fn).toHaveBeenCalledTimes(1);
    // past 30s: force really refreshes
    vi.advanceTimersByTime(21_000);
    await cache.run("c1", fn, { force: true });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("non-cacheable results (errors, message bodies, empty quotas) cool down for 30s, not 5min", async () => {
    const cache = createUsageResultCache();
    const errFn = vi.fn(async () => ERR);
    await cache.run("c1", errFn);
    await cache.run("c1", errFn);
    expect(errFn).toHaveBeenCalledTimes(1); // served from cool-down
    vi.advanceTimersByTime(30_001);
    await cache.run("c1", errFn);
    expect(errFn).toHaveBeenCalledTimes(2); // recovered quickly after the cool-down

    const cache2 = createUsageResultCache();
    const msgFn = vi.fn(async () => MSG);
    await cache2.run("c1", msgFn);
    await cache2.run("c1", msgFn);
    expect(msgFn).toHaveBeenCalledTimes(1);
    const emptyFn = vi.fn(async () => ({ status: 200, body: { quotas: {} } }));
    await cache2.run("c2", emptyFn);
    await cache2.run("c2", emptyFn);
    expect(emptyFn).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent calls for one key into a single upstream flight", async () => {
    const cache = createUsageResultCache();
    let release;
    const gate = new Promise((r) => { release = r; });
    const fn = vi.fn(async () => {
      await gate;
      return OK(7);
    });
    const all = Promise.all([cache.run("c1", fn), cache.run("c1", fn), cache.run("c1", fn)]);
    release(); // flights are registered synchronously before the first await
    const [a, b, c] = await all;
    expect(fn).toHaveBeenCalledTimes(1);
    expect(a.body.quotas["session (5h)"].used).toBe(7);
    expect(b.body.quotas["session (5h)"].used).toBe(7);
    // different keys do not share a flight
    const other = vi.fn(async () => OK());
    await Promise.all([cache.run("c2", other), cache.run("c1", fn)]);
    expect(other).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("clones the shared body so consumers can mutate their copy", async () => {
    const cache = createUsageResultCache();
    await cache.run("c1", async () => OK(1));
    const hit = await cache.run("c1", async () => OK(999));
    hit.body.quotas["session (5h)"].used = 42;
    hit.body.extra = true;
    const hit2 = await cache.run("c1", async () => OK(1));
    expect(hit2.body.quotas["session (5h)"].used).toBe(1);
    expect(hit2.body.extra).toBeUndefined();
  });

  it("evicts the oldest entry beyond maxEntries", async () => {
    const cache = createUsageResultCache({ maxEntries: 2 });
    const calls = { a: 0, b: 0, c: 0 };
    const fn = (k) => async () => { calls[k] += 1; return OK(); };
    await cache.run("a", fn("a"));
    await cache.run("b", fn("b"));
    await cache.run("c", fn("c")); // FIFO evicts "a"
    await cache.run("a", fn("a")); // a refetches — and its insert evicts "b"
    await cache.run("c", fn("c")); // c still cached
    await cache.run("b", fn("b")); // b was evicted by the re-inserted a
    expect(calls.a).toBe(2);
    expect(calls.c).toBe(1);
    expect(calls.b).toBe(2);
  });
});
