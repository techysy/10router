import { describe, expect, it } from "vitest";
import {
  Jar,
  parseCookies,
  passportCookies,
  hasPassport,
  keepCookie,
  serializeCreds,
  bare,
  isConsoleCookie,
  isStorableCookie,
} from "../../open-sse/shared/dumate/cookies.js";
import {
  issueImportToken,
  takeImportToken,
  pub,
  finish,
} from "../../open-sse/shared/dumate/qr.js";
import { buildQuotas, planOf, isLoginFailure } from "../../open-sse/services/usage/dumate.js";

describe("dumate cookie jar", () => {
  it("scopes cookies to their Domain (host or subdomain only)", () => {
    const jar = new Jar();
    jar.add("BDUSS", "x1", ".baidu.com");
    jar.add("STOKEN", "x2", "passport.baidu.com");
    jar.add("bce-sessionid", "x3", ".bce.baidu.com");
    jar.add("OTHER", "x4", "evil.example.com");

    const forConsole = jar.forHost("console.bce.baidu.com").map((c) => c.name).sort();
    expect(forConsole).toEqual(["BDUSS", "bce-sessionid"]); // .baidu.com + .bce.baidu.com
    const forPassport = jar.forHost("passport.baidu.com").map((c) => c.name).sort();
    expect(forPassport).toEqual(["BDUSS", "STOKEN"]);
    expect(jar.header("evil.example.com")).toBe("OTHER=x4");
  });

  it("parses Set-Cookie headers and honors the Domain attribute", () => {
    const jar = new Jar();
    jar.addSetCookie(
      ["BDUSS=v; Path=/; Domain=.baidu.com; HttpOnly; Secure", "PTOKEN=p; Path=/"],
      "passport.baidu.com",
    );
    expect(jar.forHost("www.baidu.com").map((c) => c.name)).toContain("BDUSS");
    expect(jar.forHost("console.bce.baidu.com").map((c) => c.name)).toContain("BDUSS");
    expect(jar.forHost("passport.baidu.com").map((c) => c.name)).toEqual(
      expect.arrayContaining(["BDUSS", "PTOKEN"]),
    );
  });
});

describe("dumate parseCookies", () => {
  it("parses a Cookie header string", () => {
    const arr = parseCookies("BDUSS=a1; BAIDUID=b2 ; PTOKEN=c3");
    expect(arr).toEqual([
      { name: "BDUSS", value: "a1" },
      { name: "BAIDUID", value: "b2" },
      { name: "PTOKEN", value: "c3" },
    ]);
  });

  it("strips a leading 'Cookie:' label", () => {
    const arr = parseCookies("Cookie: BDUSS=a1");
    expect(arr[0].name).toBe("BDUSS");
  });

  it("accepts exported cookies JSON (array and {cookies:[]})", () => {
    const a = parseCookies('[{"name":"BDUSS","value":"v","domain":".baidu.com"}]');
    expect(a[0]).toMatchObject({ name: "BDUSS", value: "v", domain: ".baidu.com" });
    const b = parseCookies('{"cookies":[{"name":"BDUSS","value":"v"}]}');
    expect(b[0].name).toBe("BDUSS");
    // cookie-editor "name:value" object map
    const c = parseCookies('{"BDUSS":"v","BAIDUID":"w"}');
    expect(c.map((x) => x.name).sort()).toEqual(["BAIDUID", "BDUSS"]);
  });

  it("accepts the provider's own serialized credential", () => {
    const raw = serializeCreds([{ name: "BDUSS", value: "v", domain: ".baidu.com" }], "acc1", "dumate-qr");
    const arr = parseCookies(raw);
    expect(arr[0]).toMatchObject({ name: "BDUSS", value: "v" });
    expect(JSON.parse(raw).account).toBe("acc1");
  });
});

