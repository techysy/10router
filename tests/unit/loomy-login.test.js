import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import loomy, {
  LOOMY_LOGIN_CONFIG,
  LoomyLoginError,
  buildLoomySigningHeaders,
  mapTokens,
  maskPhone,
  normalizePhone,
  normalizeSmsCode,
  sendSmsCode,
  verifySmsCode,
} from "../../src/lib/oauth/providers/loomy.js";

// Fixed clock / nonce / traceid so the whole request (including Content-MD5)
// is a reproducible vector. The expected signature below was cross-checked
// against an independent Python hmac-sha1 implementation.
const FIXED_NOW = Date.UTC(2026, 9, 6, 12, 34, 56);
const FIXED_DATE = "Tue, 06 Oct 2026 12:34:56 GMT";
const FIXED_NONCE = "11111111-2222-4333-8444-555555555555";
const FIXED_TRACE = "00112233445566778899aabbccddeeff";
const FIXED_BODY =
  '{"base":{"appid":"GM3LOOMY","modelid":"Web","version":"1.0.0","devid":"web","ua":"Loomy|Desktop|Electron|macOS","traceid":"00112233445566778899aabbccddeeff"},"param":{"ccode":"86","phone":"13800138000","expire":300}}';
const FIXED_MD5 = "m1jjqZThGPoWKZbezArWXw==";
const FIXED_SIGNATURE = "cMuBVcyEjTDxeC4Vq8nh9gM122U=";

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (payload === undefined ? "" : JSON.stringify(payload)),
  };
}

function capture(payload, status = 200) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, init) => {
    calls.push({ url, init });
    return response(payload, status);
  });
  return { fetchImpl, calls };
}

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected promise to reject");
}

const fixedOptions = (fetchImpl) => ({
  fetchImpl,
  now: FIXED_NOW,
  nonce: FIXED_NONCE,
  traceid: FIXED_TRACE,
});

