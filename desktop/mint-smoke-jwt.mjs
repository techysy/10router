#!/usr/bin/env node
/**
 * Mint a short-lived dashboard JWT for test-local.ps1's SSR smoke check.
 *
 * Why a file (not inline `node -e`): PowerShell 5.1 strips embedded double
 * quotes when passing arguments to native executables, so an inline ESM script
 * arrives at node mangled (SyntaxError). A committed helper sidesteps PS arg
 * quoting entirely.
 *
 * Usage: node mint-smoke-jwt.mjs <jwt-secret-file> <out-token-file>
 * Same signing scheme as src/lib/auth/dashboardSession.js (jose, HS256).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { SignJWT } from "jose";

const [, , secretFile, outFile] = process.argv;
if (!secretFile || !outFile) {
  console.error("usage: node mint-smoke-jwt.mjs <jwt-secret-file> <out-token-file>");
  process.exit(1);
}

const secret = new TextEncoder().encode(readFileSync(secretFile, "utf8").trim());
const token = await new SignJWT({ sub: "smoke" })
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime("10m")
  .sign(secret);
writeFileSync(outFile, token, "utf8");
