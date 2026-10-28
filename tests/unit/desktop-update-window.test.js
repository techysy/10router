// 统一 HTML 更新窗（desktop/update-window.html + preload-update.js）形状钉：
// 新窗口资产存在且被 main.js 引用、进 build.files 白名单（历史坑：漏登记打包后
// 功能静默消失）；状态机关键分支；更新流不再出现原生 dialog/data-URL 进度窗；
// 安全面（contextIsolation/sandbox/本地 file 页面）；新增 i18n key 三语完整。
import { describe, it, expect } from "vitest";
import fs from "node:fs";

const read = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");
const exists = (rel) => fs.existsSync(new URL(`../../${rel}`, import.meta.url));

describe("unified HTML update window", () => {
    const main = read("desktop/main.js");
    const html = read("desktop/update-window.html");
    const preload = read("desktop/preload-update.js");
    const pkg = JSON.parse(read("desktop/package.json"));

    it("window assets exist on disk and are referenced from main.js", () => {
        expect(exists("desktop/update-window.html")).toBe(true);
        expect(exists("desktop/preload-update.js")).toBe(true);
        expect(main).toContain("update-window.html");
        expect(main).toContain("preload-update.js");
        expect(main).toContain("loadFile(UPDATE_HTML)");
    });

    it("build.files ships the new assets (漏登记=打包后静默消失)", () => {
        expect(pkg.build.files).toContain("update-window.html");
        expect(pkg.build.files).toContain("preload-update.js");
    });

    it("the update flow no longer uses native dialogs or the data-URL progress window", () => {
        const flow = main.slice(main.indexOf("async function checkForUpdates()"), main.indexOf("function showAbout()"));
        expect(flow).not.toContain("dialog.showMessageBox");
        expect(flow).not.toContain("dialog.showErrorBox");
        expect(flow).not.toContain("data:text/html");
        expect(main).not.toContain("downloadWithProgress");
    });

    it("state machine covers checking/available/downloading/ready/error/latest", () => {
        for (const s of ["checking", "available", "downloading", "ready", "error", "latest"]) {
            expect(main).toContain(`sendUpdateState('${s}'`);
        }
        // 关窗即取消下载：closed 处理器 abort 下载中的 AbortController
        const closed = main.slice(main.indexOf("updateWin.on('closed'"));
        expect(closed).toContain("updateDlCtrl.abort()");
        // 下载中仍推任务栏进度
        expect(main).toContain("updateWin.setProgressBar(");
    });

    it("keeps the behavior contract: ?check=1, releases fallback, stopServer before spawn", () => {
        expect(main).toContain("/api/version?check=1");
        expect(main).toContain("shell.openExternal(RELEASES_URL)");
        const segment = main.slice(
            main.indexOf("async function installDownloadedUpdate()"),
            main.indexOf("async function checkUpdateViaGitHub()")
        );
        expect(segment.indexOf("await stopServer()")).toBeGreaterThan(-1);
        expect(segment.indexOf("await stopServer()")).toBeLessThan(segment.indexOf("spawn(file"));
    });

    it("window is frameless with hardened webPreferences, preload uses contextBridge only", () => {
        const winDef = main.slice(main.indexOf("function openUpdateWindow()"), main.indexOf("updateWin.loadFile"));
        expect(winDef).toContain("frame: false");
        expect(winDef).toContain("contextIsolation: true");
        expect(winDef).toContain("nodeIntegration: false");
        expect(winDef).toContain("sandbox: true");
        expect(preload).toContain("contextBridge.exposeInMainWorld");
        expect(preload).not.toMatch(/require\((?!'electron')/);   // 只引 electron
        expect(preload).not.toContain("nodeIntegration");
    });

    it("the page loads no remote resources and keeps the strict CSP", () => {
        expect(html).not.toMatch(/src=["']https?:/i);
        expect(html).not.toMatch(/href=["']https?:/i);
        expect(html).not.toMatch(/@import|url\(/i);
        expect(html).toContain("Content-Security-Policy");
        expect(html).toContain("prefers-color-scheme");
        expect(html).toContain("closeBtn");        // 无边框窗的自定义关闭按钮
        expect(html).toContain("Escape");
    });

    it("no emoji/character icons remain — every icon slot is an inline Material Symbols <svg>", () => {
        // 旧实现用作图标的字符:✕ 关闭、✓ 就绪/最新、! 错误、10 徽标
        expect(html).not.toContain("✕");
        expect(html).not.toContain("✓");
        expect(html).not.toMatch(/badge/);                      // 旧字符徽标整套移除
        for (const id of ["i-check-circle", "i-download", "i-error", "i-progress", "i-refresh", "i-open-in-new", "i-close"]) {
            expect(html).toContain(`<symbol id="${id}" viewBox="0 -960 960 960">`);
        }
        // 状态 → 图标映射走 <use> 精灵引用
        expect(html).toContain("STATE_ICON");
        expect(html).toContain("available: { icon: 'i-download', tone: 'brand' }");
        expect(html).toContain("ready: { icon: 'i-check-circle', tone: 'ok' }");
        expect(html).toContain("error: { icon: 'i-error', tone: 'err' }");
        // 标题栏关闭按钮是 close 图标 SVG,不是 ✕ 字符
        const closeBtn = html.slice(html.indexOf('id="closeBtn"'), html.indexOf('id="closeBtn"') + 200);
        expect(closeBtn).toContain('<use href="#i-close"');
    });

    it("color values match the dashboard design tokens (src/app/globals.css)", () => {
        const css = read("src/app/globals.css");
        const light = css.slice(css.indexOf(":root {"), css.indexOf(".dark {"));
        const dark = css.slice(css.indexOf(".dark {"), css.indexOf("@theme inline"));
        const pick = (block, name) => {
            const m = block.match(new RegExp(`${name}:\\s*([^;]+);`));
            expect(m, `globals.css missing ${name}`).not.toBeNull();
            return m[1].trim();
        };
        // 浅色 token:更新窗直接复用同值
        for (const name of ["--color-brand-500", "--color-brand-600", "--color-brand-700", "--color-bg", "--color-surface", "--color-surface-2", "--color-text-main", "--color-text-muted", "--color-success", "--color-danger"]) {
            const v = pick(light, name);
            expect(html, `update-window.html missing light ${name}=${v}`).toContain(v);
        }
        // 深色 token:brand 与浅色同值(globals.css 特意保持一致),其余抽查关键几项
        for (const name of ["--color-bg", "--color-surface", "--color-text-main", "--color-success", "--color-danger"]) {
            const v = pick(dark, name);
            expect(html, `update-window.html missing dark ${name}=${v}`).toContain(v);
        }
        // 字体栈与 --font-sans 同款头部
        const font = pick(css.slice(css.indexOf("--font-sans:") - 5), "--font-sans");
        expect(html).toContain(font.split(",")[0].replace(/'/g, "'"));   // 'Inter'
        expect(html).toContain("-apple-system");
    });

    it("spinner is an SVG with a CSS rotation animation (Loading.js progress_activity)", () => {
        expect(html).toContain("@keyframes dashSpin");
        expect(html).toContain("animation: dashSpin");
        expect(html).toContain('<svg class="ic spin"><use href="#i-progress"/></svg>');
    });

    it("buttons follow the dashboard Button.js md/primary/ghost shape", () => {
        expect(html).toContain("height: 36px; padding: 0 16px; font-size: 14px; font-weight: 600; border-radius: 10px;");
        expect(html).toContain("transform: scale(.97)");       // active:scale-[0.97]
        expect(html).toContain("border-radius: 14px");         // Card/Modal 圆角
        // 打开 Releases 按钮带 open_in_new 图标
        expect(html).toContain("addBtn(strings.openReleases, 'open-releases', { primary: true, icon: 'i-open-in-new' })");
    });

    it("every new update-window string has en, zh-CN and zh-TW text", () => {
        const keys = ["update.windowTitle", "update.checking", "update.cancel", "update.retry"];
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
