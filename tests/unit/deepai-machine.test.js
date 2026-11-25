import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { detectDeepaiMachineId } from "../../open-sse/shared/deepai/machine.js";

const RAW = "abcdef0123456789abcdef0123456789";
const UUID = "12345678-abcd-1234-abcd-1234567890ab";
const hash = (raw) => createHash("sha256").update(raw).digest("hex");

describe("DeepAI real host identity", () => {
  it("hashes the normalized Linux machine-id, never the raw value", () => {
    const readFile = vi.fn(() => ` ${RAW.toUpperCase()}\n`);
    const run = vi.fn();
    const id = detectDeepaiMachineId({ platform: "linux", readFile, run });
    expect(id).toBe(hash(RAW));
    expect(id).not.toBe(RAW);
    expect(readFile).toHaveBeenCalledExactlyOnceWith("/etc/machine-id", "utf8");
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["", "0".repeat(32), "bad-id", "f".repeat(33)])("skips an invalid Linux id (%s) and reads dbus", (first) => {
    const readFile = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(RAW);
    expect(detectDeepaiMachineId({ platform: "linux", readFile })).toBe(hash(RAW));
    expect(readFile).toHaveBeenLastCalledWith("/var/lib/dbus/machine-id", "utf8");
  });

  it("does not invent an identity when no system id is readable", () => {
    const readFile = vi.fn(() => { throw new Error("EACCES"); });
    expect(detectDeepaiMachineId({ platform: "linux", readFile })).toBeNull();
    expect(readFile).toHaveBeenCalledTimes(2);
    expect(detectDeepaiMachineId({ platform: "unsupported" })).toBeNull();
  });

  it("uses IOPlatformUUID on macOS", () => {
    const run = vi.fn(() => `"IOPlatformUUID" = "${UUID.toUpperCase()}"`);
    expect(detectDeepaiMachineId({ platform: "darwin", run })).toBe(hash(UUID));
    expect(run).toHaveBeenCalledWith("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"],
      expect.objectContaining({ timeout: 10000, windowsHide: true }));
  });

  it("prefers the Windows SMBIOS UUID", () => {
    const run = vi.fn(() => `UUID\n${UUID.toUpperCase()}\n`);
    expect(detectDeepaiMachineId({ platform: "win32", run })).toBe(hash(UUID));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each(["00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff", "03000200-0400-0500-0006-000700080009"])
    ("falls back to MachineGuid for Windows placeholder %s", (placeholder) => {
      const run = vi.fn().mockReturnValueOnce(placeholder).mockReturnValueOnce(`MachineGuid    REG_SZ    ${UUID}`);
      expect(detectDeepaiMachineId({ platform: "win32", run })).toBe(hash(UUID));
      expect(run).toHaveBeenLastCalledWith("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], expect.any(Object));
    });

  it("contains command failures and timeouts without making up a device", () => {
    const run = vi.fn(() => { throw new Error("timeout"); });
    expect(detectDeepaiMachineId({ platform: "win32", run })).toBeNull();
    expect(detectDeepaiMachineId({ platform: "darwin", run })).toBeNull();
  });
});
