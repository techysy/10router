#!/usr/bin/env node
"use strict";

// fnOS 部署形态管理面板（issue #97）。
// 独立于主应用进程：cmd/main 拉起（nohup），主应用 stop/restart 不影响它；
// 因此定时自动更新的调度器放在这里，主进程重启不会丢触发窗口。
//
// 设计要点（全部来自真机踩坑，见 issue #97 表格）：
// - HTTP CONNECT 之后必须 tls.connect 完成 TLS 握手（否则代理下载全挂）；
// - aria2c 存在则 16 线程分段 + 断点续传（代理经 --all-proxy）；
// - 下载看门狗：60s 无新字节判定半死连接，中止并按策略重试；
// - tgz（gzip 1f 8b）/ zip（50 4b）双魔数校验，其余拒绝；
// - 热覆盖：同卷 staging 目录 cp -a → 三步换名（backup/server.new/server），
//   重启后健康检查不过自动回滚到 backup；
// - 目标版本一律服务端从 npm 解析，绝不信请求体（与 #9 的 updater 同纪律）。
//
// 面板默认只监听 127.0.0.1:20125；设 PANEL_TOKEN 后所有 /api/* 要求
// x-panel-token 头（UI 会提示输入一次）。

const http = require("http");
const https = require("https");
const tls = require("tls");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execFile } = require("child_process");
const { URL } = require("url");

const lib = require("./dashboard-lib.js");

// ── 配置解析 ──
// cmd/main 启动面板时注入 APP_DIR / DATA_DIR / SRC_DIR / NODE_BIN / MAIN_PORT。
const APP_NAME = process.env.TRIM_APPNAME || "10router";
const APP_DIR = process.env.APP_DIR || `/var/apps/${APP_NAME}`;
const DATA_DIR = process.env.DATA_DIR || path.join(os.homedir(), ".10router");
const SRC_DIR = process.env.SRC_DIR
  || (fs.existsSync(path.join(APP_DIR, "server")) ? path.join(APP_DIR, "server") : path.join(APP_DIR, "target", "server"));
const MAIN_CMD = process.env.MAIN_CMD || path.join(__dirname, "main");
const PANEL_PORT = Number(process.env.PANEL_PORT || 20125);
const PANEL_HOST = process.env.PANEL_HOST || "127.0.0.1";
const PANEL_TOKEN = process.env.PANEL_TOKEN || "";
const MAIN_PORT = Number(process.env.MAIN_PORT || process.env.PORT || 20127);
const NPM_PACKAGE = process.env.PANEL_NPM_PACKAGE || "@techysy/10router";

const STAGING_DIR = path.join(APP_DIR, ".panel-staging");
const SETTINGS_FILE = path.join(DATA_DIR, "panel", "settings.json");
const PANEL_LOG = path.join(DATA_DIR, "panel.log");
const MAIN_LOG = path.join(DATA_DIR, "10router.log");

// 更新流水线常量（与 issue #97 约定一致）
const STALL_WATCHDOG_MS = 60 * 1000;      // 60s 无新字节 = 半死连接
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const HEALTH_POLL_MS = 2 * 1000;
const HEALTH_TIMEOUT_MS = 90 * 1000;
const RETRY_DELAY_MS = 2 * 60 * 60 * 1000; // 失败 2h 后重试
const MAX_ATTEMPTS_PER_DAY = 3;
const MIN_FREE_KB = 1024 * 1024;           // 磁盘预检：1GB（tgz + 解包双份余量）
const UPLOAD_MAX_BYTES = 800 * 1024 * 1024;
const NPM_CACHE_TTL_MS = 60 * 60 * 1000;   // latest 查询缓存 1h
const PANEL_VERSION = "1.0.0";

// ── 面板日志（结构化单行，便于 grep）──
function plog(stage, message, extra) {
  const line = `${new Date().toISOString()} [panel] ${stage} ${message}${extra !== undefined ? " " + JSON.stringify(extra) : ""}`;
  try { fs.appendFileSync(PANEL_LOG, line + "\n"); } catch { /* 日志失败不影响主流程 */ }
  console.log(line);
}

// ── 设置持久化（panel/settings.json；主进程的配置走 SQLite，面板独立）──
const DEFAULT_SETTINGS = {
  autoUpdate: { enabled: false, time: "04:30" },
  proxy: { url: "" },
  scheduleState: { lastRunAtMs: 0, attemptsDateKey: "", attempts: 0, nextRetryAtMs: 0 },
  lastUpdate: { at: 0, trigger: "", ok: true, from: "", to: "", message: "" },
};

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    return {
      ...DEFAULT_SETTINGS,
      ...raw,
      autoUpdate: { ...DEFAULT_SETTINGS.autoUpdate, ...(raw.autoUpdate || {}) },
      proxy: { ...DEFAULT_SETTINGS.proxy, ...(raw.proxy || {}) },
      scheduleState: { ...DEFAULT_SETTINGS.scheduleState, ...(raw.scheduleState || {}) },
      lastUpdate: { ...DEFAULT_SETTINGS.lastUpdate, ...(raw.lastUpdate || {}) },
    };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }
}

function saveSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  const tmp = SETTINGS_FILE + ".tmp";
  // 0600：settings.proxy.url 可含账密（http://user:pass@host:port），对齐
  // initial-password 的落盘纪律（cmd/main 同款 umask 077 语义）。
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, SETTINGS_FILE);
}

