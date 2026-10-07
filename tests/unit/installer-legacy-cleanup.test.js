// v1.3.6：升级路径「自带清理」——新安装器在 customInit 里删除旧版卸载注册表键，
// 使 electron-builder 的 uninstallOldVersion 读不到 UninstallString 而整体跳过
// （模板原生早退路径，installUtil.nsh:157-166），冻结的旧卸载器代码根本不执行。
// 这修掉的是 v1.3.5 实测的「无法关闭」弹窗：旧卸载器在自己的 un.onInit 里跑
// CHECK_APP_RUNNING，即使没有任何 10Router 进程也会非零退出（幽灵检测），
// 外层重试 5 次后必弹框，静默路径则是 "Failed to uninstall old application files: 2"。
//
// installer.nsh 是 NSIS 脚本、不可 import —— 按仓库约定用源码文本断言守卫
// （tests/unit/disabled-models-ux.test.js:9）。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const rootDir = resolve(__dirname, "../..");
const nsh = readFileSync(resolve(rootDir, "desktop/nsis/installer.nsh"), "utf8");
const pkg = JSON.parse(readFileSync(resolve(rootDir, "desktop/package.json"), "utf8"));

// UUID.v5 的规范实现。为什么不用 electron-builder 自带的那个：那要求
// desktop/node_modules 已安装，而 CI 只装根目录 + tests 的依赖，于是这个
// 用例在 CI 上必炸（"Cannot find module '/desktop/node_modules/...'"）——
// 本地装过 desktop 依赖，所以一直是绿的。用 node:crypto 自己算等价结果，
// 既没有跨装包树的依赖，又保留了"appId 一改、断言立刻红"的守护作用。
const NS_UUID = "50e065bc-3134-11e6-9bab-38c9862bdaf3";
const uuidV5 = (name, namespace) => {
  const h = require("node:crypto").createHash("sha1");
  h.update(Buffer.from(namespace.replace(/-/g, ""), "hex"));
  h.update(name, "utf8");
  const b = Buffer.from(h.digest().subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const x = b.toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
};

describe("legacy uninstall registry key derivation", () => {
  // electron-builder NsisTarget.js:147 的派生：
  //   guid = UUID.v5(appId, UUID.parse("50e065bc-3134-11e6-9bab-38c9862bdaf3"))
  //   UNINSTALL_APP_KEY = guid.replace(/\\/g, " - ")
  // 我们的 customInit 硬编码了这个键路径——若有人改 appId 或派生规则变化而
  // 没有同步 installer.nsh，清理会静默失效（旧卸载器重新被调用）。此测试用
  // electron-builder 自己的 UUID 模块（生产同款调用）钉住派生结果。
  it("electron-builder 的卸载键名派生自 appId 且与 installer.nsh 硬编码一致", () => {
    const appId = pkg.build?.appId;
    expect(appId).toBe("com.techysy.10router");

    const guid = uuidV5(appId, NS_UUID);
    // 本机实测（HKCU\...\Uninstall\ 下真实存在的键名）
    expect(guid).toBe("d06897b6-43ce-5451-986c-a52486d415bb");
    // 键路径必须以 GUID + 引号收尾：electron-builder 的 UNINSTALL_APP_KEY 是
    // 【不带花括号】的纯 GUID——带上 {} 会删一个不存在的键，真键纹丝不动，
    // 旧卸载器照跑（v1.3.6 首测翻车实录）。
    expect(nsh).toContain(`Uninstall\\${guid}"`);
    expect(nsh).not.toContain(`Uninstall\\{${guid}`);
  });
});

describe("customInit 自带清理块", () => {
  it("在强杀/幸存者流程之后删除旧版卸载注册表键", () => {
    expect(nsh).toContain('ReadRegStr $R7 HKCU "${LEGACY_UNINSTALL_KEY}" "UninstallString"');
    expect(nsh).toContain('DeleteRegKey HKCU "${LEGACY_UNINSTALL_KEY}"');
  });

  it("HKLM best-effort 清理且失败静默（历史 perMachine 残留）", () => {
    expect(nsh).toMatch(/ClearErrors\s*\r?\n\s*DeleteRegKey HKLM "\$\{LEGACY_UNINSTALL_KEY\}"/);
  });

  it("按 InstallLocation best-effort 删除旧卸载器文件", () => {
    expect(nsh).toContain('ReadRegStr $R6 HKCU "${LEGACY_UNINSTALL_KEY}" "InstallLocation"');
    expect(nsh).toContain('Delete "$R6\\Uninstall 10Router.exe"');
  });

  it("保留 eb792cc1 的幸存者解释流程（真实进程的兜底）", () => {
    expect(nsh).toContain("10Router is still running (likely an elevated instance).");
  });

  it("不触碰 INSTALL 注册表键与用户数据目录", () => {
    // InstallLocation/KeepShortcuts 由 INSTALL 注册表键（Software\${APP_GUID}）承载，
    // 升级预填目录与快捷键保留都靠它——只能删 UNINSTALL 键
    expect(nsh).not.toMatch(/DeleteRegKey\s+\w+\s+"Software\\\$\{APP_GUID\}"/);
    // 自带清理只删「旧卸载器入口」（一个注册表键 + 一个 exe 文件）——
    // 任何目录级删除（RMDir）都可能波及用户自定义安装目录里的其它内容
    expect(nsh).not.toMatch(/RMDir/i);
  });
});
