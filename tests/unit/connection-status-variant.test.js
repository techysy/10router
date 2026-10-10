// getStatusVariant had ZERO coverage before this file: it is a 7-line pure
// function, so it imports cleanly under tests/vitest.config.js (unlike the JSX
// components that call it, which are pinned by source-text assertions).
//
// The "partial" case is the one that matters (issue #46): a connection with one
// model cooling down is NOT a dead account, and rendering it with the same red
// "unavailable" badge is what the reporter read as a broken connection.
import { describe, it, expect } from "vitest";
import { getStatusVariant } from "@/shared/utils/connectionStatus.js";

describe("getStatusVariant", () => {
  it("maps healthy statuses to success", () => {
    expect(getStatusVariant(true, "active")).toBe("success");
    expect(getStatusVariant(true, "success")).toBe("success");
  });

  it("maps failure statuses to error", () => {
    expect(getStatusVariant(true, "error")).toBe("error");
    expect(getStatusVariant(true, "expired")).toBe("error");
    expect(getStatusVariant(true, "unavailable")).toBe("error");
    // needs-reauth (dead refresh token) is a failure state, not an amber
    // "partial" — and not "default" (which would render as a grey unknown).
    expect(getStatusVariant(true, "needs-reauth")).toBe("error");
  });

  it("maps a partially-locked connection to warning, not error (#46)", () => {
    expect(getStatusVariant(true, "partial")).toBe("warning");
    // The distinction the whole change exists to make: these two must not
    // collapse to the same color.
    expect(getStatusVariant(true, "partial")).not.toBe(getStatusVariant(true, "unavailable"));
  });

  it("keeps a disabled connection neutral regardless of status", () => {
    // isActive === false wins over every status, including the new one —
    // a switched-off connection should not advertise a live cooldown.
    for (const status of ["active", "partial", "unavailable", "error", "needs-reauth", "unknown"]) {
      expect(getStatusVariant(false, status)).toBe("default");
    }
  });

  it("falls back to default for unknown or missing statuses", () => {
    expect(getStatusVariant(true, "unknown")).toBe("default");
    expect(getStatusVariant(true, null)).toBe("default");
    expect(getStatusVariant(true, undefined)).toBe("default");
  });

  it("only returns variants Badge.js actually defines", () => {
    // Guards the contract between this function and the component: adding a
    // status here without a matching variant would render an unclassed pill.
    const defined = new Set(["default", "primary", "success", "warning", "error", "info"]);
    for (const status of ["active", "success", "partial", "error", "expired", "unavailable", "needs-reauth", "unknown"]) {
      expect(defined).toContain(getStatusVariant(true, status));
    }
  });
});