// ── 代理感知的 HTTP(S)（核心坑：CONNECT 之后必须 tls.connect 握手）──
function proxyTunnel(proxyUrl, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const u = new URL(proxyUrl);
    const headers = { host: `${targetHost}:${targetPort}` };
    if (u.username || u.password) {
      headers["proxy-authorization"] = "Basic "
        + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString("base64");
    }
    const req = http.request({
      host: u.hostname,
      port: Number(u.port) || 80,
      method: "CONNECT",
      path: `${targetHost}:${targetPort}`,
      headers,
      timeout: 15000,
    });
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy CONNECT failed: ${res.statusCode}`));
        return;
      }
      resolve(socket);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("proxy CONNECT timeout")); });
    req.end();
  });
}

// 经代理（或直连）对 https 端点发起请求，返回 Node response 流。
function httpsRequest(urlStr, { method = "GET", headers = {}, timeoutMs = 15000, proxy = "" } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    if (u.protocol !== "https:") { reject(new Error("only https supported")); return; }
    const doRequest = (socket) => {
      const tlsOpts = { socket, servername: u.hostname, host: u.hostname, port: 443 };
      const req = https.request({ ...tlsOpts, method, path: u.pathname + u.search, headers, timeout: timeoutMs }, resolve);
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error(`request timeout: ${u.hostname}`)); });
      req.end();
    };
    if (proxy) {
      proxyTunnel(proxy, u.hostname, 443)
        .then((socket) => {
          // 代理隧道建立后，超时语义交给内层 https 请求；socket 挂在外层
          socket.setTimeout(0);
          doRequest(socket);
        })
        .catch(reject);
    } else {
      doRequest(undefined);
    }
  });
}

async function httpsGetJson(urlStr, { proxy = "", timeoutMs = 15000 } = {}) {
  const res = await httpsRequest(urlStr, { proxy, timeoutMs });
  let data = "";
  for await (const chunk of res) data += chunk;
  if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode} from ${u2h(urlStr)}`);
  return JSON.parse(data);
}
function u2h(u) { try { return new URL(u).host; } catch { return u; } }

// 下载到文件：aria2c 优先，Node 原生回退。两者都带停滞看门狗。
let aria2cPath = undefined;
function aria2cAvailable() {
  if (aria2cPath !== undefined) return Promise.resolve(aria2cPath);
  return new Promise((resolve) => {
    execFile("bash", ["-lc", "command -v aria2c || true"], (err, stdout) => {
      aria2cPath = (!err && stdout && stdout.trim()) ? stdout.trim().split("\n")[0] : null;
      resolve(aria2cPath);
    });
  });
}

function downloadViaAria2(urlStr, dest, proxy) {
  return new Promise((resolve, reject) => {
    const out = { dir: path.dirname(dest), file: path.basename(dest) };
    const args = lib.buildAria2Args({ url: urlStr, out, proxy });
    const child = spawn("aria2c", args, { stdio: ["ignore", "ignore", "pipe"] });
    let errTail = "";
    child.stderr.on("data", (c) => { errTail = (errTail + c).slice(-2000); });
    const killer = setTimeout(() => child.kill("SIGKILL"), DOWNLOAD_TIMEOUT_MS);
    child.on("error", (e) => { clearTimeout(killer); reject(e); });
    child.on("exit", (code) => {
      clearTimeout(killer);
      if (code === 0 && fs.existsSync(dest)) resolve();
      else reject(new Error(`aria2c exit ${code}: ${errTail.trim().slice(-300)}`));
    });
  });
}

function downloadViaNode(urlStr, dest, proxy) {
  return httpsRequest(urlStr, { proxy, timeoutMs: 30000 }).then((res) => {
    if (res.statusCode !== 200) {
      res.resume();
      return Promise.reject(new Error(`HTTP ${res.statusCode} while downloading`));
    }
    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(dest);
      let timer = null;
      const armWatchdog = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          res.destroy();
          out.destroy();
          reject(new Error(`stall watchdog: no bytes for ${STALL_WATCHDOG_MS / 1000}s`));
        }, STALL_WATCHDOG_MS);
      };
      armWatchdog();
      res.on("data", () => armWatchdog());
      res.on("error", (e) => { if (timer) clearTimeout(timer); out.destroy(); reject(e); });
      out.on("error", (e) => { if (timer) clearTimeout(timer); res.destroy(); reject(e); });
      out.on("finish", () => { if (timer) clearTimeout(timer); resolve(); });
      res.pipe(out);
    });
  });
}

// ── 版本判定 ──
let npmLatestCache = { version: null, fetchedAt: 0 };

async function fetchLatestVersion(proxy) {
  const now = Date.now();
  if (npmLatestCache.version && now - npmLatestCache.fetchedAt < NPM_CACHE_TTL_MS) {
    return npmLatestCache.version;
  }
  const data = await httpsGetJson(lib.npmLatestUrl(NPM_PACKAGE), { proxy, timeoutMs: 10000 });
  const version = typeof data.version === "string" ? data.version : null;
  if (!version) throw new Error("registry response without version");
  npmLatestCache = { version, fetchedAt: now };
  return version;
}

function readLocalVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(SRC_DIR, "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

// ── 磁盘预检（best-effort：busybox df 可能不支持 --output，失败即放行）──
function freeDiskKb(dir) {
  return new Promise((resolve) => {
    fs.mkdirSync(dir, { recursive: true });
    execFile("df", ["-k", "-P", dir], (err, stdout) => {
      if (err || !stdout) { resolve(null); return; }
      const lines = stdout.trim().split("\n");
      const last = lines[lines.length - 1].split(/\s+/);
      const avail = Number(last[3]);
      resolve(Number.isFinite(avail) ? avail : null);
    });
  });
}

// ── 主应用交互 ──
function mainPid() {
  try {
    const pid = Number(fs.readFileSync(path.join(DATA_DIR, "10router.pid"), "utf8").trim());
    if (!pid) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function mainHealth(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: MAIN_PORT, path: "/api/health", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200 || res.statusCode === 204);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

function mainVersion(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: MAIN_PORT, path: "/api/version", timeout: timeoutMs }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

function mainUptimeSeconds(pid) {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "etimes=", "-p", String(pid)], (err, stdout) => {
      const n = err ? NaN : Number(String(stdout).trim());
      resolve(Number.isFinite(n) ? n : null);
    });
  });
}

function runMainCmd(action) {
  return new Promise((resolve) => {
    execFile("bash", [MAIN_CMD, action], { timeout: 120000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: `${stdout || ""}${stderr || ""}`.slice(-2000) });
    });
  });
}

// ── 更新流水线 ──
// 状态机：null = 空闲；否则 { stage, trigger, from, to, startedAt, message }
let currentUpdate = null;

