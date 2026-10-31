import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
    INITIAL_DELAY_MS,
    CHECK_INTERVAL_MS,
    UPDATE_CHECK_DISABLED_MARKER,
    updateCheckDisabledMarkerPath,
    shouldRunBackgroundCheck,
    resolveBackgroundUpdateAction,
    canReuseDownloadedInstaller,
} from "../../desktop/updateScheduler.js";

const repoRoot = path.resolve(__dirname, "../..");
const readSource = (rel) => readFileSync(path.join(repoRoot, rel), "utf8");

describe("updateScheduler — schedule constants", () => {
    it("checks 30s after startup and every 6h (CreditDaddy cadence)", () => {
        expect(INITIAL_DELAY_MS).toBe(30 * 1000);
        expect(CHECK_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
    });

    it("mirrors the server-side marker file name (src/lib/updateCheck.js)", async () => {
        const server = readSource("src/lib/updateCheck.js");
        expect(server).toContain(`UPDATE_CHECK_DISABLED_MARKER = "${UPDATE_CHECK_DISABLED_MARKER}"`);
        expect(updateCheckDisabledMarkerPath("/data")).toBe(path.join("/data", UPDATE_CHECK_DISABLED_MARKER));
    });
});

describe("updateScheduler — shouldRunBackgroundCheck (开关守卫)", () => {
    it("runs when the marker file is absent (automatic checks on)", () => {
        expect(shouldRunBackgroundCheck({ markerExists: false })).toBe(true);
    });

    it("does not schedule when the operator turned automatic checks off", () => {
        expect(shouldRunBackgroundCheck({ markerExists: true })).toBe(false);
    });

    it("defaults to enabled when the marker state is unknown", () => {
        expect(shouldRunBackgroundCheck({})).toBe(true);
    });
});

describe("updateScheduler — resolveBackgroundUpdateAction (后台动作决策)", () => {
    it("pre-downloads on the Windows installer shell", () => {
        expect(resolveBackgroundUpdateAction({
            hasUpdate: true, latestVersion: "1.7.0", canInstallInPlace: true, alreadyReadyForVersion: false,
        })).toBe("pre-download");
    });

    it("never re-downloads an installer it already verified for the same version", () => {
        expect(resolveBackgroundUpdateAction({
            hasUpdate: true, latestVersion: "1.7.0", canInstallInPlace: true, alreadyReadyForVersion: true,
        })).toBe("notify-ready");
    });

    it("notifies without downloading on Portable / macOS / missing installer", () => {
        expect(resolveBackgroundUpdateAction({
            hasUpdate: true, latestVersion: "1.7.0", canInstallInPlace: false, alreadyReadyForVersion: false,
        })).toBe("notify-only");
    });

    it("does nothing without an update or a version", () => {
        expect(resolveBackgroundUpdateAction({
            hasUpdate: false, latestVersion: null, canInstallInPlace: true, alreadyReadyForVersion: false,
        })).toBe("none");
        expect(resolveBackgroundUpdateAction({
            hasUpdate: true, latestVersion: null, canInstallInPlace: true, alreadyReadyForVersion: false,
        })).toBe("none");
    });
});

describe("updateScheduler — canReuseDownloadedInstaller (手动检查秒装)", () => {
    const base = { instVersion: "1.7.0", fileExists: true, latestVersion: "1.7.0" };

    it("reuses the downloaded installer only in the install phase for the same version", () => {
        expect(canReuseDownloadedInstaller({ phase: "install", ...base })).toBe(true);
    });

    it.each([
        ["download", "phase not install"],
        ["check", "phase not install"],
    ])("does not reuse in %s phase (%s)", (phase) => {
        expect(canReuseDownloadedInstaller({ phase, ...base })).toBe(false);
    });

    it("does not reuse a different or unknown version", () => {
        expect(canReuseDownloadedInstaller({ phase: "install", ...base, instVersion: "1.6.9" })).toBe(false);
        expect(canReuseDownloadedInstaller({ phase: "install", ...base, latestVersion: null })).toBe(false);
    });

    it("does not reuse when the temp file is gone", () => {
        expect(canReuseDownloadedInstaller({ phase: "install", ...base, fileExists: false })).toBe(false);
    });
});

describe("main.js wiring (后台路径)", () => {
    const main = readSource("desktop/main.js");

    it("schedules background checks after startup instead of the one-shot autoCheckUpdate", () => {
        expect(main).toContain("require('./updateScheduler')");
        expect(main).toContain("scheduleBackgroundUpdateChecks();");
        expect(main).not.toContain("autoCheckUpdate()");
        expect(main).toContain("async function backgroundCheckForUpdates()");
    });

    it("the background path never opens the update window", () => {
        const fn = main.slice(
            main.indexOf("async function backgroundCheckForUpdates()"),
            main.indexOf("async function backgroundPreDownload(")
        );
        expect(fn).not.toContain("openUpdateWindow");
        expect(fn).toContain("/api/version`");   // 不带 check=1:尊重服务端开关与缓存
        expect(fn).toContain("shouldRunBackgroundCheck");
    });

    it("background download reuses downloadInstallerToTemp and lands in the install phase", () => {
        const fn = main.slice(
            main.indexOf("async function backgroundPreDownload("),
            main.indexOf("function scheduleBackgroundUpdateChecks()")
        );
        // 下载腿持有自己的 AbortController（手动下载启动时会 abort 它），
        // 完成后须复核仍是在途者本人再落 install 态
        expect(fn).toContain("downloadInstallerToTemp(inst, null, ctrl.signal)");
        expect(fn).toContain("if (ctrl.signal.aborted || backgroundDlCtrl !== ctrl) return;");
        expect(fn).toContain("updateCtx.phase = 'install'");
        expect(fn).not.toContain("installDownloadedUpdate");
    });

    it("the quit handler clears the background timer", () => {
        expect(main).toContain("clearInterval(backgroundUpdateTimer)");
    });

    it("every new update string has en, zh-CN and zh-TW text", () => {
        const keys = ["update.readyBalloonBody"];
        const zhTWStart = main.indexOf("    'zh-TW': {");
        const blocks = {
            en: main.slice(main.indexOf("    en: {"), main.indexOf("    'zh-CN': {")),
            "zh-CN": main.slice(main.indexOf("    'zh-CN': {"), zhTWStart),
            "zh-TW": main.slice(zhTWStart, main.indexOf("\n};", zhTWStart)),
        };
        for (const key of keys) {
            for (const [loc, block] of Object.entries(blocks)) {
                expect(block.includes(`'${key}':`), `${loc} missing ${key}`).toBe(true);
            }
        }
    });
});
