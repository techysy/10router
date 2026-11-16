import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

export const DEEPAI_MACHINE_HEADER = "X-DeepAI-Code-Machine";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const PLACEHOLDERS = new Set([
  "00000000-0000-0000-0000-000000000000",
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
  "03000200-0400-0500-0006-000700080009",
]);

// Matches the shipped DeepAI Code 0.3.38 machineId.ts protocol. Only an
// actual OS identifier is used: never generate an identity per account,
// salt it with an API key, or rotate it to obtain additional daily grants.
export function detectDeepaiMachineId({
  platform = process.platform,
  readFile = readFileSync,
  run = execFileSync,
} = {}) {
  const command = (file, args) => {
    try {
      return String(run(file, args, {
        encoding: "utf8", timeout: 10_000, windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      }));
    } catch { return ""; }
  };
  const uuid = (text) => {
    const value = UUID.exec(text)?.[0]?.toLowerCase();
    return value && !PLACEHOLDERS.has(value) ? value : null;
  };
  let raw = null;
  if (platform === "linux") {
    for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      try {
        const value = String(readFile(path, "utf8")).trim().toLowerCase();
        if (/^[0-9a-f]{32}$/.test(value) && !/^0+$/.test(value)) {
          raw = value;
          break;
        }
      } catch { /* Try the system's next standard machine-id location. */ }
    }
  } else if (platform === "darwin") {
    const output = command("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
    const match = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(output);
    raw = match ? uuid(match[1]) : null;
  } else if (platform === "win32") {
    raw = uuid(command("powershell", ["-NoProfile", "-NonInteractive", "-Command",
      "(Get-CimInstance Win32_ComputerSystemProduct).UUID"]));
    if (!raw) {
      const output = command("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"]);
      const match = /MachineGuid\s+REG_SZ\s+(\S+)/.exec(output);
      raw = match ? uuid(match[1]) : null;
    }
  }
  // Raw identifiers never leave this module; unreadable identities fail open
  // without a header, allowing unmetered models to remain usable.
  return raw ? createHash("sha256").update(raw).digest("hex") : null;
}

let cached;
export function buildDeepaiMachineHeaders() {
  if (cached === undefined) cached = detectDeepaiMachineId();
  return cached ? { [DEEPAI_MACHINE_HEADER]: cached } : {};
}
