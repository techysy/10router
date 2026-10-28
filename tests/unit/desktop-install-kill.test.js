// 升级安装锁文件回归（2026-10-02 实测：v1.3.0 → 1.3.1 安装报
// “Failed to uninstall old application files”）——sidecar 与托盘是同一个
// 10Router.exe（ELECTRON_RUN_AS_NODE 无窗进程），旧版卸载器杀不掉它。
// 两道防线钉形状：NSIS customInit 安装前强杀；退出路径确定性停 sidecar。
import { describe, it, expect } from "vitest";
import fs from "node:fs";

const read = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

describe("installer pre-kill (covers upgrades FROM old versions)", () => {
  const nsh = read("desktop/nsis/installer.nsh");

  it("customInit force-kills the 10Router process tree before the old uninstaller runs", () => {
    expect(nsh).toContain("!macro customInit");
    expect(nsh).toMatch(/taskkill \/F \/IM 10Router\.exe \/T/);
    // 强杀后给文件锁留释放窗口
    expect(nsh).toMatch(/Sleep \d{3,}/);
  });

  it("customInit elevates via UAC so an admin-run sidecar (MITM on 443) is also killed", () => {
    // 安装器以普通用户运行，taskkill 直接杀不掉「以管理员身份运行」的旧 sidecar
    // （MITM 绑 443 需要提权）——必须 -Verb RunAs 从高权限上下文强杀。提权脚本
    // 走 PowerShell -EncodedCommand（UTF-16LE Base64），把 blob 解出来验证真实
    // 行为，而不是去匹配注释里同样出现的字样。
    const m = nsh.match(/ExecToStack 'powershell .*?-EncodedCommand ([A-Za-z0-9+/=]+)'/);
    expect(m).toBeTruthy();
    const script = Buffer.from(m[1], "base64").toString("utf16le");
    expect(script).toContain("-Verb RunAs");
    // 直连系统 taskkill.exe，避免 PATH 投毒
    expect(script).toContain("taskkill.exe");
    expect(script).toContain("10Router.exe");
    expect(script).toContain("/F");
    expect(script).toContain("/T");
  });

  it("the include script is registered with electron-builder", () => {
    const pkg = JSON.parse(read("desktop/package.json"));
    expect(pkg.build.nsis.include).toBe("nsis/installer.nsh");
    expect(fs.existsSync(new URL("../../desktop/nsis/installer.nsh", import.meta.url))).toBe(true);
  });
});

describe("deterministic shutdown (covers quit-then-install same-version flow)", () => {
  const main = read("desktop/main.js");

  it("before-quit runs stopServer before exiting", () => {
    const beforeQuit = main.slice(main.indexOf("before-quit"));
    expect(beforeQuit).toContain("e.preventDefault()");
    expect(beforeQuit).toContain("stopServer()");
    expect(beforeQuit).toContain("app.exit(0)");
  });

  it("the in-app updater stops the sidecar BEFORE spawning the installer", () => {
    const segment = main.slice(
      main.indexOf("async function installDownloadedUpdate()"),
      main.indexOf("async function checkUpdateViaGitHub()")
    );
    expect(segment.indexOf("await stopServer()")).toBeGreaterThan(-1);
    expect(segment.indexOf("await stopServer()")).toBeLessThan(segment.indexOf("spawn(file"));
  });

  it("will-quit keeps the taskkill backstop", () => {
    expect(main).toContain("app.on('will-quit'");
    expect(main).toContain("killProcTree(nodeProc.pid)");
  });
});
