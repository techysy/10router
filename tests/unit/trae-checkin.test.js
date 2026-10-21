import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (url, options) => globalThis.fetch(url, options),
}));

import {
  __resetTraeCheckinState,
  awardOf,
  checkinDeviceId,
  decideTraeOutcome,
  doneToday,
  runTraeCheckin,
  statusOf,
} from "../../src/sse/services/checkin/providers/trae.js";

afterEach(() => {
  vi.unstubAllGlobals();
  __resetTraeCheckinState();
});

const conn = (overrides = {}) => ({
  id: "trae-conn",
  provider: "trae",
  accessToken: "jwt-token",
  providerSpecificData: { site: "cn", devicePublicKeyPem: "BEGIN PUBLIC KEY" },
  ...overrides,
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Trae check-in protocol helpers", () => {
  it("generates a fresh 16-digit device id per round", () => {
    const a = checkinDeviceId();
    const b = checkinDeviceId();
    expect(a).toMatch(/^\d{16}$/);
    expect(b).toMatch(/^\d{16}$/);
    expect(a).not.toBe(b);
  });

  it("reads the upstream status fields without inventing values", () => {
    const status = statusOf({
      checked_in: false,
      did_checked_in: true,
      enable: true,
      credits: 100,
      extra_credits: 50,
      code: 0,
      message: "ok",
    });
    expect(doneToday(status)).toBe(true);
    expect(awardOf(status)).toBe(150);
    expect(statusOf({})).toMatchObject({ enable: false, code: 0, credits: 0 });
  });

  it("only reports success after the same-device recheck flips", () => {
    const before = statusOf({ enable: true, checked_in: false, did_checked_in: false });
    expect(decideTraeOutcome(before, statusOf({ code: 0 }), statusOf({ enable: true, checked_in: false }))).toMatchObject({
      kind: "unconfirmed",
    });
    expect(
      decideTraeOutcome(
        before,
        statusOf({ code: 0 }),
        statusOf({ enable: true, checked_in: true, credits: 100, extra_credits: 20 })
      )
    ).toMatchObject({ kind: "claimed", amount: 120 });
  });

  it("treats a disabled activity as neutral and a non-zero claim as rejected", () => {
    expect(decideTraeOutcome(statusOf({ enable: false }), statusOf({ code: 0 }), null).kind).toBe("not-enabled");
    expect(
      decideTraeOutcome(statusOf({ enable: true }), statusOf({ code: 9074, message: "busy" }), null)
    ).toMatchObject({ kind: "rejected", code: 9074 });
  });
});

describe("runTraeCheckin", () => {
  it("performs status → claim → same-device status and reports the confirmed award", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, options) => {
      calls.push({ url: String(url), headers: options.headers });
      if (String(url).endsWith("/status")) {
        const checked = calls.filter((call) => call.url.endsWith("/status")).length > 1;
        return json({
          enable: true,
          checked_in: checked,
          did_checked_in: checked,
          credits: checked ? 100 : 0,
          extra_credits: checked ? 50 : 0,
          code: 0,
        });
      }
      if (String(url).endsWith("/claim")) return json({ code: 0, message: "ok" });
      return json({});
    }));

    const result = await runTraeCheckin(conn());
    expect(result).toMatchObject({ status: "ok", amount: 150, unit: "积分" });
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.headers.Authorization === "Cloud-IDE-JWT jwt-token")).toBe(true);
    expect(calls.every((call) => call.headers["X-Device-Id"] === calls[0].headers["X-Device-Id"])).toBe(true);
    expect(calls[0].headers["X-Device-Id"]).toMatch(/^\d{16}$/);
  });

  it("stops after one request when the account is already checked in", async () => {
    const fetchMock = vi.fn(async () =>
      json({ enable: true, checked_in: true, did_checked_in: true, credits: 100, extra_credits: 0, code: 0 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await runTraeCheckin(conn());
    expect(result).toMatchObject({ status: "already", amount: 100 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports 9074 as limited without retrying", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n += 1;
      if (n === 1) return json({ enable: true, checked_in: false, did_checked_in: false, code: 0 });
      return json({ code: 9074, message: "当前参与用户太多" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await runTraeCheckin(conn());
    expect(result.status).toBe("limited");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // A 9074 day is not retried by the periodic sweep; only a manual force run
    // may probe again.
    const again = await runTraeCheckin(conn());
    expect(again.status).toBe("limited");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not call upstream for intl or for an account without a device binding", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const intl = await runTraeCheckin(conn({ providerSpecificData: { site: "intl" } }));
    expect(intl.status).toBe("no-activity");
    expect(fetchMock).not.toHaveBeenCalled();

    const manual = await runTraeCheckin(conn({ providerSpecificData: { site: "cn" } }));
    expect(manual.status).toBe("needs-reauth");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
