import { describe, it, expect, vi } from "vitest";
import { createStreamController } from "../../open-sse/utils/streamHandler.js";

describe("createStreamController immediate abort on disconnect (PR #5374)", () => {
  it("aborts the abortController signal synchronously upon handleDisconnect", () => {
    let abortedAtDisconnect = false;
    const ctrl = createStreamController({
      provider: "test",
      model: "test-model",
      onDisconnect: () => {
        // Disconnect hook runs and signal is already aborted
        abortedAtDisconnect = ctrl.signal.aborted;
      },
    });

    expect(ctrl.signal.aborted).toBe(false);
    expect(ctrl.isConnected()).toBe(true);

    ctrl.handleDisconnect("client_closed");

    expect(ctrl.signal.aborted).toBe(true);
    expect(abortedAtDisconnect).toBe(true);
    expect(ctrl.isConnected()).toBe(false);
  });
});