function setStage(stage, message) {
  currentUpdate = { ...currentUpdate, stage, message: message || currentUpdate?.message || "" };
  plog("update", `${stage}: ${message || ""}`, { trigger: currentUpdate?.trigger, from: currentUpdate?.from, to: currentUpdate?.to });
}

function shell(cmd, args, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${String(stderr || err.message).slice(-300)}`));
      else resolve(stdout);
    });
  });
}

async function downloadTarball(targetVersion, proxy) {
  const urlStr = lib.npmTarballUrl(NPM_PACKAGE, targetVersion);
  fs.mkdirSync(STAGING_DIR, { recursive: true });
  const dest = path.join(STAGING_DIR, `${NPM_PACKAGE.replace("@", "").replace("/", "-")}-${targetVersion}.tgz`);
  const aria2 = await aria2cAvailable();
  if (aria2) {
    setStage("downloading", `aria2c 分段下载 ${targetVersion}`);
    try {
      await downloadViaAria2(urlStr, dest, proxy || "");
      return dest;
    } catch (e) {
      plog("update", `aria2c failed, falling back to node: ${e.message}`);
      fs.rmSync(dest, { force: true });
    }
  }
  setStage("downloading", "node 原生下载");
  try {
    await downloadViaNode(urlStr, dest, proxy);
  } catch (e) {
    fs.rmSync(dest, { force: true });
    throw e;
  }
  return dest;
}

async function extractTarball(tgzPath) {
  const buf = Buffer.alloc(2);
  const fd = fs.openSync(tgzPath, "r");
  fs.readSync(fd, buf, 0, 2, 0);
  fs.closeSync(fd);
  const kind = lib.detectArchiveMagic(buf);
  if (!kind) throw new Error("archive magic check failed (not gzip/zip)");
  const extractDir = path.join(STAGING_DIR, `extract-${Date.now()}`);
  fs.mkdirSync(extractDir, { recursive: true });
  setStage("extracting", `解包（${kind}）`);
  if (kind === "gzip") {
    // --force-local：禁用「路径含冒号 = 远程主机」的 GNU tar 歧义。
    // Linux 上无副作用（POSIX 路径无盘符），开发机（Windows 盘符）可测。
    await shell("tar", ["--force-local", "-xzf", tgzPath, "-C", extractDir], 600000);
  } else {
    // zip：unzip 缺失时报错（fnOS 一般都有；aria2/tar 是本面板的硬路径）
    await shell("unzip", ["-q", "-o", tgzPath, "-d", extractDir], 600000);
  }
  const payload = lib.findPayloadRoot(extractDir);
  if (!payload) {
    fs.rmSync(extractDir, { recursive: true, force: true });
    throw new Error("payload invalid: custom-server.js/package.json not found after extract");
  }
  const payloadVersion = lib.readPayloadVersion(payload);
  return { extractDir, payload, payloadVersion };
}

// 同卷三步换名（backup / server.new / server），任一步失败都保持原 server 可用。
async function swapServerDir(payload, expectedVersion) {
  fs.rmSync(path.join(APP_DIR, "server.new"), { recursive: true, force: true });
  const newDir = path.join(APP_DIR, "server.new");
  await shell("cp", ["-a", `${payload}${path.sep}`, newDir], 600000);
  const extractedVersion = lib.readPayloadVersion(newDir);
  if (expectedVersion && extractedVersion && extractedVersion !== expectedVersion) {
    fs.rmSync(newDir, { recursive: true, force: true });
    throw new Error(`payload version mismatch: ${extractedVersion} != ${expectedVersion}`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = `${SRC_DIR}.bak-${stamp}`;
  fs.renameSync(SRC_DIR, backupDir);           // 原 server 让位（同卷 rename）
  try {
    fs.renameSync(newDir, SRC_DIR);
  } catch (e) {
    // 回滚换名：原 server 必须立刻复位
    fs.renameSync(backupDir, SRC_DIR);
    throw e;
  }
  // 只保留最近一个 backup
  try {
    const siblings = fs.readdirSync(path.dirname(SRC_DIR))
      .filter((n) => n.startsWith(path.basename(SRC_DIR) + ".bak-") && n !== path.basename(backupDir));
    for (const n of siblings) fs.rmSync(path.join(path.dirname(SRC_DIR), n), { recursive: true, force: true });
  } catch { /* 清理失败不阻塞 */ }
  return backupDir;
}

async function rollback(backupDir) {
  if (!backupDir || !fs.existsSync(backupDir)) return;
  plog("update", `rollback: restoring ${backupDir}`);
  try {
    await runMainCmd("stop");
  } catch { /* 尽力而为 */ }
  try {
    fs.rmSync(SRC_DIR, { recursive: true, force: true });
    fs.renameSync(backupDir, SRC_DIR);
    await runMainCmd("start");
    plog("update", "rollback done");
  } catch (e) {
    plog("update", `ROLLBACK FAILED: ${e.message} — 需要手动恢复 ${backupDir}`);
  }
}

async function healthWait() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
    if (await mainHealth(1500)) return true;
  }
  return false;
}

async function performUpdate({ trigger }) {
  if (currentUpdate) throw new Error("update already in progress");
  const settings = loadSettings();
  const proxy = settings.proxy?.url || "";
  currentUpdate = { stage: "starting", trigger, from: readLocalVersion(), to: null, startedAt: Date.now(), message: "" };
  let backupDir = null;
  try {
    setStage("checking", "解析 npm latest");
    const target = await fetchLatestVersion(proxy);
    currentUpdate.to = target;
    const local = readLocalVersion();
    if (local && lib.compareSemver(target, local) <= 0) {
      const message = `已是最新（${local}）`;
      setStage("done", message);
      finishUpdate(true, message);
      return { ok: true, updated: false, message };
    }

    const free = await freeDiskKb(STAGING_DIR);
    if (free !== null && free < MIN_FREE_KB) {
      throw new Error(`disk space low: ${Math.floor(free / 1024)}MB free (need >= ${MIN_FREE_KB / 1024}MB)`);
    }

    const tgz = await downloadTarball(target, proxy);
    const { extractDir, payload, payloadVersion } = await extractTarball(tgz);
    if (payloadVersion && payloadVersion !== target) {
      plog("update", `payload version ${payloadVersion} differs from registry ${target}; trusting payload`);
    }
    setStage("swapping", "热覆盖 server 产物");
    backupDir = await swapServerDir(payload, target);
    fs.rmSync(extractDir, { recursive: true, force: true });

    setStage("restarting", "重启主应用");
    const restart = await runMainCmd("restart");
    plog("update", `cmd/main restart: ${restart.ok}`, { output: restart.output.slice(-200) });

    setStage("health-check", "等待健康检查");
    const healthy = await healthWait();
    const versionInfo = healthy ? await mainVersion() : null;
    const landed = versionInfo && versionInfo.currentVersion === target;
    if (!healthy || !landed) {
      throw new Error(`health check failed after update (healthy=${healthy}, currentVersion=${versionInfo?.currentVersion ?? "n/a"}, expected ${target})`);
    }

    setStage("done", `已更新到 ${target}`);
    finishUpdate(true, `已更新 ${local || "?"} → ${target}`);
    return { ok: true, updated: true, from: local, to: target };
  } catch (e) {
    plog("update", `FAILED: ${e.message}`);
    if (backupDir) await rollback(backupDir);
    setStage("failed", e.message);
    finishUpdate(false, e.message);
    throw e;
  }
}

function finishUpdate(ok, message) {
  const settings = loadSettings();
  settings.lastUpdate = {
    at: Date.now(),
    trigger: currentUpdate?.trigger || "",
    ok,
    from: currentUpdate?.from || "",
    to: currentUpdate?.to || "",
    message,
  };
  saveSettings(settings);
  currentUpdate = null;
}

// ── 定时调度（30s tick；面板重启后错过的当日窗口补跑一次）──
let schedulerTimer = null;

async function schedulerTick() {
  let settings;
  try { settings = loadSettings(); } catch { return; }
  const { enabled, time } = settings.autoUpdate || {};
  if (!enabled) return;
  const now = Date.now();
  const today = lib.dateKey(now);
  const state = settings.scheduleState || {};

  // 当日重试配额用尽则不再触发
  if (state.attemptsDateKey === today && state.attempts >= MAX_ATTEMPTS_PER_DAY) return;

  const scheduledDue = lib.shouldRunDailySchedule(time, now, state.lastRunAtMs);
  // 同日重试：nextRetryAtMs 到点 + 配额未用尽（lastRunAtMs 已是今天，
  // scheduledDue 必为 false，重试只走这条路径 —— 不能再叠加日期判断）。
  const retryDue = Boolean(state.nextRetryAtMs) && state.nextRetryAtMs <= now
    && state.attemptsDateKey === today && state.attempts < MAX_ATTEMPTS_PER_DAY;
  if (!scheduledDue && !retryDue) return;
  if (currentUpdate) return;

  // 先记账再执行（幂等：防 30s tick 重复触发）
  const attempts = state.attemptsDateKey === today ? state.attempts + 1 : 1;
  const updated = loadSettings();
  updated.scheduleState = {
    lastRunAtMs: now,
    lastRunDateKey: today,
    attemptsDateKey: today,
    attempts,
    nextRetryAtMs: 0,
  };
  saveSettings(updated);
  plog("schedule", `trigger (${scheduledDue ? "window" : "retry"}, attempt ${attempts}/${MAX_ATTEMPTS_PER_DAY})`);

  try {
    await performUpdate({ trigger: "schedule" });
    plog("schedule", "auto update ok");
  } catch (e) {
    const s = loadSettings();
    if ((s.scheduleState.attemptsDateKey || "") === today && attempts < MAX_ATTEMPTS_PER_DAY) {
      s.scheduleState.nextRetryAtMs = Date.now() + RETRY_DELAY_MS;
      saveSettings(s);
      plog("schedule", `retry scheduled at ${new Date(s.scheduleState.nextRetryAtMs).toISOString()}`);
    }
  }
}

function startScheduler() {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => { schedulerTick().catch((e) => plog("schedule", `tick error: ${e.message}`)); }, 30 * 1000);
  schedulerTimer.unref();
}

// ── HTTP 服务 ──
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers["content-length"] || 0);
    if (len > limit) { reject(new Error(`body too large: ${len}`)); req.resume(); return; }
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// 上传流式落盘：首块做魔数校验（不合法立即中止），全量写文件。
// 文件不进内存 —— tgz 数百 MB，整包缓冲会把面板进程顶爆。
// 失败路径不能 req.destroy()（会连响应通道一起毁掉，客户端只看到空回复）：
// 排空剩余数据，让 400 能送达。写盘带背压，防止内存随上传膨胀。
function streamUploadToFile(req, dest) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers["content-length"] || 0);
    if (!len || len > UPLOAD_MAX_BYTES) {
      req.resume();
      reject(new Error(`invalid content-length: ${len}`));
      return;
    }
    let kind = null;
    let size = 0;
    let settled = false;
    const out = fs.createWriteStream(dest);
    const fail = (e) => {
      if (settled) return;
      settled = true;
      out.destroy();
      fs.rmSync(dest, { force: true });
      req.resume();
      reject(e);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      if (!kind) {
        kind = lib.detectArchiveMagic(chunk);
        if (!kind) {
          fail(new Error("magic check failed: not gzip/zip"));
          return;
        }
      }
      size += chunk.length;
      if (size > UPLOAD_MAX_BYTES) {
        fail(new Error("body too large"));
        return;
      }
      if (!out.write(chunk)) req.pause();
    });
    out.on("drain", () => { if (!settled) req.resume(); });
    req.on("error", (e) => fail(e));
    out.on("error", (e) => fail(e));
    req.on("end", () => {
      if (settled) return;
      out.end(() => {
        if (settled) return;
        settled = true;
        if (!kind) {
          fs.rmSync(dest, { force: true });
          reject(new Error("empty upload"));
          return;
        }
        resolve({ kind, size });
      });
    });
  });
}

async function buildStatus() {
  const settings = loadSettings();
  const pid = mainPid();
  const [healthy, versionInfo, latest] = await Promise.all([
    mainHealth(),
    pid ? mainVersion() : Promise.resolve(null),
    npmLatestCache.version
      ? Promise.resolve(npmLatestCache.version)
      : fetchLatestVersion(settings.proxy?.url || "").catch(() => null),
  ]);
  const local = readLocalVersion();
  const uptime = pid ? await mainUptimeSeconds(pid) : null;
  return {
    panel: { version: PANEL_VERSION, port: PANEL_PORT, host: PANEL_HOST },
    main: {
      running: Boolean(pid),
      pid,
      healthy,
      uptimeSeconds: uptime,
      version: versionInfo?.currentVersion || local,
      diskVersion: versionInfo?.diskVersion || null,
      staleBuild: Boolean(versionInfo && versionInfo.diskVersion && versionInfo.currentVersion
        && versionInfo.diskVersion !== versionInfo.currentVersion),
    },
    update: {
      localVersion: local,
      latestVersion: latest,
      updateAvailable: Boolean(latest && local && lib.compareSemver(latest, local) > 0),
      inFlight: currentUpdate,
      last: settings.lastUpdate,
    },
    autoUpdate: { ...settings.autoUpdate, state: settings.scheduleState, nextRunMs: lib.nextDailyRunMs(settings.autoUpdate?.time, Date.now()) },
    proxy: settings.proxy,
    paths: { srcDir: SRC_DIR, dataDir: DATA_DIR, staging: STAGING_DIR },
  };
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const routeKey = `${req.method} ${urlObj.pathname}`;

  // 鉴权（可选）：设了 PANEL_TOKEN 则所有 /api/* 校验
  if (PANEL_TOKEN && urlObj.pathname.startsWith("/api/")) {
    if (req.headers["x-panel-token"] !== PANEL_TOKEN) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
  }

  try {
    if (req.method === "GET" && urlObj.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderUi());
      return;
    }
    if (req.method === "GET" && urlObj.pathname === "/api/status") {
      sendJson(res, 200, await buildStatus());
      return;
    }
    if (req.method === "GET" && urlObj.pathname === "/api/update/check") {
      const settings = loadSettings();
      try {
        const latest = await fetchLatestVersion(settings.proxy?.url || "");
        const local = readLocalVersion();
        sendJson(res, 200, { localVersion: local, latestVersion: latest, updateAvailable: lib.compareSemver(latest, local) > 0 });
      } catch (e) {
        sendJson(res, 502, { error: `registry unreachable: ${e.message}` });
      }
      return;
    }
    if (req.method === "POST" && urlObj.pathname === "/api/update/run") {
      if (currentUpdate) { sendJson(res, 409, { error: "update already in progress", stage: currentUpdate.stage }); return; }
      // 目标版本一律由服务端解析 npm latest —— 不接受请求体指定版本。
      performUpdate({ trigger: "manual" })
        .then((r) => plog("update", `manual update finished: ${JSON.stringify(r)}`))
        .catch(() => {});
      sendJson(res, 202, { started: true });
      return;
    }
    if (req.method === "PUT" && urlObj.pathname === "/api/update/upload") {
      fs.mkdirSync(STAGING_DIR, { recursive: true });
      const dest = path.join(STAGING_DIR, `upload-${Date.now()}.bin`);
      let result;
      try {
        result = await streamUploadToFile(req, dest);
      } catch (e) {
        sendJson(res, 400, { error: e.message });
        return;
      }
      const stagedName = path.basename(dest).replace(/\.bin$/, `.${result.kind === "gzip" ? "tgz" : "zip"}`);
      fs.renameSync(dest, path.join(STAGING_DIR, stagedName));
      sendJson(res, 200, { file: stagedName, size: result.size, kind: result.kind });
      return;
    }
    if (req.method === "POST" && urlObj.pathname === "/api/install") {
      if (currentUpdate) { sendJson(res, 409, { error: "update already in progress" }); return; }
      const body = await readBody(req, 64 * 1024);
      const fileName = String(JSON.parse(body.toString() || "{}").file || "");
      const safe = path.basename(fileName);
      const staged = path.join(STAGING_DIR, safe);
      if (!safe.startsWith("upload-") || !fs.existsSync(staged)) {
        sendJson(res, 400, { error: "unknown staged file" });
        return;
      }
      installFromArchive(staged, "upload")
        .then((r) => plog("update", `install finished: ${JSON.stringify(r)}`))
        .catch(() => {});
      sendJson(res, 202, { started: true });
      return;
    }
    if (req.method === "POST" && urlObj.pathname === "/api/main/restart") {
      const r = await runMainCmd("restart");
      sendJson(res, r.ok ? 200 : 500, r);
      return;
    }
    if (req.method === "GET" && urlObj.pathname === "/api/logs") {
      sendJson(res, 200, tailLog(MAIN_LOG, Number(urlObj.searchParams.get("lines") || 400), urlObj.searchParams.get("filter") || ""));
      return;
    }
    if (req.method === "GET" && urlObj.pathname === "/api/panel-log") {
      sendJson(res, 200, tailLog(PANEL_LOG, Number(urlObj.searchParams.get("lines") || 200), urlObj.searchParams.get("filter") || ""));
      return;
    }
    if (req.method === "GET" && urlObj.pathname === "/api/settings") {
      sendJson(res, 200, loadSettings());
      return;
    }
    if (req.method === "POST" && urlObj.pathname === "/api/settings") {
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString() || "{}");
      const settings = loadSettings();
      if (body.autoUpdate) {
        const t = lib.parseHHmm(body.autoUpdate.time);
        if (!t) { sendJson(res, 400, { error: "time must be HH:mm" }); return; }
        settings.autoUpdate = { enabled: Boolean(body.autoUpdate.enabled), time: `${String(t.h).padStart(2, "0")}:${String(t.m).padStart(2, "0")}` };
      }
      if (body.proxy && typeof body.proxy.url === "string") {
        settings.proxy = { url: body.proxy.url.trim() };
      }
      saveSettings(settings);
      sendJson(res, 200, settings);
      return;
    }
    if (req.method === "GET" && urlObj.pathname === "/api/sudo") {
      sendJson(res, 200, await checkSudo());
      return;
    }
    sendJson(res, 404, { error: "not found" });
  } catch (e) {
    plog("http", `${routeKey} error: ${e.message}`);
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
  }
});

// 从（已魔数校验的）本机归档安装：解包 → 换名 → 重启 → 健康检查 → 失败回滚。
// 目标版本取自解包产物自身的 package.json —— 上传内容不可信。
async function installFromArchive(archivePath, trigger) {
  if (currentUpdate) throw new Error("update already in progress");
  const local = readLocalVersion();
  currentUpdate = { stage: "starting", trigger, from: local, to: null, startedAt: Date.now(), message: "" };
  let backupDir = null;
  try {
    const { extractDir, payload, payloadVersion } = await extractTarball(archivePath);
    if (!payloadVersion) throw new Error("payload has no version");
    currentUpdate.to = payloadVersion;
    setStage("swapping", `热覆盖 server 产物（${payloadVersion}）`);
    backupDir = await swapServerDir(payload, null);
    fs.rmSync(extractDir, { recursive: true, force: true });
    setStage("restarting", "重启主应用");
    await runMainCmd("restart");
    setStage("health-check", "等待健康检查");
    const healthy = await healthWait();
    // 与 performUpdate 同一核验：健康之外还要确认「跑起来的版本 = 产物版本」，
    // 否则升级后残留旧进程（构建不一致）也会被误判成功。
    const versionInfo = healthy ? await mainVersion() : null;
    if (!healthy || versionInfo?.currentVersion !== payloadVersion) {
      throw new Error(`version verify failed after install (healthy=${healthy}, currentVersion=${versionInfo?.currentVersion ?? "n/a"}, expected ${payloadVersion})`);
    }
    setStage("done", `已安装 ${payloadVersion}`);
    finishUpdate(true, `已安装 ${local || "?"} → ${payloadVersion}`);
    return { ok: true, to: payloadVersion };
  } catch (e) {
    plog("update", `install FAILED: ${e.message}`);
    if (backupDir) await rollback(backupDir);
    setStage("failed", e.message);
    finishUpdate(false, e.message);
    throw e;
  }
}

// 日志尾部读取：只取文件末尾 2MB 窗口再切行 —— 10router.log 跑几个月后
// 可能上百 MB，整读会把面板进程顶爆。
function tailLog(file, lines, filter) {
  let raw = "";
  let fileLargerThanWindow = false;
  try {
    const stat = fs.statSync(file);
    const windowBytes = Math.min(stat.size, 2 * 1024 * 1024);
    fileLargerThanWindow = stat.size > windowBytes;
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(windowBytes);
    fs.readSync(fd, buf, 0, windowBytes, stat.size - windowBytes);
    fs.closeSync(fd);
    raw = buf.toString("utf8");
  } catch {
    return { lines: [], truncated: false };
  }
  const all = raw.split("\n").filter((l) => l.length > 0);
  let picked = all.slice(-lines);
  if (filter) picked = picked.filter((l) => l.includes(filter));
  return { lines: picked, truncated: fileLargerThanWindow };
}

// sudo -n -l：非交互，未授权时直接失败。折行合并后提取 NOPASSWD 命令。
function checkSudo() {
  return new Promise((resolve) => {
    execFile("sudo", ["-n", "-l"], { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ authorized: false, commands: [], hint: String(stderr || err.message).slice(-400) });
        return;
      }
      resolve({ authorized: true, commands: lib.parseSudoList(stdout), hint: "" });
    });
  });
}

// ── UI（单文件内联，无外部依赖 —— NAS 可能拉不到 CDN）──
function renderUi() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>10Router · fnOS 管理面板</title>
<style>
  /* 日夜双主题：:root 亮色，html[data-theme=dark] 覆盖。跟随系统由内联脚本
     在绘制前解析（prefers-color-scheme），手动选择持久化 localStorage 覆盖。 */
  :root { --bg:#f6f4f0; --card:#ffffff; --line:#e4e2dd; --txt:#1c1c1e; --mut:#7a7f8a; --soft:#f0eee9; --ok:#1e9e63; --warn:#c07f14; --bad:#cf4436; --brand:#E56A4A; }
  html[data-theme="dark"] { --bg:#0f1115; --card:#1a1d23; --line:#2a2e37; --txt:#e8eaf0; --mut:#8b93a5; --soft:#12141a; --ok:#3fb27f; --warn:#d9a038; --bad:#e06c5f; }
  * { box-sizing:border-box; }
  body { margin:0; padding:24px; background:var(--bg); color:var(--txt); font:14px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif; }
  h1 { font-size:18px; margin:0 0 4px; } h2 { font-size:15px; margin:0 0 12px; }
  .mut { color:var(--mut); font-size:12px; }
  .top { max-width:880px; margin:0 auto; display:flex; align-items:center; gap:10px; }
  .top .spacer { flex:1; }
  #themeBtn { background:var(--card); border:1px solid var(--line); color:var(--txt); width:34px; height:34px; padding:0; font-size:16px; }
  .tabs { display:flex; gap:4px; max-width:880px; margin:14px auto 0; border-bottom:1px solid var(--line); }
  .tabs button { background:transparent; color:var(--mut); border:0; border-radius:8px 8px 0 0; padding:8px 16px; font-size:13px; border-bottom:2px solid transparent; }
  .tabs button.on { color:var(--brand); border-bottom-color:var(--brand); font-weight:600; }
  .grid { display:grid; gap:16px; max-width:880px; margin:16px auto; }
  .tabpane { display:none; } .tabpane.on { display:block; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px 18px; }
  .row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .pill { padding:2px 10px; border-radius:99px; font-size:12px; border:1px solid var(--line); }
  .ok { color:var(--ok); border-color:var(--ok); } .bad { color:var(--bad); border-color:var(--bad); } .warn { color:var(--warn); border-color:var(--warn); }
  button { background:var(--brand); color:#fff; border:0; border-radius:8px; padding:7px 14px; cursor:pointer; font-size:13px; }
  button.ghost { background:transparent; border:1px solid var(--line); color:var(--txt); }
  button.ghost:hover { border-color:var(--brand); color:var(--brand); }
  button:disabled { opacity:.5; cursor:not-allowed; }
  input, select { background:var(--soft); border:1px solid var(--line); color:var(--txt); border-radius:8px; padding:7px 10px; font-size:13px; }
  pre { background:var(--soft); border:1px solid var(--line); border-radius:8px; padding:10px; max-height:320px; overflow:auto; font-size:12px; white-space:pre-wrap; word-break:break-all; }
  .spacer { flex:1; }
  label.switch { display:inline-flex; align-items:center; gap:8px; cursor:pointer; }
</style></head><body>
<script>
/* 首帧主题解析（防闪烁）：localStorage 手动选择 > 系统偏好。 */
(function () {
  var t = null;
  try { t = localStorage.getItem("panelTheme"); } catch (e) {}
  if (t !== "light" && t !== "dark") {
    t = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  document.documentElement.setAttribute("data-theme", t);
})();
</script>
<div class="top">
  <div>
    <h1>10Router · fnOS 管理面板</h1>
    <div class="mut">独立于主应用运行；更新失败自动回滚。默认仅本机回环可访问。</div>
  </div>
  <span class="spacer"></span>
  <button id="themeBtn" onclick="toggleTheme()" title="切换日/夜主题">🌙</button>
</div>
<div class="tabs" id="tabs">
  <button data-tab="overview" class="on" onclick="switchTab('overview')">总览</button>
  <button data-tab="update" onclick="switchTab('update')">更新</button>
  <button data-tab="ops" onclick="switchTab('ops')">运维</button>
  <button data-tab="settings" onclick="switchTab('settings')">设置</button>
</div>
<div class="grid">

<div class="tabpane on" id="pane-overview">
  <div class="card"><h2>主应用状态</h2>
    <div class="row" id="mainStatus"><span class="mut">加载中…</span></div>
  </div>
  <div class="card" style="margin-top:16px"><h2>版本与更新</h2>
    <div class="row" id="versionRow"><span class="mut">加载中…</span></div>
    <div class="row" style="margin-top:10px">
      <span class="mut" id="updateMsg"></span>
    </div>
  </div>
  <div class="card" style="margin-top:16px"><h2>定时自动更新</h2>
    <div class="row">
      <label class="switch"><input type="checkbox" id="autoEnabled" onchange="saveAuto()"> <span>启用</span></label>
      <input type="time" id="autoTime" onchange="saveAuto()">
      <span class="mut" id="autoHint"></span>
    </div>
    <div class="mut" style="margin-top:8px">每日到点检查 npm latest → 排队更新 → 健康检查，失败 2h 后重试（当日最多 3 次），启动失败自动回滚上一版。</div>
  </div>
</div>

<div class="tabpane" id="pane-update">
  <div class="card"><h2>快速更新</h2>
    <div class="row">
      <button class="ghost" onclick="checkUpdate()">检查更新</button>
      <button id="btnUpdate" onclick="runUpdate()">一键更新到 latest</button>
      <span class="mut" id="updateMsgInline"></span>
    </div>
  </div>
  <div class="card" style="margin-top:16px"><h2>上传安装（离线通道）</h2>
    <div class="row">
      <input type="file" id="fileInput">
      <button class="ghost" onclick="uploadInstall()">上传安装</button>
    </div>
    <div class="mut" style="margin-top:8px">NAS 拉不到外网时：本机浏览器上传 tgz → 魔数校验 → 安装并重启。</div>
  </div>
  <div class="card" style="margin-top:16px"><h2>定时自动更新</h2>
    <div class="row">
      <label class="switch"><input type="checkbox" id="autoEnabled2" onchange="saveAuto()"> <span>启用</span></label>
      <input type="time" id="autoTime2" onchange="saveAuto()">
      <span class="mut" id="autoHint2"></span>
    </div>
  </div>
</div>

<div class="tabpane" id="pane-ops">
  <div class="card"><h2>服务操作</h2>
    <div class="row">
      <button class="ghost" onclick="restartMain()">重启主应用</button>
      <button class="ghost" onclick="checkSudo()">sudo 白名单检测</button>
    </div>
  </div>
  <div class="card" style="margin-top:16px"><h2>主应用日志</h2>
    <div class="row">
      <input id="logFilter" placeholder="日志关键字过滤" style="flex:1">
      <button class="ghost" onclick="loadLogs()">刷新</button>
    </div>
    <pre id="logBox" style="margin-top:10px">—</pre>
  </div>
</div>

<div class="tabpane" id="pane-settings">
  <div class="card"><h2>出站代理（面板自身）</h2>
    <div class="row">
      <input id="proxyUrl" placeholder="http://user:pass@host:port（留空直连）" style="flex:1">
      <button class="ghost" onclick="saveProxy()">保存</button>
    </div>
    <div class="mut" style="margin-top:8px">仅对面板自身的下载 / 版本检查生效（CONNECT 后已做 TLS 握手）；主应用的出站代理在主面板「设置」页配置。</div>
  </div>
</div>

</div>
<script>
const $ = (id) => document.getElementById(id);
const token = localStorage.getItem("panelToken") || "";
const headers = token ? { "x-panel-token": token } : {};
async function jget(u) { const r = await fetch(u, { headers }); if (r.status === 401) { const t = prompt("面板令牌 (PANEL_TOKEN)"); if (t) { localStorage.setItem("panelToken", t); location.reload(); } throw new Error("unauthorized"); } return r.json(); }
async function jpost(u, body) { const r = await fetch(u, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body || {}) }); return r.json(); }

/* ── 主题 ── */
function curTheme() { return document.documentElement.getAttribute("data-theme"); }
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  $("themeBtn").textContent = t === "dark" ? "☀️" : "🌙";
}
function toggleTheme() {
  const next = curTheme() === "dark" ? "light" : "dark";
  try { localStorage.setItem("panelTheme", next); } catch (e) {}
  applyTheme(next);
}
applyTheme(curTheme());

/* ── tabs ── */
function switchTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  document.querySelectorAll(".tabpane").forEach((p) => p.classList.toggle("on", p.id === "pane-" + name));
  try { localStorage.setItem("panelTab", name); } catch (e) {}
}
try { const saved = localStorage.getItem("panelTab"); if (saved) switchTab(saved); } catch (e) {}

function pill(ok, on, off) { return '<span class="pill ' + (ok ? "ok" : "bad") + '">' + (ok ? on : off) + "</span>"; }
function fmtUptime(s) { if (s == null) return ""; const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return (d ? d + "天" : "") + (h ? h + "小时" : "") + m + "分"; }
function updateMsgEverywhere(text) { $("updateMsg").textContent = text; $("updateMsgInline").textContent = text; }

async function refresh() {
  try {
    const s = await jget("/api/status");
    $("mainStatus").innerHTML =
      pill(s.main.running, "运行中 pid " + s.main.pid, "已停止") + " " +
      pill(s.main.healthy, "健康检查通过", "健康检查失败") +
      (s.main.staleBuild ? ' <span class="pill warn">构建不一致（需重启）</span>' : "") +
      '<span class="mut spacer"></span><span class="mut">版本 ' + (s.main.version || "?") + (s.main.uptimeSeconds != null ? " · 已运行 " + fmtUptime(s.main.uptimeSeconds) : "") + "</span>";
    $("versionRow").innerHTML =
      "本地 <b>" + (s.update.localVersion || "?") + "</b> · latest <b>" + (s.update.latestVersion || "未拉取") + "</b> " +
      (s.update.updateAvailable ? '<span class="pill warn">可更新</span>' : '<span class="pill ok">已是最新</span>') +
      (s.update.inFlight ? ' <span class="pill warn">更新进行中: ' + s.update.inFlight.stage + "</span>" : "");
    if (s.update.inFlight) $("btnUpdate").disabled = true; else $("btnUpdate").disabled = false;
    if (s.update.last && s.update.last.at) updateMsgEverywhere("上次: " + new Date(s.update.last.at).toLocaleString() + " " + (s.update.last.ok ? "✓" : "✗") + " " + s.update.last.message);
    for (const [en, et, eh] of [["autoEnabled", "autoTime", "autoHint"], ["autoEnabled2", "autoTime2", "autoHint2"]]) {
      $(en).checked = !!s.autoUpdate.enabled;
      $(et).value = s.autoUpdate.time || "04:30";
      $(eh).textContent = s.autoUpdate.enabled && s.autoUpdate.nextRunMs ? ("下次: " + new Date(s.autoUpdate.nextRunMs).toLocaleString()) : "";
    }
    $("proxyUrl").value = (s.proxy && s.proxy.url) || "";
    if (s.update.inFlight) setTimeout(refresh, 3000);
  } catch (e) { $("mainStatus").innerHTML = '<span class="mut">' + e.message + "</span>"; }
}
async function checkUpdate() { updateMsgEverywhere("检查中…"); const r = await jget("/api/update/check"); updateMsgEverywhere(r.error ? r.error : ("latest " + r.latestVersion + (r.updateAvailable ? "，可更新" : "，已是最新"))); refresh(); }
async function runUpdate() { $("btnUpdate").disabled = true; updateMsgEverywhere("已触发，进行中…"); await jpost("/api/update/run"); refresh(); }
async function uploadInstall() {
  const f = $("fileInput").files[0]; if (!f) { alert("先选择 tgz 文件"); return; }
  const r = await fetch("/api/update/upload", { method: "PUT", headers: { "content-type": "application/octet-stream", ...headers }, body: f });
  const j = await r.json();
  if (!r.ok) { alert("上传失败: " + (j.error || r.status)); return; }
  if (!confirm("已通过魔数校验（" + j.kind + "，" + Math.round(j.size / 1048576) + "MB）。安装并重启主应用？")) return;
  await jpost("/api/install", { file: j.file });
  updateMsgEverywhere("安装进行中…"); refresh();
}
async function saveAuto() { await jpost("/api/settings", { autoUpdate: { enabled: $("autoEnabled").checked, time: $("autoTime").value || "04:30" } }); refresh(); }
async function saveProxy() { await jpost("/api/settings", { proxy: { url: $("proxyUrl").value } }); updateMsgEverywhere("代理已保存"); }
async function restartMain() { if (!confirm("重启主应用？")) return; updateMsgEverywhere("重启中…"); await jpost("/api/main/restart"); refresh(); }
async function checkSudo() { const r = await jget("/api/sudo"); alert(r.authorized ? ("NOPASSWD 命令 " + r.commands.length + " 条:\\n" + r.commands.join("\\n")) : ("未检测到免密授权:\\n" + r.hint)); }
async function loadLogs() { const f = $("logFilter").value; const r = await jget("/api/logs?lines=400" + (f ? "&filter=" + encodeURIComponent(f) : "")); $("logBox").textContent = (r.truncated ? "…仅显示末尾\\n" : "") + (r.lines.join("\\n") || "—"); }
loadLogs(); refresh(); setInterval(refresh, 15 * 1000);
</script></body></html>`;
}

// ── 启动 ──
if (require.main === module) {
  server.listen(PANEL_PORT, PANEL_HOST, () => {
    plog("boot", `panel listening on ${PANEL_HOST}:${PANEL_PORT} (main :${MAIN_PORT}, src ${SRC_DIR})`);
    startScheduler();
  });
  process.on("SIGTERM", () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); });
  process.on("uncaughtException", (e) => plog("crash", `uncaught: ${e.stack || e.message}`));
}

module.exports = { server, loadSettings, saveSettings, performUpdate, installFromArchive, schedulerTick };
