import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

// 桌面版（Electron 壳）与 npm/CLI 安装**共用同一个数据目录**是白纸黑字的设计
// （desktop/main.js 头注："两形态共享数据;两形态通过端口健康预检互斥(端口被占
// 且健康 → external 模式)"）。用户因此可以二选一、随时互换，数据跟人走。
//
// 这条设计有两个容易被"好心"破坏的地方，这里锁死：
//   1. 桌面壳自己对数据目录的推导必须与 src/lib/dataDir.js 的默认值一致
//      （Windows 上 Electron 的 userData 恰好就是 %APPDATA%/10router，两者重合）；
//   2. 桌面壳 spawn 服务端时**不得**另指 DATA_DIR —— 一旦指了（哪怕初衷只是
//      "把 Chromium 缓存和 db 分开"），npm 安装就再也看不到这份数据，共享断裂。
// 注意：Windows 上数据目录里混着 Chromium 的 Cache/、Local State 等文件是这条
// 设计的**正常代价**，别当成脏东西清理（迁移判据因此必须是"有没有我们的状态"
// 而不是"目录是否非空"，见 data-dir-migration.test.js）。

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const desktopSrc = readFileSync(path.join(root, "desktop", "main.js"), "utf8");
const dataDirSrc = readFileSync(path.join(root, "src", "lib", "dataDir.js"), "utf8");

const appName = dataDirSrc.match(/const APP_NAME = "([^"]+)"/)?.[1];

function dataDirBlock(src) {
  const start = src.indexOf("const DATA_DIR =");
  if (start === -1) return "";
  return src.slice(start, src.indexOf(";", start));
}

function spawnEnvBlock(src) {
  const start = src.indexOf("const env = {");
  if (start === -1) return "";
  return src.slice(start, src.indexOf("};", start));
}

describe("desktop shell shares one data dir with the npm/CLI install", () => {
  it("derives the same data dir as dataDir.js's default on both platforms", () => {
    expect(appName, "src/lib/dataDir.js 应声明 APP_NAME").toBeTruthy();
    const block = dataDirBlock(desktopSrc);
    expect(block).not.toBe("");

    // win32：%APPDATA%/<app>（APPDATA 缺失时退回 userData —— 同一个目录）
    expect(block).toContain(`path.join(process.env.APPDATA || app.getPath('userData'), '${appName}')`);
    // 非 win32：~/.<app>
    expect(block).toContain(`path.join(os.homedir(), '.${appName}')`);
  });

  it("does not point the spawned server at a different DATA_DIR", () => {
    const env = spawnEnvBlock(desktopSrc);
    expect(env, "desktop/main.js 的 spawn env 块没有找到（断言锚点过期？）").not.toBe("");
    // 锚点：确认抓到的是真正的服务端 env 块
    expect(env).toContain("INSTALL_CHANNEL: 'desktop'");
    expect(env).toContain("ELECTRON_RUN_AS_NODE: '1'");

    expect(env).not.toContain("DATA_DIR");
  });
});
