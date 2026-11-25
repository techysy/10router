// trae-free 是本机 TRAE SOLO 客户端的**黑白**标（从 SOLO exe 的 PE 资源提取），
// 不是远程 trae 供应商的彩色品牌标。v1.3.4 接入时只加了 Lobe 映射、没带 PNG，
// 于是走 src-only 路径的卡片（providers/page.js 的卡片列表就是 src-only）
// 请求 /providers/trae-free.png 404 → onError 污染本会话 failedIds → 回落
// 文字缩写 "TF"；走 providerId 路径的屏又会渲染成彩色 Trae 标。
// 同一张脸在两处不一致，视觉上就是「图标时有时无、还换了一张」。
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getProviderIconSrc, resolveProviderIconId } from "@/shared/utils/providerIcon.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const iconDir = path.join(root, "public", "providers");
const freeIcon = path.join(iconDir, "trae-free.png");
const remoteIcon = path.join(iconDir, "trae.png");
const lobeIconSrc = fs.readFileSync(
  path.join(root, "src", "shared", "components", "LobeProviderIcon.js"),
  "utf8",
);

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("trae-free provider icon", () => {
  it("resolves to its own asset, not the remote trae one", () => {
    // 不能靠 ICON_ALIASES 复用 trae.png：那张是远程 Trae 服务的彩色标，
    // 与本机 SOLO 客户端不是一回事（与 mimo/mimo-free 同理）。
    expect(resolveProviderIconId("trae-free")).toBe("trae-free");
    expect(getProviderIconSrc("trae-free")).toBe("/providers/trae-free.png");
  });

  it("ships a real RGBA PNG extracted from the SOLO exe", () => {
    expect(fs.existsSync(freeIcon)).toBe(true);
    const buf = fs.readFileSync(freeIcon);
    expect(buf.subarray(0, 8)).toEqual(PNG_MAGIC);
    // color type 6 = RGBA：瓦片必须带 alpha，不能是压白底的不透明白方块
    expect(buf[25]).toBe(6);
    // SHDefExtractIconW 取的是 256px（qoder.png 同样规格）
    expect(buf.readUInt32BE(16)).toBe(256);
    expect(buf.readUInt32BE(20)).toBe(256);
  });

  it("stays visually distinct from the remote trae mark", () => {
    expect(fs.existsSync(remoteIcon)).toBe(true);
    expect(fs.readFileSync(freeIcon).equals(fs.readFileSync(remoteIcon))).toBe(false);
  });

  it("is not short-circuited to the colored Lobe Trae icon", () => {
    // 留了 Lobe 映射的话，providerId 路径（拓扑图 / 用量卡片 / CLI 工具卡）会
    // 绕过 PNG 直接渲染彩色标，卡片列表与其它屏就成了两张脸。
    // （LOBE_PROVIDER_ICONS 是 JSX 模块，tests 的 vitest 不解析 .js 里的 JSX，
    //  故此处读源码断言映射项缺席。）
    expect(lobeIconSrc).not.toMatch(/^\s*["']trae-free["']\s*:/m);
    // #99 用户口径：官方早已换白底新标，trae / trae-cn 与 trae-free 同一张
    // 提取图（providerIcon.js 里 alias 到 trae-free.png），彩色 Lobe 标全线退场
    expect(lobeIconSrc).not.toMatch(/^\s*trae:\s*Trae,/m);
    expect(lobeIconSrc).not.toMatch(/^\s*["']trae-cn["']\s*:/m);
  });
});