describe("dumate passportCookies / hasPassport", () => {
  it("extracts only passport cookies from a cookie header string", () => {
    const pp = passportCookies("BDUSS=v1; random=x; STOKEN=s; BAIDUID=u; other=1");
    expect(pp.map((c) => c.name).sort()).toEqual(["BAIDUID", "BDUSS", "STOKEN"]);
    // host-only names land on passport.baidu.com, the rest on .baidu.com
    expect(pp.find((c) => c.name === "STOKEN").domain).toBe("passport.baidu.com");
    expect(pp.find((c) => c.name === "BDUSS").domain).toBe(".baidu.com");
  });

  it("filters by domain when the credential carries domains", () => {
    const raw = serializeCreds(
      [
        { name: "BDUSS", value: "v", domain: ".baidu.com" },
        { name: "bce-sessionid", value: "s", domain: ".bce.baidu.com" },
        { name: "UNREL", value: "x", domain: ".example.com" },
      ],
      undefined,
      "dumate-qr",
    );
    const pp = passportCookies(raw);
    expect(pp.map((c) => c.name)).toEqual(["BDUSS"]);
  });

  it("hasPassport only when a BDUSS variant is present", () => {
    expect(hasPassport("BDUSS=v; STOKEN=s")).toBe(true);
    expect(hasPassport("BDUSS_BFESS=v; STOKEN=s")).toBe(true);
    expect(hasPassport("STOKEN=s; BAIDUID=u")).toBe(false);
  });
});

describe("dumate keepCookie", () => {
  it("keeps bce-sessionid + baidu.com/passport cookies, drops other bce-*", () => {
    expect(keepCookie({ name: "bce-sessionid", domain: ".bce.baidu.com" })).toBe(true);
    expect(keepCookie({ name: "bce-login-type", domain: ".bce.baidu.com" })).toBe(false);
    expect(keepCookie({ name: "BDUSS", domain: ".baidu.com" })).toBe(true);
    expect(keepCookie({ name: "STOKEN", domain: "passport.baidu.com" })).toBe(true);
    expect(keepCookie({ name: "ANY", domain: ".example.com" })).toBe(false);
  });
});

describe("dumate import tokens", () => {
  it("issues single-use tokens bound to an owner", () => {
    const ot = issueImportToken("owner-a");
    expect(typeof ot).toBe("string");
    expect(takeImportToken(ot)).toBe("owner-a");
    // second consume fails (single-use)
    expect(takeImportToken(ot)).toBeNull();
    expect(takeImportToken("nonexistent")).toBeNull();
  });

  it("binds bookmark tokens to the target connection", () => {
    const ot = issueImportToken("owner-a", "conn-1");
    expect(takeImportToken(ot, "conn-2")).toBeNull();
    expect(takeImportToken(ot, "conn-1")).toBe("owner-a");
  });
});

describe("dumate cookie storage boundaries", () => {
  it("keeps only console and supported passport cookies", () => {
    expect(isConsoleCookie({ name: "bce-sessionid", domain: "console.bce.baidu.com" })).toBe(true);
    expect(isConsoleCookie({ name: "bce-login-type", domain: ".bce.baidu.com" })).toBe(false);
    expect(isStorableCookie({ name: "BDUSS", domain: ".baidu.com", value: "x" })).toBe(true);
    expect(isStorableCookie({ name: "UNRELATED", domain: ".baidu.com", value: "x" })).toBe(false);
    expect(isStorableCookie({ name: "UNRELATED", domain: ".evil.example", value: "x" })).toBe(false);
    expect(isStorableCookie({ name: "bce-sessionid", domain: ".evil.example", value: "x" })).toBe(false);
    expect(passportCookies('[{"name":"UNRELATED","value":"x","domain":".baidu.com"}]')).toEqual([]);
  });
});

describe("dumate qr session pub contract", () => {
  it("exposes the dashboard-facing fields and hides creds", () => {
    const s = {
      id: "abc123", status: "waiting", connectionId: null,
      qr: "data:image/png;base64,xx", expiresAt: Date.now() + 60000,
      creds: '{"secret":true}',
    };
    const o = pub(s);
    expect(o).toMatchObject({ sid: "abc123", status: "waiting" });
    expect(o.qr).toBeDefined();
    expect(o.expiresAt).toBeDefined();
    expect(o.creds).toBeUndefined();
  });

  it("finish() marks terminal status and is sticky", () => {
    const s = { status: "waiting" };
    finish(s, "expired");
    expect(s.status).toBe("expired");
    expect(s.doneAt).toBeDefined();
    finish(s, "success"); // cannot leave a terminal state (except authorized)
    expect(s.status).toBe("expired");
  });
});

