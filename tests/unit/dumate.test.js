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
import { extractEarliestPackageExpiry } from "../../open-sse/services/usage/expiryExtractor.js";
import { extractConnectionBalance } from "../../open-sse/services/usage/balanceExtractor.js";
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";
import { classifyCycleRows, cycleRowLines, detailRows, joinsPackPool } from "../../src/shared/utils/quotaRows.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

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
    expect(quotas["订阅·Pro 套餐"]).toMatchObject({ used: 100, total: 4000, recurring: true, giftPack: true });
    expect(quotas["订阅·Pro 套餐"].detailOnly).toBeUndefined();
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

  it("keeps the balance and check-in rows out of the per-pack details (summarizesDetail)", () => {
    const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    const quotas = buildQuotas(quotaResult, { hasIssued: true, totalTimes: 7, signInDays: [today] });
    // 2026-11-14 用户反馈：明细里「积分余额 6,010/6,010」与卡片大数字纯重复，
    // 「每日签到 0/0」红行无信息量（徽章已表达）。两行都排除出逐包明细。
    expect(quotas["积分余额"].summarizesDetail).toBe(true);
    expect(quotas["每日签到"].summarizesDetail).toBe(true);
    // 明细（detailRows 语义）只剩订阅 + 赠送包
    const detailList = Object.entries(quotas)
      .filter(([, q]) => q.summarizesDetail !== true && q.detailOnly === true);
    expect(detailList.map(([n]) => n).sort()).toEqual(["积分加油包", "邀请赠送积分·永久"]);
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

describe("dumate additive subscription credits", () => {
  function payload({ subscriptionUsed = 4000, topupUsed = 0, permanentTopup = false } = {}) {
    const expires = Math.floor(Date.now() / 1000) + 86400;
    return {
      totalPoints: 5000,
      usedPoints: subscriptionUsed + topupUsed,
      subscription: [{ packageType: "plan_pro", status: "active", totalPoints: 4000,
        usedPoints: subscriptionUsed, pointsExpireDate: expires }],
      incremental: [{ packageType: "plan_point", status: "active", totalPoints: 1000,
        usedPoints: topupUsed, pointsExpireDate: permanentTopup ? null : expires + 86400 }],
    };
  }

  it("uses the live top-up's expiry and health after the subscription is spent", () => {
    const quotas = buildQuotas(payload(), null);
    expect(extractEarliestPackageExpiry({ quotas })).toMatchObject({
      name: "积分加油包",
      expiry: quotas["积分加油包"].resetAt,
      shortRemainingPct: 100,
      longRemainingPct: 100,
      zone: "green",
      recurringWindowCount: 0,
    });
    expect(extractConnectionBalance({ quotas })).toBe(1000);
  });

  it("reports no timed health when only a permanent top-up remains", () => {
    const quotas = buildQuotas(payload({ permanentTopup: true }), null);
    expect(extractEarliestPackageExpiry({ quotas })).toBeNull();
    expect(extractConnectionBalance({ quotas })).toBe(1000);
  });

  it("keeps an unspent subscription eligible for expiry ordering", () => {
    const quotas = buildQuotas(payload({ subscriptionUsed: 1000 }), null);
    expect(extractEarliestPackageExpiry({ quotas })).toMatchObject({
      name: "订阅·Pro 套餐",
      expiry: quotas["订阅·Pro 套餐"].resetAt,
      shortRemainingPct: 75,
      zone: "green",
    });
    expect(extractConnectionBalance({ quotas })).toBe(4000);
  });

  it("reports zero balance and no live pack when both credits are exhausted", () => {
    const quotas = buildQuotas(payload({ topupUsed: 1000 }), null);
    expect(extractEarliestPackageExpiry({ quotas })).toBeNull();
    expect(extractConnectionBalance({ quotas })).toBe(0);
  });

  it.each([0, 4000])("preserves the subscription cycle row without adding its credits to the pool twice (used=%s)", (subscriptionUsed) => {
    const result = payload({ subscriptionUsed });
    const rows = parseQuotaData("dumate", {
      quotas: buildQuotas(result, { hasIssued: true, totalTimes: 1 }),
    });
    const balance = rows.find((row) => row.isCreditBalance);
    const subscription = rows.find((row) => row.recurring);
    expect(balance).toMatchObject({ used: subscriptionUsed, total: 5000, summarizesDetail: true });
    expect(subscription).toMatchObject({ giftPack: true, total: 4000 });
    expect(subscription.detailOnly).toBeUndefined();
    // Keep the subscription available to the card's cycle/compact-window UI.
    // Its non-monthly recurring row does not join the additive pool.
    const cardRows = rows.filter((row) => !row.detailOnly);
    expect(cardRows).toEqual([subscription, balance]);
    expect(cycleRowLines(cardRows)).toEqual([subscription]);
    expect(classifyCycleRows(cardRows).monthly).toEqual([]);
    expect(joinsPackPool(subscription)).toBe(false);
    expect(cardRows.filter(joinsPackPool)).toEqual([balance]);
    const details = detailRows(rows);
    expect(details).toHaveLength(2);
    expect(details.filter((row) => row.detailOnly).map((row) => row.name)).toEqual(["积分加油包"]);
    expect(details.reduce((sum, row) => sum + row.total, 0)).toBe(balance.total);
    expect(details.reduce((sum, row) => sum + row.total - row.used, 0)).toBe(balance.total - balance.used);
  });
});

// 逐包明细同名包编号（2026-11-25 用户截图：「每日赠送积分·2·2·2·2·2·2·2」）。
// 旧写法 `while (quotas[name]) name += "·2"` 每次冲突都往尾部再贴一个 ·2，
// 一个月签到下来后缀层层堆叠；正确口径是按 base 计数（每日赠送积分、·2、·3…），
// 与 codebuddy-cn 的 seenRefill[base] / externalQuota.disambiguateQuotaNames 一致。
describe("dumate same-name pack numbering", () => {
  it("numbers repeated daily grants 1..N instead of stacking the ·2 suffix", () => {
    const day = 86400;
    const base = Math.floor(Date.now() / 1000) + 3 * day;
    const incremental = Array.from({ length: 18 }, (_, k) => ({
      packageType: "grant_point",
      status: "active",
      source: "login_bonus",
      usedPoints: 0,
      totalPoints: 500,
      pointsExpireDate: base - k * day,
    }));
    const quotas = buildQuotas(
      { totalPoints: 9000, usedPoints: 0, subscription: [], incremental },
      null,
    );
    const names = Object.keys(quotas).filter((n) => n !== "积分余额");
    expect(names).toHaveLength(18);
    expect(names[0]).toBe("每日赠送积分");
    expect(names[1]).toBe("每日赠送积分·2");
    expect(names[17]).toBe("每日赠送积分·18");
    // The bug's signature: a name carrying the marker twice.
    expect(names.some((n) => /·2·2/.test(n))).toBe(false);
  });

  it("numbers duplicate subscription packs off the same base", () => {
    const expires = Math.floor(Date.now() / 1000) + 86400;
    const quotas = buildQuotas(
      {
        totalPoints: 8000,
        usedPoints: 0,
        subscription: [
          { packageType: "plan_pro", status: "active", usedPoints: 0, totalPoints: 4000, pointsExpireDate: expires },
          { packageType: "plan_pro", status: "active", usedPoints: 0, totalPoints: 4000, pointsExpireDate: expires + 1 },
        ],
        incremental: [],
      },
      null,
    );
    expect(Object.keys(quotas).filter((n) => n !== "积分余额").sort()).toEqual(
      ["订阅·Pro 套餐", "订阅·Pro 套餐·2"],
    );
  });

  it("keeps the first of a kind bare and still numbers across 永久 rows", () => {
    const quotas = buildQuotas(
      {
        totalPoints: 4000,
        usedPoints: 0,
        subscription: [],
        incremental: [
          { packageType: "grant_point", status: "active", source: "invite_bonus", usedPoints: 0, totalPoints: 2000 },
          { packageType: "grant_point", status: "active", source: "invite_bonus", usedPoints: 0, totalPoints: 2000 },
          { packageType: "grant_point", status: "active", source: "invite_bonus", usedPoints: 0, totalPoints: 2000 },
        ],
      },
      null,
    );
    expect(Object.keys(quotas).filter((n) => n !== "积分余额")).toEqual([
      "邀请赠送积分·永久",
      "邀请赠送积分·永久·2",
      "邀请赠送积分·永久·3",
    ]);
  });

  it("skips inactive packs without burning an ordinal", () => {
    const expires = Math.floor(Date.now() / 1000) + 86400;
    const quotas = buildQuotas(
      {
        totalPoints: 1000,
        usedPoints: 0,
        subscription: [],
        incremental: [
          { packageType: "grant_point", status: "active", source: "login_bonus", usedPoints: 0, totalPoints: 500, pointsExpireDate: expires },
          { packageType: "grant_point", status: "expired", source: "login_bonus", usedPoints: 500, totalPoints: 500, pointsExpireDate: expires },
          { packageType: "grant_point", status: "active", source: "login_bonus", usedPoints: 0, totalPoints: 500, pointsExpireDate: expires + 1 },
        ],
      },
      null,
    );
    expect(Object.keys(quotas).filter((n) => n !== "积分余额")).toEqual([
      "每日赠送积分",
      "每日赠送积分·2",
    ]);
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

// DuMate 网关只认压缩拼写的 id（qwen38-flash / glm-53 / glm-53-flash），带点的
// canonical 行匹配不上，曾落进 *qwen* / *glm-5* 通用兜底：窗口砍到 1/4~1/5、
// vision:false 剥图片。PROVIDER_CAPABILITIES.dumate 把压缩 id 指回同模型带点
// canonical 行——这里钉住「压缩拼写 == 带点拼写」，防止再回落兜底。
describe("dumate compressed-spelling capabilities", () => {
  const PAIRS = [
    ["qwen38-flash", "qwen3.8-flash"],
    ["glm-53", "glm-5.3"],
    ["glm-53-flash", "glm-5.3-flash"],
  ];

  it.each(PAIRS)("dumate/%s resolves to the same caps as the dotted canonical %s", (compressed, dotted) => {
    expect(getCapabilitiesForModel("dumate", compressed)).toEqual(getCapabilitiesForModel("dumate", dotted));
  });

  it("qwen38-flash keeps the real 1M window and vision (not the *qwen* 256K floor)", () => {
    const c = getCapabilitiesForModel("dumate", "qwen38-flash");
    expect(c.contextWindow).toBe(1000000);
    expect(c.maxOutput).toBe(131072);
    expect(c.vision).toBe(true);
    expect(c.reasoning).toBe(true);
    expect(c.thinkingFormat).toBe("qwen");
  });

  it("glm-53 / glm-53-flash keep the real 1M window (not the *glm-5* 200K floor)", () => {
    for (const id of ["glm-53", "glm-53-flash"]) {
      const c = getCapabilitiesForModel("dumate", id);
      expect(c.contextWindow, id).toBe(1000000);
      expect(c.maxOutput, id).toBe(131072);
      expect(c.reasoning, id).toBe(true);
      expect(c.thinkingFormat, id).toBe("zai");
    }
    // GLM-5.3 文本档 thinking 不可关闭；flash 多模态档可关。
    expect(getCapabilitiesForModel("dumate", "glm-53").thinkingCanDisable).toBe(false);
    expect(getCapabilitiesForModel("dumate", "glm-53-flash").vision).toBe(true);
  });
});
