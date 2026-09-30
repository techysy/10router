// 桌面壳「GitHub Releases 直装」更新通道的纯逻辑(desktop/releaseUpdater.js)。
// fixture 取自 v1.2.1 线上 release 的真实形态,特别是 SHA256SUMS-desktop.txt 里
// "10Router Setup 1.2.1.exe"(空格)与资产名 "10Router.Setup.1.2.1.exe"(点)失配的坑。
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import updater from "../../desktop/releaseUpdater.js";
const { isNewerVersion, pickInstaller, matchChecksum, parseChecksumLine, resolveExpectedSha, findSetupAsset } = updater;

const readSource = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

const SUMS_V121 = [
    "f6a939b92e51e3a915a0ad0a986641c04753509274a28e2c97a006615b9dd40f *10Router Setup 1.2.1.exe",
    "808bc1eb51da72075dcbaaa5e2c97a006615b9dd40f000000000000000000000 *10Router-Portable-1.2.1.exe",
    "aa01ac70063d2ef82085b67daf42cd5aefe09d1950f5f50bc5f72587980dd030 *10Router-Web-Setup-1.2.1.exe",
    "a81d5d2644054e1f4ed8ffc52ba2474c2d4a1e0adb3e87637dd56801da106b20 *10router-desktop-1.2.1-x64.nsis.7z",
].join("\r\n");

const release = (overrides = {}) => ({
    tag_name: "v1.2.1",
    assets: [
        { name: "10Router.Setup.1.2.1.exe", browser_download_url: "https://github.com/techysy/10router/releases/download/v1.2.1/10Router.Setup.1.2.1.exe", size: 109786112, digest: "sha256:f6a939b92e51e3a915a0ad0a986641c04753509274a28e2c97a006615b9dd40f" },
        { name: "10Router-Portable-1.2.1.exe", browser_download_url: "https://github.com/techysy/10router/releases/download/v1.2.1/10Router-Portable-1.2.1.exe", size: 109576192 },
        { name: "10Router-Web-Setup-1.2.1.exe", browser_download_url: "https://github.com/techysy/10router/releases/download/v1.2.1/10Router-Web-Setup-1.2.1.exe", size: 734003 },
        { name: "SHA256SUMS-desktop.txt", browser_download_url: "https://github.com/techysy/10router/releases/download/v1.2.1/SHA256SUMS-desktop.txt", size: 512 },
    ],
    ...overrides,
});

describe("isNewerVersion", () => {
    it("newer/older/equal on every segment", () => {
        expect(isNewerVersion("1.2.2", "1.2.1")).toBe(true);
        expect(isNewerVersion("1.3.0", "1.2.9")).toBe(true);
        expect(isNewerVersion("2.0.0", "1.9.9")).toBe(true);
        expect(isNewerVersion("1.2.1", "1.2.1")).toBe(false);
        expect(isNewerVersion("1.2.0", "1.2.1")).toBe(false);
    });

    it("ignores the v prefix and compares numerically, not lexically", () => {
        expect(isNewerVersion("v1.3.0", "1.2.9")).toBe(true);
        expect(isNewerVersion("1.10.0", "1.9.9")).toBe(true);
        expect(isNewerVersion("v1.2.10", "v1.2.9")).toBe(true);
    });

    it("short versions compare as if padded with zeros", () => {
        expect(isNewerVersion("1.3", "1.2.9")).toBe(true);
        expect(isNewerVersion("1.2", "1.2.0")).toBe(false);
    });
});

describe("findSetupAsset / pickInstaller", () => {
    it("picks only the NSIS setup, never portable / web-setup / nsis.7z", () => {
        const rel = release();
        expect(findSetupAsset(rel).name).toBe("10Router.Setup.1.2.1.exe");
        expect(findSetupAsset({ assets: [{ name: "10Router-Portable-1.2.1.exe" }] })).toBeNull();
        expect(findSetupAsset({ assets: [{ name: "10Router-Web-Setup-1.2.1.exe" }] })).toBeNull();
        expect(findSetupAsset({ assets: [{ name: "10router-desktop-1.2.1-x64.nsis.7z" }] })).toBeNull();
        expect(findSetupAsset({ assets: [] })).toBeNull();
    });

    it("pickInstaller strips the tag and carries the sums asset url", () => {
        const inst = pickInstaller(release());
        expect(inst.version).toBe("1.2.1");
        expect(inst.asset.name).toBe("10Router.Setup.1.2.1.exe");
        expect(inst.asset.size).toBe(109786112);
        expect(inst.sumsUrl).toContain("SHA256SUMS-desktop.txt");
        expect(inst.expectedSha).toBe("f6a939b92e51e3a915a0ad0a986641c04753509274a28e2c97a006615b9dd40f");
    });

    it("returns null without a setup asset, and tolerates a missing sums file / digest", () => {
        expect(pickInstaller({ tag_name: "v1.2.1", assets: [{ name: "10router-1.2.1-x86.fpk" }] })).toBeNull();
        const noSums = release({ assets: [release().assets[0]] });
        const inst = pickInstaller(noSums);
        expect(inst.sumsUrl).toBeNull();
        expect(inst.expectedSha).toBe("f6a939b92e51e3a915a0ad0a986641c04753509274a28e2c97a006615b9dd40f");
        const bare = pickInstaller({ tag_name: "v1.2.1", assets: [{ name: "10Router.Setup.1.2.1.exe", browser_download_url: "https://example/x.exe" }] });
        expect(bare.expectedSha).toBeNull();
    });
});

