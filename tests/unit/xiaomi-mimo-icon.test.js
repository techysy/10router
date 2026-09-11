import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getProviderIconSrc, resolveProviderIconId } from "@/shared/utils/providerIcon.js";
import { resolveProviderAlias } from "open-sse/services/model.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const iconFile = path.join(root, "public", "providers", "xiaomi-mimo.png");

/**
 * 设计 A：小米 Desktop 折进既有 xiaomi-mimo provider，**不**新建
 * `xiaomi-desktop` provider。因此图标槽位只有 `public/providers/xiaomi-mimo.png`
 * ——上游 #3921 拆分版往 `public/providers/xiaomi-desktop.png` 放的那张图，
 * 在合并版里没有任何代码路径会解析到（ProviderIcon → /providers/{id}.png，
 * id 是规范 provider id）。这个文件就是那条结论的守卫。
 */
describe("xiaomi-mimo provider icon", () => {
  it("resolves to the canonical provider id, not the Desktop split id", () => {
    expect(getProviderIconSrc("xiaomi-mimo")).toBe("/providers/xiaomi-mimo.png");
    // 没有被 ICON_ALIASES / ICON_EXTENSIONS 改写过（改成 xiaomi-desktop 就会 404）
    expect(resolveProviderIconId("xiaomi-mimo")).toBe("xiaomi-mimo");
    expect(getProviderIconSrc("xiaomi-desktop")).toBe("/providers/xiaomi-desktop.png");
  });

  it("exists on disk as a real PNG in the 128px house convention", () => {
    expect(fs.existsSync(iconFile)).toBe(true);
    const buf = fs.readFileSync(iconFile);
    expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    // 143 张 provider 图标里 135 张是 128×128；换图必须缩到这个尺寸
    expect(buf.readUInt32BE(16)).toBe(128);
    expect(buf.readUInt32BE(20)).toBe(128);
    // color type 6 = RGBA：瓦片必须带 alpha，不能是压白底的不透明白方块
    expect(buf[25]).toBe(6);
  });

  it("stays distinguishable from MiMo Code Free's orange mark", () => {
    // mimo-free 的 display name 就是 "MiMo Code Free"，两者同属小米 MiMo Code
    // 家族。本图用的是桌面客户端自己的 mono 图标（黑底 #000000 + 米白 #ffffee，
    // 饱和像素 ≈ 0%），mimo-free 是 #ff6600 的橙标（饱和像素 84%）—— 用同一套
    // 橙色会让人在卡片列表里分不清，所以两者不能是同一份资源。
    const free = path.join(root, "public", "providers", "mimo-free.png");
    expect(fs.existsSync(free)).toBe(true);
    expect(fs.readFileSync(iconFile).equals(fs.readFileSync(free))).toBe(false);
  });

  it("stays reachable through every registered alias", () => {
    for (const alias of ["mimo", "mimo-desktop", "xmd", "xiaomi-mimo"]) {
      const canonical = resolveProviderAlias(alias);
      expect(canonical).toBe("xiaomi-mimo");
      expect(getProviderIconSrc(canonical)).toBe("/providers/xiaomi-mimo.png");
    }
  });
});
