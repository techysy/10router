// Dashboard session cookie: the JWT lifetime and the cookie's maxAge must agree.
//
// Regression guard for a real logout bug: the token was signed with a 24h exp
// but the cookie carried no maxAge, so browsers treated `auth_token` as a
// session cookie and dropped it on browser close — the user was logged out even
// though their token was still valid.
//
// This is a behaviour test, not a source-text assertion: it drives the real
// cookie writer with a fake cookie store and decodes the token it produces.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// `@/lib/dataDir` resolves DATA_DIR at import time and, when it is unset, runs
// the legacy ~/.9router → ~/.10router migration. Point it at a throwaway dir
// (and set an explicit secret) so importing the module has no side effects.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "10router-session-"));
const originalDataDir = process.env.DATA_DIR;
const originalJwtSecret = process.env.JWT_SECRET;
process.env.DATA_DIR = tempDir;
process.env.JWT_SECRET = "test-secret-for-dashboard-session-cookie";

const { setDashboardAuthCookie, createDashboardAuthToken } = await import(
  "@/lib/auth/dashboardSession.js"
);
const { decodeJwt } = await import("jose");

const EXPECTED_MAX_AGE_SEC = 24 * 60 * 60;

function captureCookieSet() {
  const calls = [];
  const store = {
    set(...args) {
      calls.push(args);
    },
  };
  return { calls, store };
}

// Minimal stand-in for a Next.js Request — only `headers.get` is consulted.
function requestWithProto(proto) {
  return {
    headers: {
      get: (name) => (String(name).toLowerCase() === "x-forwarded-proto" ? proto : null),
    },
  };
}

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalJwtSecret;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.useRealTimers();
});

describe("setDashboardAuthCookie", () => {
  it("sets httpOnly auth_token with a 24h maxAge, not a session cookie", async () => {
    const { calls, store } = captureCookieSet();
    await setDashboardAuthCookie(store, requestWithProto("http"));

    expect(calls).toHaveLength(1);
    const [name, value, options] = calls[0];
    expect(name).toBe("auth_token");
    expect(typeof value).toBe("string");
    expect(options).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: false,
    });
    // The point of the fix: without maxAge this is a session cookie.
    expect(options.maxAge).toBe(EXPECTED_MAX_AGE_SEC);
  });

  it("keeps the token expiry equal to the cookie maxAge", async () => {
    // The two must never drift — that drift is exactly what caused the bug
    // (24h token, session-scoped cookie).
    const { calls, store } = captureCookieSet();
    await setDashboardAuthCookie(store, requestWithProto("http"));

    const [, token, options] = calls[0];
    const { exp, iat } = decodeJwt(token);
    expect(exp - iat).toBe(EXPECTED_MAX_AGE_SEC);
    expect(options.maxAge).toBe(exp - iat);
  });

  it("marks the cookie secure only behind an https hop", async () => {
    const https = captureCookieSet();
    await setDashboardAuthCookie(https.store, requestWithProto("https"));
    expect(https.calls[0][2].secure).toBe(true);

    // Multi-hop proxies send "https,http" — trust the client-facing hop.
    const multiHop = captureCookieSet();
    await setDashboardAuthCookie(multiHop.store, requestWithProto("https,http"));
    expect(multiHop.calls[0][2].secure).toBe(true);
  });

  it("carries claims through and still gets the same lifetime", async () => {
    const { calls, store } = captureCookieSet();
    await setDashboardAuthCookie(store, requestWithProto("http"), { sub: "oidc-user" });

    const [, token, options] = calls[0];
    const payload = decodeJwt(token);
    expect(payload.sub).toBe("oidc-user");
    expect(payload.authenticated).toBe(true);
    expect(options.maxAge).toBe(EXPECTED_MAX_AGE_SEC);
  });

  it("signs every token with the same lifetime contract", async () => {
    // createDashboardAuthToken is used directly elsewhere; keep it in lockstep.
    const { exp, iat } = decodeJwt(await createDashboardAuthToken());
    expect(exp - iat).toBe(EXPECTED_MAX_AGE_SEC);
  });
});