describe("matchChecksum tolerates the sums/asset name drift", () => {
    it("matches the space-separated sums name against the dotted asset name", () => {
        expect(matchChecksum(SUMS_V121, "10Router.Setup.1.2.1.exe")).toBe("f6a939b92e51e3a915a0ad0a986641c04753509274a28e2c97a006615b9dd40f");
    });

    it("works without the binary asterisk and with LF or CRLF endings", () => {
        const lf = "f6a939b92e51e3a915a0ad0a986641c04753509274a28e2c97a006615b9dd40f  10Router Setup 1.2.1.exe\n";
        expect(matchChecksum(lf, "10Router.Setup.1.2.1.exe")).toBe("f6a939b92e51e3a915a0ad0a986641c04753509274a28e2c97a006615b9dd40f");
    });

    it("uppercased hashes come back lowercased", () => {
        const upper = "F6A939B92E51E3A915A0AD0A986641C04753509274A28E2C97A006615B9DD40F *10Router Setup 1.2.1.exe";
        expect(matchChecksum(upper, "10Router.Setup.1.2.1.exe")).toBe("f6a939b92e51e3a915a0ad0a986641c04753509274a28e2c97a006615b9dd40f");
    });

    it("does not cross-match portable / web-setup entries", () => {
        expect(matchChecksum(SUMS_V121, "10Router-Portable-1.2.1.exe")).toBe("808bc1eb51da72075dcbaaa5e2c97a006615b9dd40f000000000000000000000");
        expect(matchChecksum(SUMS_V121, "10Router.Setup.9.9.9.exe")).toBeNull();
        expect(matchChecksum("", "10Router.Setup.1.2.1.exe")).toBeNull();
        expect(matchChecksum(SUMS_V121, "")).toBeNull();
    });

    it("parseChecksumLine rejects junk lines", () => {
        expect(parseChecksumLine("not a checksum line")).toBeNull();
        expect(parseChecksumLine("")).toBeNull();
        expect(parseChecksumLine(SUMS_V121.split("\r\n")[0])).toEqual({
            sha256: "f6a939b92e51e3a915a0ad0a986641c04753509274a28e2c97a006615b9dd40f",
            name: "10Router Setup 1.2.1.exe",
        });
    });
});

describe("resolveExpectedSha prefers the sums file and falls back to the asset digest", () => {
    const inst = pickInstaller(release());

    it("sums match wins", () => {
        expect(resolveExpectedSha(inst, SUMS_V121)).toBe("f6a939b92e51e3a915a0ad0a986641c04753509274a28e2c97a006615b9dd40f");
    });

    it("falls back to the asset digest when the sums text has no usable line", () => {
        expect(resolveExpectedSha(inst, "garbage")).toBe("f6a939b92e51e3a915a0ad0a986641c04753509274a28e2c97a006615b9dd40f");
    });

    it("null when neither source has a hash", () => {
        expect(resolveExpectedSha(pickInstaller({ tag_name: "v1", assets: [{ name: "10Router.Setup.1.exe", browser_download_url: "https://example/x.exe" }] }), null)).toBeNull();
        expect(resolveExpectedSha(null, SUMS_V121)).toBeNull();
    });
});

describe("main.js wiring", () => {
    const main = readSource("desktop/main.js");

    it("uses the module and keeps the npm-sourced primary check (?check=1)", () => {
        expect(main).toContain("require('./releaseUpdater')");
        const fn = main.slice(main.indexOf("async function checkForUpdates()"), main.indexOf("async function autoCheckUpdate()"));
        expect(fn).toContain("/api/version?check=1");
        expect(fn).toContain("checkUpdateViaGitHub");
    });

    it("every new update string has en, zh-CN and zh-TW text", () => {
        const keys = [
            "update.downloadInstall", "update.downloadBody", "update.downloadingTitle",
            "update.readyTitle", "update.readyBody", "update.installNow",
            "update.downloadFailedTitle", "update.checksumMismatch",
            "update.spawnFailedTitle", "update.spawnFailedBody", "update.sizeUnknown",
        ];
        const zhTWStart = main.indexOf("    'zh-TW': {");
        const blocks = {
            en: main.slice(main.indexOf("    en: {"), main.indexOf("    'zh-CN': {")),
            "zh-CN": main.slice(main.indexOf("    'zh-CN': {"), zhTWStart),
            "zh-TW": main.slice(zhTWStart, main.indexOf("\n};", zhTWStart)),
        };
        for (const key of keys) {
            for (const [loc, block] of Object.entries(blocks)) {
                expect(block.startsWith(`        '${key}':`) || block.includes(`\n        '${key}':`), `${loc} missing ${key}`).toBe(true);
            }
        }
    });
});
