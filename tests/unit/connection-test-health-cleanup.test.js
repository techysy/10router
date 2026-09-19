// A successful connection test is proof the credential works right now, so no
// runtime health state may outlive it. Before this, re-logging into an account
// whose token had gone stale left `modelLock_*` / `backoffLevel` /
// `rateLimitedUntil` in place: the dashboard showed a green connection while
// every request was still answered from the stale lock ("no account available"),
// which made the user's fix look like it changed nothing.
import { describe, expect, it } from "vitest";
import { clearModelLockFields } from "../../src/app/api/providers/[id]/test/testUtils.js";

describe("clearModelLockFields — successful-test health cleanup", () => {
  it("nulls every modelLock_* key, whatever the model name", () => {
    const patch = clearModelLockFields({
      id: "c1",
      service_port: 20127,
      modelLock_claude: "2026-09-18T10:00:00.000Z",
      "modelLock_claude-4.5-sonnet": "2026-09-18T10:00:00.000Z",
      modelLock___all: "2026-09-18T10:00:00.000Z",
    });

    expect(patch).toEqual({
      modelLock_claude: null,
      "modelLock_claude-4.5-sonnet": null,
      modelLock___all: null,
    });
  });

  it("does not touch unrelated fields", () => {
    const patch = clearModelLockFields({
      id: "c1",
      testStatus: "active",
      lastError: "old",
      accessToken: "tok",
    });

    expect(patch).toEqual({});
  });

  it("tolerates a connection with no locks and a missing connection", () => {
    expect(clearModelLockFields({ id: "c1" })).toEqual({});
    expect(clearModelLockFields(null)).toEqual({});
  });

  it("only clears keys using the shared lock prefix", () => {
    // Guard against a future key that merely mentions "model" being wiped.
    const patch = clearModelLockFields({
      model: "gpt-5.6",
      modelLocked: "not-ours",
      modelLock_gpt: "2026-09-18T10:00:00.000Z",
    });

    expect(patch).toEqual({ modelLock_gpt: null });
  });
});
