import { describe, expect, it } from "vitest";
import {
  Jar,
  parseCookies,
  passportCookies,
  hasPassport,
  keepCookie,
  serializeCreds,
  bare,
} from "../../open-sse/shared/dumate/cookies.js";
import {
  issueImportToken,
  takeImportToken,
  pub,
  finish,
} from "../../open-sse/shared/dumate/qr.js";

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