describe("dumate usage (quota_overview -> 10Router quotas)", () => {
  const quotaResult = {
    isSubscribed: true,
    usedPoints: 120,
    totalPoints: 5000,
    subscription: [
      { packageType: "plan_pro", status: "active", usedPoints: 100, totalPoints: 4000, pointsExpireDate: 1799999999 },
      { packageType: "plan_max", status: "expired", usedPoints: 9, totalPoints: 9 },
    ],
    incremental: [
      { packageType: "plan_point", status: "active", source: "login_bonus", usedPoints: 20, totalPoints: 1000, pointsExpireDate: 1799999999 },
      { packageType: "grant_point", status: "active", source: "invite_bonus", usedPoints: 0, totalPoints: 500 },
    ],
    modelThrottleInfo: { throttled: false },
  };

  it("builds subscription / incremental / balance rows and skips inactive packs", () => {
    const quotas = buildQuotas(quotaResult, null);
    expect(Object.keys(quotas).sort()).toEqual(
      ["订阅·Pro 套餐", "积分加油包", "邀请赠送积分·永久", "积分余额"].sort(),
    );
    expect(quotas["订阅·Pro 套餐"]).toMatchObject({ used: 100, total: 4000, recurring: true });
    expect(quotas["订阅·Pro 套餐"].resetAt).toBe(new Date(1799999999 * 1000).toISOString());
    // plan_point is a purchased top-up, not a gift
    expect(quotas["积分加油包"].giftPack).toBe(false);
    expect(quotas["邀请赠送积分·永久"].giftPack).toBe(true);
    expect(quotas["积分余额"]).toMatchObject({ used: 120, total: 5000, remaining: 4880, isCreditBalance: true });
  });

  it("keeps incremental packs out of the card pool (detailOnly) — totalPoints already includes them", () => {
    const quotas = buildQuotas(quotaResult, null);
    // 双计修复（2026-11-13 用户截图：卡片把赠送包与余额相加成 7,020，而
    // totalPoints 5,000 本身已含它们）——增量包只留在逐包明细。
    expect(quotas["积分加油包"].detailOnly).toBe(true);
    expect(quotas["邀请赠送积分·永久"].detailOnly).toBe(true);
    // 卡片级（非 detailOnly）只剩订阅窗口 + 余额两行
    const cardRows = Object.entries(quotas).filter(([, q]) => q.detailOnly !== true);
    expect(cardRows.map(([n]) => n)).toEqual(["订阅·Pro 套餐", "积分余额"]);
  });

  it("renders the daily check-in chip from loginBonusInfo", () => {
    const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    const quotas = buildQuotas(quotaResult, { hasIssued: true, totalTimes: 7, signInDays: [today] });
    expect(quotas["每日签到"]).toMatchObject({ checkinToday: true, streakDays: 7, detailOnly: true });
  });

  it("prefers the boolean hasIssued over the signInDays list", () => {
    const quotas = buildQuotas(quotaResult, { hasIssued: false, totalTimes: 0, signInDays: [] });
    expect(quotas["每日签到"].checkinToday).toBe(false);
  });

  it("marks the plan as throttled when the upstream says so", () => {
    const throttled = { ...quotaResult, modelThrottleInfo: { throttled: true } };
    expect(planOf(throttled)).toBe("Pro · 限流中");
    expect(planOf({ ...quotaResult, modelThrottleInfo: { throttled: false } })).toBe("Pro");
    expect(planOf({ subscription: [], modelThrottleInfo: null })).toBe("Free");
  });

  it("suffixes duplicate quota names instead of overwriting them", () => {
    const dup = {
      subscription: [],
      incremental: [
        { packageType: "grant_point", source: "event_bonus", status: "active", usedPoints: 1, totalPoints: 10 },
        { packageType: "grant_point", source: "event_bonus", status: "active", usedPoints: 2, totalPoints: 20 },
      ],
    };
    const quotas = buildQuotas(dup, null);
    expect(quotas["活动赠送积分·永久"].total).toBe(10);
    expect(quotas["活动赠送积分·永久·2"].total).toBe(20);
  });
});

describe("dumate usage login-failure detection", () => {
  it("treats redirects, 401/403 and non-JSON bodies as session loss", () => {
    expect(isLoginFailure({ status: 302, text: "" })).toBe(true);
    expect(isLoginFailure({ status: 401, text: "" })).toBe(true);
    expect(isLoginFailure({ status: 200, text: "<html>login</html>" })).toBe(true);
    expect(isLoginFailure({ status: 200, text: JSON.stringify({ code: 1, message: "登录凭证已过期" }) })).toBe(true);
    expect(isLoginFailure({ status: 200, text: JSON.stringify({ code: 1, message: "boom" }) })).toBe(true);
  });

  it("accepts a well-formed quota payload", () => {
    expect(isLoginFailure({ status: 200, text: JSON.stringify({ code: 0, result: { totalPoints: 1 } }) })).toBe(false);
  });
});
