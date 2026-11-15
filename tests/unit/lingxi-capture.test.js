import { describe, expect, it } from "vitest";
import {
  parseCaptureCookie,
  normalizeCaptureCookie,
  looksLikeLingxiCookie,
  lingxiUidFromCookie,
  maskLingxiUid,
  lingxiAccountKey,
  issueImportToken,
  takeImportToken,
  __test__,
} from "../../open-sse/shared/lingxi/capture.js";

describe("lingxi capture cookie parsing", () => {
  it("parses a Cookie header string", () => {
    expect(parseCaptureCookie("wps_sid=a1; kso_sid=b2; uid=123")).toEqual([
      { name: "wps_sid", value: "a1" },
      { name: "kso_sid", value: "b2" },
      { name: "uid", value: "123" },
    ]);
  });

  it("strips a leading 'Cookie:' label", () => {
    expect(parseCaptureCookie("Cookie: wps_sid=a1")[0].name).toBe("wps_sid");
    expect(looksLikeLingxiCookie("Cookie: wps_sid=a1")).toBe(true);
  });

  it("accepts exported cookies JSON (array / {cookies:[]} / object map)", () => {
    expect(parseCaptureCookie('[{"name":"wps_sid","value":"v"}]')).toEqual([{ name: "wps_sid", value: "v" }]);
    expect(parseCaptureCookie('{"cookies":[{"name":"uid","value":"1"}]}')[0]).toMatchObject({ name: "uid" });
    const m = parseCaptureCookie('{"wps_sid":"v","uid":"42"}');
    expect(m.map((c) => c.name).sort()).toEqual(["uid", "wps_sid"]);
  });

  it("returns [] for empty input", () => {
    expect(parseCaptureCookie("")).toEqual([]);
    expect(parseCaptureCookie(null)).toEqual([]);
  });
});

describe("lingxi capture normalization", () => {
  it("recognizes a WPS session by wps_sid/kso_sid/uid presence", () => {
    expect(looksLikeLingxiCookie("wps_sid=abc; other=1")).toBe(true);
    expect(looksLikeLingxiCookie("kso_sid=x")).toBe(true);
    expect(looksLikeLingxiCookie("uid=123; x=1")).toBe(true);
    expect(looksLikeLingxiCookie("sessionid=abc; csrftoken=x")).toBe(false);
    expect(looksLikeLingxiCookie("")).toBe(false);
  });

  it("normalizes a raw header into a clean name=value jar", () => {
    expect(normalizeCaptureCookie("Cookie: wps_sid=a; uid=123 ; csrf=t ")).toBe("wps_sid=a; uid=123; csrf=t");
  });

  it("normalizes a cookies-JSON export into a header", () => {
    const out = normalizeCaptureCookie('[{"name":"wps_sid","value":"a"},{"name":"uid","value":"123"}]');
    expect(out).toBe("wps_sid=a; uid=123");
  });

  it("returns null for non-lingxi pastes (fails fast, no dead connection)", () => {
    expect(normalizeCaptureCookie("sessionid=zzz; csrftoken=q")).toBeNull();
    expect(normalizeCaptureCookie("")).toBeNull();
  });
});

describe("lingxi uid identity", () => {
  it("extracts the uid cookie as account identity", () => {
    expect(lingxiUidFromCookie("wps_sid=a; uid=1927751197; rtk=t")).toBe("1927751197");
    expect(lingxiUidFromCookie("kso_sid=x")).toBeNull();
    // non-numeric uid rejected (CreditDaddy 口径: uid 纯数字)
    expect(lingxiUidFromCookie("uid=not-a-number")).toBeNull();
  });

  it("masks uid for display (3+****+3 / 1+****+1)", () => {
    expect(maskLingxiUid("1927751197")).toBe("192****197");
    expect(maskLingxiUid("469061671")).toBe("469****671");
    expect(maskLingxiUid("123456")).toBe("1****6");
    expect(maskLingxiUid("12")).toBe("****");
  });

  it("derives a stable account key from the uid", () => {
    expect(lingxiAccountKey("wps_sid=a; uid=1927751197")).toBe("lingxi-uid-1927751197");
    expect(lingxiAccountKey("kso_sid=x")).toBeNull();
    // same uid from a rotated jar → same key (dedup works across refreshes)
    expect(lingxiAccountKey("wps_sid=REFRESHED; uid=1927751197")).toBe("lingxi-uid-1927751197");
  });
});

describe("lingxi import tokens", () => {
  it("issues and consumes a single-use token", () => {
    const ot = issueImportToken("owner-1", null);
    expect(typeof ot).toBe("string");
    expect(ot.length).toBe(32);
    expect(takeImportToken(ot, null)).toBe("owner-1");
    expect(takeImportToken(ot, null)).toBeNull(); // single-use
  });

  it("rejects a token minted for another connection", () => {
    const ot = issueImportToken("owner-2", "conn-a");
    expect(takeImportToken(ot, "conn-b")).toBeNull();
    expect(takeImportToken(ot, "conn-a")).toBe("owner-2");
  });

  it("rejects garbage tokens", () => {
    expect(takeImportToken("", null)).toBeNull();
    expect(takeImportToken("deadbeef", null)).toBeNull();
  });
});

describe("lingxi capture guard contract", () => {
  it("exposes the required session cookie name used by route validation", () => {
    expect(__test__.REQUIRED_SESSION_COOKIE).toBe("wps_sid");
  });
});