describe("Loomy SMS login signing", () => {
  it("sends the exact signed vector for a fixed date/nonce", async () => {
    const { fetchImpl, calls } = capture({ code: "000000", data: { msgid: "msg-1" } });

    const result = await sendSmsCode({ phone: "+86 138-0013-8000" }, fixedOptions(fetchImpl));

    expect(result).toEqual({ msgid: "msg-1" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://account.xfinfr.com/login/phone/sendMsgCode");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.body).toBe(FIXED_BODY);

    const headers = calls[0].init.headers;
    expect(headers.Date).toBe(FIXED_DATE);
    expect(headers.Nonce).toBe(FIXED_NONCE);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Content-MD5"]).toBe(FIXED_MD5);
    expect(headers.Authorization).toBe(
      `account ${LOOMY_LOGIN_CONFIG.accessKeyId}:${FIXED_SIGNATURE}`,
    );
  });

  it("keeps the signature recomputable from the actual body bytes", async () => {
    const { fetchImpl, calls } = capture({ code: "000000", data: { msgid: "m" } });
    await sendSmsCode({ phone: "13800138000" }, fixedOptions(fetchImpl));

    const { body, headers } = calls[0].init;
    const md5 = createHash("md5").update(body, "utf8").digest("base64");
    const stringToSign = [
      "POST",
      "/login/phone/sendMsgCode",
      "",
      md5,
      "application/json",
      headers.Date,
      headers.Nonce,
      "",
      "",
    ].join("\n");
    const signature = createHmac("sha1", LOOMY_LOGIN_CONFIG.accessKeySecret)
      .update(stringToSign, "utf8")
      .digest("base64");

    expect(md5).toBe(FIXED_MD5);
    expect(signature).toBe(FIXED_SIGNATURE);
    expect(headers.Authorization).toBe(`account 2thryby66wxi53sk:${signature}`);
  });

  it("builds the base envelope with every client _makeBase() field", async () => {
    const { fetchImpl, calls } = capture({ code: "000000", data: { msgid: "m" } });
    await sendSmsCode({ phone: "13800138000" }, fixedOptions(fetchImpl));

    const base = JSON.parse(calls[0].init.body).base;
    expect(base).toEqual({
      appid: "GM3LOOMY",
      modelid: "Web",
      version: "1.0.0",
      devid: "web",
      ua: "Loomy|Desktop|Electron|macOS",
      traceid: FIXED_TRACE,
    });
  });

  it("generates a 32-char hex traceid when none is injected", async () => {
    const { fetchImpl, calls } = capture({ code: "000000", data: { msgid: "m" } });
    await sendSmsCode({ phone: "13800138000" }, { fetchImpl });
    const first = JSON.parse(calls[0].init.body).base.traceid;
    expect(first).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("Loomy SMS msgid handoff", () => {
  it("passes msgid through from data.msgid", async () => {
    const { fetchImpl } = capture({ code: "000000", data: { msgid: "  msg-42  " } });
    await expect(
      sendSmsCode({ phone: "13800138000" }, { fetchImpl }),
    ).resolves.toEqual({ msgid: "msg-42" });
  });

  it("accepts the nested data.data.msgId shape", async () => {
    const { fetchImpl } = capture({ code: "000000", data: { data: { msgId: "nested" } } });
    await expect(
      sendSmsCode({ phone: "13800138000" }, { fetchImpl }),
    ).resolves.toEqual({ msgid: "nested" });
  });

  it("treats a success envelope without msgid as a protocol error", async () => {
    const { fetchImpl } = capture({ code: "000000", data: {} });
    const error = await rejection(sendSmsCode({ phone: "13800138000" }, { fetchImpl }));
    expect(error).toBeInstanceOf(LoomyLoginError);
    expect(error.kind).toBe("protocol");
    expect(error.code).toBe("MISSING_MSGID");
  });

  it("requires msgid before calling checkCode", async () => {
    const { fetchImpl, calls } = capture({ code: "000000", data: { session: "s" } });
    const error = await rejection(
      verifySmsCode({ phone: "13800138000", code: "123456" }, { fetchImpl }),
    );
    expect(error.kind).toBe("invalid_input");
    expect(calls).toHaveLength(0);
  });
});

describe("Loomy verifySmsCode payload", () => {
  it("maps session/userid into a 14-day connection payload", async () => {
    const { fetchImpl, calls } = capture({
      code: "000000",
      data: {
        session: "sess-1",
        userid: "u-9",
        nickname: "小明",
        email: "loomy@example.com",
      },
    });

    const tokens = await verifySmsCode(
      { phone: "13800138000", code: " 123456 ", msgid: "msg-1" },
      fixedOptions(fetchImpl),
    );

    const body = JSON.parse(calls[0].init.body);
    expect(calls[0].url).toBe("https://account.xfinfr.com/login/phone/checkCode");
    expect(body.param).toEqual({
      ccode: "86",
      phone: "13800138000",
      mcode: "123456",
      msgid: "msg-1",
      expire: 1209600,
    });
    expect(body.base.appid).toBe("GM3LOOMY");

    expect(tokens.accessToken).toBe("sess-1");
    expect(tokens.refreshToken).toBeNull();
    expect(tokens.expiresIn).toBe(1209600);
    expect(tokens.expiresAt).toBe(new Date(FIXED_NOW + 1209600 * 1000).toISOString());
    expect(tokens.uid).toBe("u-9");
    expect(tokens.name).toBe("小明");
    expect(tokens.email).toBe("loomy@example.com");
    expect(tokens.providerSpecificData).toMatchObject({
      authMethod: "sms",
      userId: "u-9",
      session: "sess-1",
      phone: "13800138000",
      phoneTail: "138****8000",
      ccode: "86",
    });

    const connection = mapTokens(tokens);
    expect(connection).toMatchObject({
      accessToken: "sess-1",
      refreshToken: null,
      email: "loomy@example.com",
      displayName: "小明",
    });
  });

  it("synthesizes a stable dedupe email and display name when upstream omits them", () => {
    const connection = mapTokens({
      accessToken: "sess",
      expiresAt: "2026-10-20T00:00:00.000Z",
      providerSpecificData: { userId: "u-1", session: "sess", phoneTail: "138****8000" },
    });
    expect(connection.email).toBe("loomy-u-1");
    expect(connection.displayName).toBe("Loomy 138****8000");
    expect(connection.providerSpecificData.authMethod).toBe("sms");
  });

  it("reports a success envelope without session as a protocol error", async () => {
    const { fetchImpl } = capture({ code: "000000", data: { userid: "u-1" } });
    const error = await rejection(
      verifySmsCode({ phone: "13800138000", code: "123456", msgid: "m" }, { fetchImpl }),
    );
    expect(error.kind).toBe("protocol");
    expect(error.code).toBe("MISSING_SESSION");
  });
});

describe("Loomy error classification", () => {
  it("classifies HTTP 401 as auth", async () => {
    const { fetchImpl } = capture({ desc: "signature rejected" }, 401);
    const error = await rejection(sendSmsCode({ phone: "13800138000" }, { fetchImpl }));
    expect(error).toBeInstanceOf(LoomyLoginError);
    expect(error.kind).toBe("auth");
    expect(error.status).toBe(401);
  });

  it("classifies dead-session business codes as auth even on HTTP 200", async () => {
    for (const code of ["020002", "100002"]) {
      const { fetchImpl } = capture({ code, desc: "session invalid" });
      const error = await rejection(
        verifySmsCode({ phone: "13800138000", code: "123456", msgid: "m" }, { fetchImpl }),
      );
      expect(error.kind).toBe("auth");
      expect(error.code).toBe(code);
    }
  });

  it("keeps other business codes as business errors with upstream copy", async () => {
    const { fetchImpl } = capture({ code: "100001", desc: "验证码错误" });
    const error = await rejection(
      verifySmsCode({ phone: "13800138000", code: "123456", msgid: "m" }, { fetchImpl }),
    );
    expect(error.kind).toBe("business");
    expect(error.code).toBe("100001");
    expect(error.message).toContain("验证码错误");
  });

  it("classifies non-2xx and non-JSON responses", async () => {
    const serverError = capture({ error: "boom" }, 500);
    const httpError = await rejection(
      sendSmsCode({ phone: "13800138000" }, { fetchImpl: serverError.fetchImpl }),
    );
    expect(httpError.kind).toBe("http");
    expect(httpError.status).toBe(500);

    const broken = vi.fn(async () => ({ ok: true, status: 200, text: async () => "<html>" }));
    const protocolError = await rejection(
      sendSmsCode({ phone: "13800138000" }, { fetchImpl: broken }),
    );
    expect(protocolError.kind).toBe("protocol");
  });

  it("classifies network failures", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const error = await rejection(sendSmsCode({ phone: "13800138000" }, { fetchImpl }));
    expect(error.kind).toBe("network");
    expect(error.message).toContain("ECONNREFUSED");
  });
});

describe("Loomy phone/code validation", () => {
  it("normalizes +86 / 86 prefixes, spaces and hyphens", () => {
    expect(normalizePhone("13800138000")).toEqual({ phone: "13800138000", ccode: "86" });
    expect(normalizePhone("+86 138-0013-8000")).toEqual({ phone: "13800138000", ccode: "86" });
    expect(normalizePhone("8613800138000")).toEqual({ phone: "13800138000", ccode: "86" });
    expect(normalizePhone("13800138000", "+86")).toEqual({ phone: "13800138000", ccode: "86" });
  });

  it("rejects malformed mainland numbers before any request", async () => {
    for (const phone of ["12800138000", "1380013800", "138001380000", "abcdefghijk", ""]) {
      expect(() => normalizePhone(phone)).toThrow(LoomyLoginError);
      expect(() => normalizePhone(phone)).toThrow(/中国大陆手机号/);
    }

    const { fetchImpl, calls } = capture({ code: "000000", data: { msgid: "m" } });
    const error = await rejection(sendSmsCode({ phone: "12345" }, { fetchImpl }));
    expect(error.kind).toBe("invalid_input");
    expect(calls).toHaveLength(0);
  });

  it("accepts non-86 ccode for 5–15 digit numbers and rejects bad ccode", () => {
    expect(normalizePhone("512345678", "1")).toEqual({ phone: "512345678", ccode: "1" });
    expect(() => normalizePhone("512345678", "abc")).toThrow(/区号/);
  });

  it("requires exactly six digits for the SMS code", async () => {
    expect(normalizeSmsCode(" 123456 ")).toBe("123456");
    expect(() => normalizeSmsCode("12345")).toThrow(/6 位数字/);
    expect(() => normalizeSmsCode("12345a")).toThrow(/6 位数字/);

    const { fetchImpl, calls } = capture({ code: "000000", data: { session: "s" } });
    const error = await rejection(
      verifySmsCode({ phone: "13800138000", code: "12", msgid: "m" }, { fetchImpl }),
    );
    expect(error.kind).toBe("invalid_input");
    expect(calls).toHaveLength(0);
  });

  it("masks the phone tail for display", () => {
    expect(maskPhone("13800138000")).toBe("138****8000");
    expect(maskPhone("123456")).toBe("123456");
  });
});

describe("Loomy provider descriptor", () => {
  it("exposes the Rust constants and SMS endpoints", () => {
    expect(LOOMY_LOGIN_CONFIG.baseUrl).toBe("https://account.xfinfr.com");
    expect(LOOMY_LOGIN_CONFIG.accessKeyId).toBe("2thryby66wxi53sk");
    expect(LOOMY_LOGIN_CONFIG.accessKeySecret).toBe("zsak6eadrbawz683wf5r3m2snrwj868r");
    expect(LOOMY_LOGIN_CONFIG.sessionTtlSeconds).toBe(1209600);
    expect(loomy.flowType).toBe("sms_code");
    expect(typeof loomy.sendSmsCode).toBe("function");
    expect(typeof loomy.verifySmsCode).toBe("function");
  });

  it("signs the exact checkCode body through the shared header builder", () => {
    const body = JSON.stringify({ probe: 1 });
    const headers = buildLoomySigningHeaders({
      path: "/login/phone/checkCode",
      bodyText: body,
      date: FIXED_DATE,
      nonce: FIXED_NONCE,
    });
    const md5 = createHash("md5").update(body, "utf8").digest("base64");
    expect(headers["Content-MD5"]).toBe(md5);
    expect(headers.Authorization.startsWith("account 2thryby66wxi53sk:")).toBe(true);
  });
});
