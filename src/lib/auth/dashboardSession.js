import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "@/lib/dataDir";
import { getSettings } from "@/lib/localDb";

const DEFAULT_PASSWORD = "123456";

// Session lifetime. The token's `exp` and the cookie's `maxAge` are both derived
// from this one value on purpose: with no maxAge at all the browser treats
// `auth_token` as a session cookie and drops it on browser close, so a user who
// is still well inside their 24h token gets logged out by closing a window.
const SESSION_MAX_AGE_SEC = 24 * 60 * 60;

// Placeholder values that ship in .env.example / old builds' source. A secret
// the whole internet can guess is worse than no secret — fall back to the
// auto-generated one instead of signing sessions with a public string.
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  "change-me-to-a-long-random-secret",
  "10router-default-secret-change-me",
  "change-me-to-a-random-string", // legacy fnOS fpk-generated .env default
  "change-me",
]);

function loadJwtSecret() {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv) {
    if (!KNOWN_PLACEHOLDER_SECRETS.has(fromEnv)) return fromEnv;
    console.warn(
      "[auth] JWT_SECRET is a known placeholder value — ignoring it. " +
        "Leave JWT_SECRET unset (a random secret is generated to " +
        path.join(DATA_DIR, "jwt-secret") + ") or set a long random value.",
    );
  }
  const file = path.join(DATA_DIR, "jwt-secret");
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {}
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const generated = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, generated, { mode: 0o600 });
  return generated;
}

const SECRET = new TextEncoder().encode(loadJwtSecret());

export function shouldUseSecureCookie(request) {
  const forceSecureCookie = process.env.AUTH_COOKIE_SECURE === "true";
  // Multi-hop proxies may send "https,http" — trust the first (client-facing) hop.
  const forwardedProto = request?.headers?.get?.("x-forwarded-proto") || "";
  const firstHop = String(forwardedProto).split(",")[0].trim().toLowerCase();
  return forceSecureCookie || firstHop === "https";
}

export async function createDashboardAuthToken(claims = {}) {
  return new SignJWT({ authenticated: true, ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SEC}s`)
    .sign(SECRET);
}

export async function verifyDashboardAuthToken(token) {
  if (!token) return false;
  try {
    await jwtVerify(token, SECRET);
    return true;
  } catch {
    return false;
  }
}

export async function getDashboardAuthSession(token) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, SECRET);
    return payload;
  } catch {
    return null;
  }
}

export async function setDashboardAuthCookie(cookieStore, request, claims = {}) {
  const token = await createDashboardAuthToken(claims);
  cookieStore.set("auth_token", token, {
    httpOnly: true,
    secure: shouldUseSecureCookie(request),
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SEC,
  });
}

export function clearDashboardAuthCookie(cookieStore) {
  cookieStore.delete("auth_token");
}

// Verify the current dashboard password (re-auth for sensitive actions).
export async function verifyDashboardPassword(password) {
  if (typeof password !== "string" || !password) return false;
  const settings = await getSettings();
  const storedHash = settings?.password;
  if (storedHash) return bcrypt.compare(password, storedHash);
  const initialPassword = process.env.INITIAL_PASSWORD || DEFAULT_PASSWORD;
  return password === initialPassword;
}
