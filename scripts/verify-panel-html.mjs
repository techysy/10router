// 验证 fnos-packaging/cmd/dashboard.js 内嵌 HTML 的 script 块语法:
// 加载面板 CJS 的 HTML 构建逻辑(不走 HTTP),抽出 <script> 块逐个 node --check。
// 2026-11-21 面板「加载中…」卡死 = 模板字面量里 split("\n") 单反斜杠被 JS 解释成
// 真实换行,浏览器收到断行字符串 → SyntaxError → 整个 script 不执行。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, "..", "fnos-packaging", "cmd", "dashboard.js");

// 直接对整文件 require 会启动 HTTP server——所以只抓 HTML 构建产物:
// HTML 是模块顶层 `const HTML = \`...\`` 的值。用正则截取模板两端之间不做求值不可靠,
// 换姿势:临时 CJS wrapper,stub 掉 require 的 http/https/tls/fs 等,拿到 HTML 后退出。
const stub = `
const { Module } = require("module");
const origLoad = Module._load;
let captured = null;
Module._load = function (request, parent, isMain) {
  if (request === "http") {
    return { createServer: () => ({ listen: () => process.exit(0), on: () => {} }) };
  }
  return origLoad(request, parent, isMain);
};
process.on("exit", () => {});
`;

// 更简单可靠:模板字面量在源码里是单块,直接用 node 的 vm 预解析不可行(会执行顶层代码)。
// 改用字符串手术:定位 HTML 模板字面量的起止反引号,把字面量交给 node 求值。
const raw = fs.readFileSync(file, "utf8");
const hStart = raw.indexOf("<!doctype html>");
// 往前找包住 HTML 的反引号
const btOpen = raw.lastIndexOf("`", hStart);
// HTML 结束后的下一个反引号(从 </html> 之后找)
const btClose = raw.indexOf("`", raw.indexOf("</html>"));
if (btOpen === -1 || btClose === -1) {
  console.error("template literal bounds not found");
  process.exit(1);
}
const literalSrc = raw.slice(btOpen, btClose + 1);
// 求值模板字面量(无插值变量时它就是纯字符串;面板 HTML 有 ${} 插值吗?有——所以
// 提供这些变量的桩值)。先探测插值:
const interpolations = [...literalSrc.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]);
console.log("interpolations:", interpolations.length ? interpolations.join(" | ") : "(none)");
const vm = await import("node:vm");
const stubs = Object.fromEntries(interpolations.map((k) => [k, "STUB"]));
const html = vm.runInNewContext(literalSrc, stubs);
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
console.log("script blocks:", blocks.length);
let failed = 0;
blocks.forEach((b, i) => {
  const tmp = path.join(process.env.TEMP || "/tmp", `panel-check-${i}.js`);
  fs.writeFileSync(tmp, b, "utf8");
  try {
    execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
    console.log(`block ${i}: SYNTAX-OK (${b.length}b)`);
  } catch (e) {
    failed++;
    console.log(`block ${i}: SYNTAX-FAIL\n${e.stderr.toString().slice(0, 400)}`);
  }
  fs.unlinkSync(tmp);
});
process.exit(failed ? 1 : 0);
