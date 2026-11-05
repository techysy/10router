"use strict";

// fnOS 管理面板的纯函数库（#97）。无依赖、可被 vitest 直接 import，
// 便于在不碰 NAS 的情况下钉死解析与判定逻辑。dashboard.js 是承载方。

// ── SemVer（与 src/shared/utils/semver.js 同一套语义）──
// 面板独立于主应用运行（cmd/ 下无 package.json、无依赖），这里保留一份
// 行为一致的实现；测试用例把两边的判定钉在同一批样例上。
function parseSemver(v) {
  if (typeof v !== "string" || !v.trim()) return null;
  const clean = v.trim().replace(/^v/i, "");
  const [core, ...preParts] = clean.split("-");
  const nums = core.split(".").map(Number);
  if (nums.some((n) => Number.isNaN(n))) return null;
  while (nums.length < 3) nums.push(0);
  return {
    major: nums[0],
    minor: nums[1],
    patch: nums[2],
    prerelease: preParts.length ? preParts.join("-") : null,
  };
}

function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (!pa.prerelease && pb.prerelease) return 1;
  if (pa.prerelease && !pb.prerelease) return -1;
  if (!pa.prerelease && !pb.prerelease) return 0;
  if (pa.prerelease === pb.prerelease) return 0;
  const an = pa.prerelease.split(".");
  const bn = pb.prerelease.split(".");
  const maxLen = Math.max(an.length, bn.length);
  for (let i = 0; i < maxLen; i += 1) {
    const ai = an[i];
    const bi = bn[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const numA = Number(ai);
    if (!Number.isNaN(numA) && !Number.isNaN(Number(bi))) {
      if (numA !== Number(bi)) return numA - Number(bi);
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  return 0;
}

// ── 归档魔数：npm tgz 是 gzip，浏览器上传可能带 zip ──
// gzip: 1f 8b；zip: 50 4b（PK）。其余一律拒绝。
function detectArchiveMagic(buf) {
  if (!buf || buf.length < 2) return null;
  if (buf[0] === 0x1f && buf[1] === 0x8b) return "gzip";
  if (buf[0] === 0x50 && buf[1] === 0x4b) return "zip";
  return null;
}

// ── 每日 HH:mm 调度 ──
// 「到点触发 + 面板重启后错过的当日窗口补跑一次」语义：不追帧补多次，
// 只看 lastRunAt 的日期键是否落后于今天且当前时间已过槽点。
function parseHHmm(s) {
  if (typeof s !== "string") return null;
  const m = s.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return { h, m: min };
}

function dateKey(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dailySlotMs(timeHHmm, nowMs) {
  const t = parseHHmm(timeHHmm);
  if (!t) return null;
  const d = new Date(nowMs);
  d.setHours(t.h, t.m, 0, 0);
  return d.getTime();
}

// 返回 true 表示此刻应触发（今日槽点已过 && 今天还没跑过）。
// lastRunAtMs 为 null/undefined 视作从未跑过 → 首次开启即会补跑一次。
function shouldRunDailySchedule(timeHHmm, nowMs, lastRunAtMs) {
  if (!parseHHmm(timeHHmm)) return false;
  const slot = dailySlotMs(timeHHmm, nowMs);
  if (nowMs < slot) return false;
  const today = dateKey(nowMs);
  const last = typeof lastRunAtMs === "number" && lastRunAtMs > 0 ? dateKey(lastRunAtMs) : null;
  return last !== today;
}

function nextDailyRunMs(timeHHmm, nowMs) {
  const slot = dailySlotMs(timeHHmm, nowMs);
  if (slot === null) return null;
  if (slot > nowMs) return slot;
  return slot + 24 * 60 * 60 * 1000;
}

// ── sudo -l 折行解析 ──
// sudo -l 的长命令列表会折行，续行以反斜杠结尾且下一行行首带缩进；
// 必须先合并延续行再逐行匹配，否则白名单对不齐。
function mergeSudoFoldedLines(text) {
  if (typeof text !== "string") return [];
  const raw = text.split(/\r?\n/);
  const merged = [];
  for (const line of raw) {
    const prev = merged[merged.length - 1];
    const cont = prev !== undefined ? /(\\+)\s*$/.exec(prev) : null;
    if (cont && cont[1].length % 2 === 1) {
      // 上一条以奇数个反斜杠结尾 = 折行标记；本行（去首部缩进）接上去。
      // 本行若自身也以反斜杠结尾，下一轮迭代会继续合并（多级延续）。
      merged[merged.length - 1] = prev.replace(/\\+\s*$/, "") + line.replace(/^\s+/, "");
      continue;
    }
    merged.push(line);
  }
  return merged;
}

// 从 `sudo -n -l` 输出提取 NOPASSWD 白名单命令行（去掉行首 (user:group) 段）。
// 没有免密授权时返回空数组（面板提示需要先在 sudoers 里放行）。
function parseSudoList(text) {
  const lines = mergeSudoFoldedLines(text);
  const out = [];
  for (const line of lines) {
    if (/NOPASSWD/.test(line)) {
      out.push(line.trim().replace(/^\([^)]*\)\s*/, "").trim());
    }
  }
  return out;
}

// ── aria2c 参数 ──
// 16 线程分段 + 断点续传；代理走 --all-proxy（aria2 自己完成 CONNECT+TLS，
// 不存在 Node 侧的握手坑）。stderr 归并到 stdout 便于进度解析。
function buildAria2Args({ url, out, proxy, threads = 16 }) {
  const args = ["-c", `--split=${threads}`, `--max-connection-per-server=${threads}`, "-k1M", "--stderr=true", `-d`, out.dir, "-o", out.file, url];
  if (proxy) args.push(`--all-proxy=${proxy}`);
  return args;
}

// ── 解包产物定位与校验 ──
// npm tgz 解开后根目录是 package/，server 产物在 package/app/。
// 只认「custom-server.js + package.json 双存在」的目录，防呆：解到一半/结构变了直接判失败。
function findPayloadRoot(extractDir) {
  const fs = require("fs");
  const path = require("path");
  const candidates = [
    path.join(extractDir, "package", "app"),
    path.join(extractDir, "app"),
    extractDir,
  ];
  for (const dir of candidates) {
    try {
      if (
        fs.existsSync(path.join(dir, "custom-server.js")) &&
        fs.existsSync(path.join(dir, "package.json"))
      ) {
        return dir;
      }
    } catch {
      // 目录不可读 → 试下一个候选
    }
  }
  return null;
}

function readPayloadVersion(payloadDir) {
  const fs = require("fs");
  const path = require("path");
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(payloadDir, "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

// ── npm 包 URL ──
// scoped 包在 registry 路径里只编码 scope 分隔符（@techysy/10router → @techysy%2F10router）；
// npm CLI 同款形式，encodeURIComponent 会把 @ 也编掉（%40 虽可用但不规范）。
function npmLatestUrl(packageName) {
  return `https://registry.npmjs.org/${packageName.replace("/", "%2F")}/latest`;
}

function npmTarballUrl(packageName, version) {
  const short = packageName.replace(/^@[^/]+\//, "");
  return `https://registry.npmjs.org/${packageName}/-/${short}-${version}.tgz`;
}

module.exports = {
  parseSemver,
  compareSemver,
  detectArchiveMagic,
  parseHHmm,
  dateKey,
  dailySlotMs,
  shouldRunDailySchedule,
  nextDailyRunMs,
  mergeSudoFoldedLines,
  parseSudoList,
  buildAria2Args,
  findPayloadRoot,
  readPayloadVersion,
  npmLatestUrl,
  npmTarballUrl,
};
