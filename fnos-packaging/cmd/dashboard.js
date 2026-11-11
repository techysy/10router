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
const HEALTH_TIMEOUT_MS = 180 * 1000;
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
  autoUpdate: { enabled: false, freq: "daily", time: "04:30", weekday: 3 },
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

async function fetchLatestVersion(proxy, force = false) {
  const now = Date.now();
  if (!force && npmLatestCache.version && now - npmLatestCache.fetchedAt < NPM_CACHE_TTL_MS) {
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
    if (pid) {
      process.kill(pid, 0);
      return pid;
    }
  } catch {}
  // 端口自愈：pid 文件丢失/错位时，若端口有 node 监听且健康，自动定位并修复 pid 文件
  try {
    const { execFileSync } = require("child_process");
    const out = execFileSync("fuser", [`${MAIN_PORT}/tcp`], { encoding: "utf8", timeout: 1500 });
    const pids = out.trim().split(/\s+/).map(Number).filter(Boolean);
    if (pids.length > 0) {
      try { fs.writeFileSync(path.join(DATA_DIR, "10router.pid"), String(pids[0])); } catch {}
      return pids[0];
    }
  } catch {}
  return null;
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

// 重启主应用（用户点面板「重启」按钮的路径，2026-11-06 真机翻车后重写）：
// 旧实现同步跑 `cmd/main restart`——它内部走 appcenter-cli stop/start + 前台
// 60s 健康检查，在 fnOS 托管的应用上会把应用中心的状态机搅乱（status 卡
// "start"），窗口期内应用打不开；HTTP 请求还挂在 120s timeout 上。
// 新实现（dsh 同款，见 DeepSeek-Harness-fnos cmd/dashboard.js restartDsh）：
//   1) detached 子进程里 `sudo -n appcenter-cli stop+start`（生命周期正道，
//      状态机一致）；sudoers 未放行时回退 cmd/main restart。
//   2) 面板的 HTTP 响应立即返回「已触发」，不等重启完成——前端靠轮询
//      /api/status 观察恢复。
// 生命周期授权检测：`sudo -n appcenter-cli true` 探测 sudoers 是否放行。
// 结果缓存 10 分钟（每次重启按钮都探测会拖慢响应）。null = 未探测。
let lifecycleAuthCache = { value: null, at: 0 };

async function lifecycleAuthorized() {
  if (lifecycleAuthCache.value !== null && Date.now() - lifecycleAuthCache.at < 10 * 60 * 1000) {
    return lifecycleAuthCache.value;
  }
  const ok = await new Promise((resolve) => {
    execFile("sudo", ["-n", "/usr/local/bin/appcenter-cli", "check", APP_NAME], { timeout: 20000 }, (err, stdout, stderr) => {
      if (err) plog("ops", `lifecycle probe failed: ${String(err.code || err.message).slice(0, 80)} ${(stderr || "").slice(0, 60)}`);
      resolve(!err);
    });
  });
  lifecycleAuthCache = { value: ok, at: Date.now() };
  if (!ok) plog("ops", "lifecycle NOT authorized (sudoers); restart will fall back to internal mode");
  return ok;
}

function restartMainDetached() {
  const log = fs.openSync(path.join(DATA_DIR, "panel.log"), "a");
  const script =
    "AC=/usr/local/bin/appcenter-cli; " +
    'if sudo -n "$AC" stop 10router && sudo -n "$AC" start 10router; then echo "appcenter lifecycle ok"; ' +
    'else echo "appcenter not authorized, fallback to cmd/main restart"; bash "$1" restart; fi';
  const child = spawn("bash", ["-c", script, "10r-restart", MAIN_CMD], { detached: true, stdio: ["ignore", log, log] });
  child.unref();
  plog("ops", "main restart triggered (detached)");
  // 授权态在重启动作后失效——下次重新探测（sudoers 可能刚被管理员改过）
  lifecycleAuthCache = { value: null, at: 0 };
}

// ── 更新流水线 ──
// 状态机：null = 空闲；否则 { stage, trigger, from, to, startedAt, message }
let currentUpdate = null;

// stage/message 拆两层：stage 是英文枚举（UI 端 t("stage_" + stage) 翻译）；
// message 参数带 {key, args} 语义对，UI 端按当前语言渲染。plog 仍记中文供
// NAS 日志 grep（运维场景中文可读优先）。
function setStage(stage, message) {
  currentUpdate = { ...currentUpdate, stage, msg: message || currentUpdate?.msg || null };
  const human = message && message.args ? `${message.args.join(" ")}` : (typeof message === "string" ? message : "");
  plog("update", `${stage}: ${human}`, { trigger: currentUpdate?.trigger, from: currentUpdate?.from, to: currentUpdate?.to });
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
    setStage("downloading", { key: "dlAria", args: [targetVersion] });
    try {
      await downloadViaAria2(urlStr, dest, proxy || "");
      return dest;
    } catch (e) {
      plog("update", `aria2c failed, falling back to node: ${e.message}`);
      fs.rmSync(dest, { force: true });
    }
  }
  setStage("downloading", { key: "dlNode" });
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
  setStage("extracting", { key: "extracting", args: [kind] });
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
// 必须在 path.dirname(SRC_DIR) 同目录下操作，严禁硬编码 APP_DIR：
// 当 SRC_DIR 为 /var/apps/10router/target/server 时，target 可能是独立挂载点，
// 跨目录 rename 会触发 EXDEV: cross-device link not permitted。
async function swapServerDir(payload, expectedVersion) {
  const parentDir = path.dirname(SRC_DIR);
  const newDir = path.join(parentDir, "server.new");
  fs.rmSync(newDir, { recursive: true, force: true });
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
    const siblings = fs.readdirSync(parentDir)
      .filter((n) => n.startsWith(path.basename(SRC_DIR) + ".bak-") && n !== path.basename(backupDir));
    for (const n of siblings) fs.rmSync(path.join(parentDir, n), { recursive: true, force: true });
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
    setStage("checking", { key: "checking" });
    const target = await fetchLatestVersion(proxy, true);
    currentUpdate.to = target;
    const local = readLocalVersion();
    if (local && lib.compareSemver(target, local) <= 0) {
      const message = { key: "upToDateWith", args: [local || ""] };
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
    setStage("swapping", { key: "swapping" });
    backupDir = await swapServerDir(payload, target);
    fs.rmSync(extractDir, { recursive: true, force: true });

    setStage("restarting", { key: "restarting" });
    restartMainDetached();

    setStage("health-check", { key: "healthCheck" });
    const healthy = await healthWait();
    const versionInfo = healthy ? await mainVersion() : null;
    const landed = versionInfo && versionInfo.currentVersion === target;
    if (!healthy || !landed) {
      throw new Error(`health check failed after update (healthy=${healthy}, currentVersion=${versionInfo?.currentVersion ?? "n/a"}, expected ${target})`);
    }

    setStage("done", { key: "updatedTo", args: [local || "?", target] });
    finishUpdate(true, { key: "updatedTo", args: [local || "?", target] });
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
    message,           // {key, args} 语义对 —— UI 端按当前语言渲染
  };
  saveSettings(settings);
  currentUpdate = null;
}

// ── 定时调度（30s tick；面板重启后错过的当日窗口补跑一次）──
let schedulerTimer = null;

async function schedulerTick() {
  let settings;
  try { settings = loadSettings(); } catch { return; }
  const { enabled } = settings.autoUpdate || {};
  if (!enabled) return;
  const now = Date.now();
  const today = lib.dateKey(now);
  const state = settings.scheduleState || {};

  // 当日重试配额用尽则不再触发
  if (state.attemptsDateKey === today && state.attempts >= MAX_ATTEMPTS_PER_DAY) return;

  const scheduledDue = lib.shouldRunSchedule(settings.autoUpdate || {}, now, state.lastRunAtMs);
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
      running: Boolean(pid || healthy),
      pid: pid || (healthy ? "active" : null),
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
    autoUpdate: { ...settings.autoUpdate, state: settings.scheduleState, nextRunMs: lib.nextScheduleRunMs(settings.autoUpdate || {}, Date.now()) },
    proxy: settings.proxy,
    lifecycle: { authorized: await lifecycleAuthorized() },
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
        const latest = await fetchLatestVersion(settings.proxy?.url || "", true);
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
      // detached：立即响应，前端靠 15s 轮询 /api/status 观察重启完成
      restartMainDetached();
      sendJson(res, 202, { started: true });
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
        const norm = lib.normalizeSchedule(body.autoUpdate);
        settings.autoUpdate = {
          enabled: Boolean(body.autoUpdate.enabled),
          freq: norm.freq,
          time: `${String(t.h).padStart(2, "0")}:${String(t.m).padStart(2, "0")}`,
          weekday: norm.weekday === null ? 3 : norm.weekday,
        };
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
    setStage("swapping", { key: "swapping", args: [payloadVersion] });
    backupDir = await swapServerDir(payload, null);
    fs.rmSync(extractDir, { recursive: true, force: true });
    setStage("restarting", { key: "restarting" });
    restartMainDetached();
    setStage("health-check", { key: "healthCheck" });
    const healthy = await healthWait();
    // 与 performUpdate 同一核验：健康之外还要确认「跑起来的版本 = 产物版本」，
    // 否则升级后残留旧进程（构建不一致）也会被误判成功。
    const versionInfo = healthy ? await mainVersion() : null;
    if (!healthy || versionInfo?.currentVersion !== payloadVersion) {
      throw new Error(`version verify failed after install (healthy=${healthy}, currentVersion=${versionInfo?.currentVersion ?? "n/a"}, expected ${payloadVersion})`);
    }
    setStage("done", { key: "installedTo", args: [payloadVersion] });
    finishUpdate(true, { key: "installedTo", args: [local || "?", payloadVersion] });
    return { ok: true, to: payloadVersion };
  } catch (e) {
    plog("update", `install FAILED: ${e.message}`);
    if (backupDir) await rollback(backupDir);
    setStage("failed", e.message);
    finishUpdate(false, e.message);
    throw e;
  }
}

// 排除高频模型调用流水行（POST / DONE / RTK / COMBO 尝试等），仅保留系统与鉴权日志
function isCallFlowLog(line) {
  return /▶\s*POST\s|📊\s*DONE\s|\[RTK\]\s*saved|\[CHAT\]\s*Combo|\[COMBO\]\s*(?:Trying|Model.*succeeded)/i.test(line);
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
  let all = raw.split("\n").filter((l) => l.length > 0);
  // 面板日志仅展示系统级事件，剔除模型调用流水噪音
  all = all.filter((l) => !isCallFlowLog(l));
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
  #themeBtn, #langBtn, #ghBtn { background:var(--card); border:1px solid var(--line); color:var(--txt); width:34px; height:34px; padding:0; font-size:16px; display:inline-flex; align-items:center; justify-content:center; }
  #langBtn { font-size:12px; font-weight:700; }
  /* 胶囊分段控件（dsh 同款 seg-ctl）：浅灰槽 + 激活项浮起白底 */
  .tabs { display:inline-flex; gap:2px; padding:2px; border-radius:9px; background:var(--soft); margin:14px 0 0; }
  /* 分段胶囊组（tabs 同语言）：频率与周几选择 */
  .seg { display:inline-flex; gap:2px; padding:2px; border-radius:9px; background:var(--soft); }
  .seg button { border:none; background:transparent; color:var(--mut); font-size:12px; font-weight:600; padding:4px 12px; border-radius:7px; cursor:pointer; transition:background .15s ease, color .15s ease; }
  .seg button.on { background:var(--card); color:var(--txt); box-shadow:0 1px 3px rgba(0,0,0,.08); }
  html[data-theme="dark"] .seg button.on { background:rgba(255,255,255,.1); }
  .seg.seg-sm button { padding:3px 8px; font-size:11px; }
  /* time 输入：毛玻璃卡语言（soft 底、圆角、无边框突兀感） */
  input[type="time"] { background:var(--soft); border:1px solid var(--line); color:var(--txt); border-radius:9px; padding:6px 12px; font-size:13px; font-weight:600; }
  input[type="time"]::-webkit-calendar-picker-indicator { filter:var(--picker-filter, none); cursor:pointer; }
  html[data-theme="dark"] { --picker-filter: invert(1) opacity(.7); }
  .tabs button { border:none; background:transparent; color:var(--mut); font-size:12px; font-weight:600; padding:4px 14px; border-radius:7px; cursor:pointer; }
  .tabs button.on { background:var(--card); color:var(--txt); box-shadow:0 1px 3px rgba(0,0,0,.08); }
  html[data-theme="dark"] .tabs button.on { background:rgba(255,255,255,.1); }
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
  /* toast（dsh 同款右上角浮层） */
  #toasts { position:fixed; top:16px; right:16px; z-index:1000; display:flex; flex-direction:column; gap:8px; }
  .toast { background:var(--card); border:1px solid var(--line); border-left:3px solid var(--brand); border-radius:8px; padding:9px 14px; font-size:13px; box-shadow:0 4px 16px rgba(0,0,0,.15); max-width:340px; animation:tIn .18s ease; }
  .toast.ok { border-left-color:var(--ok); } .toast.warn { border-left-color:var(--warn); } .toast.bad { border-left-color:var(--bad); }
  @keyframes tIn { from { opacity:0; transform:translateY(-6px); } to { opacity:1; transform:none; } }
  /* modal（confirm/prompt 的本地替代） */
  #modalMask { position:fixed; inset:0; background:rgba(0,0,0,.4); z-index:900; display:none; align-items:center; justify-content:center; }
  #modalMask.on { display:flex; }
  .modal { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px 20px; width:min(92vw,380px); box-shadow:0 12px 40px rgba(0,0,0,.25); }
  .modal h3 { margin:0 0 8px; font-size:14px; }
  .modal p { margin:0 0 14px; font-size:13px; color:var(--txt); white-space:pre-wrap; word-break:break-all; }
  .modal input { width:100%; margin-bottom:14px; }
  .modal .row { justify-content:flex-end; gap:8px; }
  /* 授权卡片（dsh sudo-card 同款语义） */
  .auth-card { border:1px solid var(--warn); background:color-mix(in srgb, var(--warn) 7%, var(--card)); border-radius:10px; padding:12px 14px; margin-top:10px; }
  .auth-card.ok { border-color:var(--ok); background:color-mix(in srgb, var(--ok) 7%, var(--card)); }
  .auth-card .steps { font-size:12px; color:var(--mut); white-space:pre-wrap; margin:6px 0; }
  .auth-cmd { background:var(--soft); border:1px solid var(--line); border-radius:8px; padding:8px 10px; font:12px/1.5 ui-monospace,monospace; word-break:break-all; display:flex; gap:8px; align-items:flex-start; }
  .auth-cmd code { flex:1; white-space:pre-wrap; word-break:break-all; }
  .auth-cmd button { padding:2px 8px; font-size:11px; flex-shrink:0; }
  /* 文件选择：原生 input 隐藏，样式化胶囊按钮承接 */
  /* 胶囊开关（主应用 Toggle 同款语义）：轨道 44x24，白球 20，选中 brand 填充 */
  .switch { position:relative; display:inline-flex; align-items:center; gap:8px; cursor:pointer; }
  .switch input { position:absolute; opacity:0; width:0; height:0; }
  .switch .track { width:44px; height:24px; border-radius:999px; background:var(--soft); border:1px solid var(--line); transition:background .2s ease, border-color .2s ease; position:relative; flex-shrink:0; }
  .switch .thumb { position:absolute; top:1px; left:1px; width:20px; height:20px; border-radius:999px; background:#fff; box-shadow:0 1px 3px rgba(0,0,0,.25); transition:transform .2s ease; }
  .switch input:checked + .track { background:var(--brand); border-color:var(--brand); }
  .switch input:checked + .track .thumb { transform:translateX(20px); }
  .switch input:focus-visible + .track { outline:2px solid var(--brand); outline-offset:2px; }
  .file-pill { position:relative; overflow:hidden; display:inline-flex; align-items:center; gap:6px; }
  .file-pill input[type=file] { position:absolute; inset:0; opacity:0; cursor:pointer; }
  .file-name { font-size:12px; color:var(--mut); max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
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
<div id="toasts"></div>
<div id="modalMask"><div class="modal"><h3 id="modalTitle"></h3><p id="modalMsg"></p><input id="modalInput" style="display:none"><div class="row"><button class="ghost" id="modalCancel">取消</button><button id="modalOk">确定</button></div></div></div>
<div class="top">
  <div>
    <h1 id="h1Title">10Router · fnOS 管理面板</h1>
    <div class="mut" id="subTitle">独立于主应用运行；更新失败自动回滚。默认仅本机回环可访问。</div>
  </div>
  <span class="spacer"></span>
  <button id="ghBtn" onclick="window.open('https://github.com/techysy/10router', '_blank')" title="GitHub" aria-label="GitHub"><svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55 0-.27-.01-1.17-.02-2.12-3.2.7-3.88-1.36-3.88-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.75 2.69 1.25 3.34.95.1-.75.4-1.25.72-1.54-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.46.11-3.05 0 0 .96-.31 3.15 1.18a10.9 10.9 0 0 1 2.87-.39c.97 0 1.95.13 2.87.39 2.19-1.49 3.15-1.18 3.15-1.18.62 1.59.23 2.76.11 3.05.73.81 1.18 1.83 1.18 3.09 0 4.41-2.69 5.38-5.25 5.67.41.35.77 1.04.77 2.1 0 1.52-.01 2.74-.01 3.11 0 .3.2.66.8.55A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z"/></svg></button>
  <button id="langBtn" onclick="toggleLang()" title="Language">EN</button>
  <button id="themeBtn" onclick="toggleTheme()" title="切换日/夜主题" aria-label="切换日/夜主题"><svg id="themeIcon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></svg></button>
</div>
<div style="max-width:880px;margin:0 auto"><div class="tabs" id="tabs">
  <button data-tab="overview" class="on" onclick="switchTab('overview')">总览</button>
  <button data-tab="ops" onclick="switchTab('ops')">运维</button>
  <button data-tab="settings" onclick="switchTab('settings')">设置</button>
</div></div>
<div class="grid">

<div class="tabpane on" id="pane-overview">
  <div class="card"><h2 data-i18n="mainStatus"></h2>
    <div class="row" id="mainStatus"><span class="mut" data-i18n="loading">加载中…</span></div>
  </div>

  <div class="card" style="margin-top:16px"><h2 data-i18n="versionCard"></h2>
    <div class="row" id="versionRow"><span class="mut" data-i18n="loading">加载中…</span></div>
    <div class="row" style="margin-top:12px;gap:8px">
      <button class="ghost" onclick="checkUpdate()" data-i18n="checkUpdate">检查更新</button>
      <button id="btnUpdate" onclick="runUpdate()" data-i18n="btnUpdate">一键更新到 latest</button>
    </div>
    <div class="row" style="margin-top:10px">
      <span class="mut" id="updateMsg"></span>
    </div>
  </div>

  <div class="card" style="margin-top:16px"><h2 data-i18n="autoCard"></h2>
    <div class="row">
      <label class="switch"><input type="checkbox" id="autoEnabled" onchange="saveAuto()"><span class="track"><span class="thumb"></span></span> <span data-i18n="autoEnable">启用</span></label>
      <span class="seg" id="autoFreq">
        <button type="button" data-v="daily" data-i18n="freqDaily" onclick="setFreq('autoFreq','daily')">每天</button>
        <button type="button" data-v="weekly" data-i18n="freqWeekly" onclick="setFreq('autoFreq','weekly')">每周</button>
      </span>
      <span id="autoWeekdayWrap" style="display:none"><span class="seg seg-sm" id="autoWeekday">
        <button type="button" data-v="1" data-i18n="wd1" onclick="setWeekday('autoWeekday',1)">周一</button>
        <button type="button" data-v="2" data-i18n="wd2" onclick="setWeekday('autoWeekday',2)">周二</button>
        <button type="button" data-v="3" data-i18n="wd3" onclick="setWeekday('autoWeekday',3)">周三</button>
        <button type="button" data-v="4" data-i18n="wd4" onclick="setWeekday('autoWeekday',4)">周四</button>
        <button type="button" data-v="5" data-i18n="wd5" onclick="setWeekday('autoWeekday',5)">周五</button>
        <button type="button" data-v="6" data-i18n="wd6" onclick="setWeekday('autoWeekday',6)">周六</button>
        <button type="button" data-v="0" data-i18n="wd0" onclick="setWeekday('autoWeekday',0)">周日</button>
      </span></span>
      <input type="time" id="autoTime" onchange="saveAuto()">
    </div>
    <div class="row" style="margin-top:6px"><span class="mut" id="autoHint"></span></div>
    <div class="mut" style="margin-top:8px" data-i18n="autoHint">到点检查 npm latest → 排队更新 → 健康检查，失败 2h 后重试（当日最多 3 次），启动失败自动回滚上一版。</div>
  </div>

  <div class="card" style="margin-top:16px"><h2 data-i18n="uploadCard"></h2>
    <div class="row">
      <span class="file-pill ghost"><span data-i18n="pickFile">选择 tgz</span><input type="file" id="fileInput" accept=".tgz,.gz" onchange="onFilePick()"></span>
      <span class="file-name" id="fileName" data-i18n-default="noFile">未选择文件</span>
      <button class="ghost" onclick="uploadInstall()" data-i18n="uploadBtn">上传安装</button>
    </div>
    <div class="mut" style="margin-top:8px" data-i18n="uploadHint">NAS 拉不到外网时：本机浏览器上传 tgz → 魔数校验 → 安装并重启。</div>
  </div>
</div>

<div class="tabpane" id="pane-ops">
  <div class="card"><h2 data-i18n="opsCard"></h2>
    <div class="row">
      <button class="ghost" onclick="restartMain()" data-i18n="restartBtn">重启主应用</button>
    </div>
    <div id="authBox" style="margin-top:10px"></div>
  </div>
  <div class="card" style="margin-top:16px"><h2 data-i18n="logsCard"></h2>
    <div class="row">
      <input id="logFilter" data-i18n-ph="logPh" placeholder="日志关键字过滤" style="flex:1">
      <button class="ghost" onclick="loadLogs()" data-i18n="refresh">刷新</button>
    </div>
    <pre id="logBox" style="margin-top:10px">—</pre>
  </div>
</div>

<div class="tabpane" id="pane-settings">
  <div class="card"><h2 data-i18n="proxyCard"></h2>
    <div class="row">
      <input id="proxyUrl" data-i18n-ph="proxyPh" placeholder="http://user:pass@host:port（留空直连）" style="flex:1">
      <button class="ghost" onclick="saveProxy()" data-i18n="save">保存</button>
    </div>
    <div class="mut" style="margin-top:8px" data-i18n="proxyHint">仅对面板自身的下载 / 版本检查生效（CONNECT 后已做 TLS 握手）；主应用的出站代理在主面板「设置」页配置。</div>
  </div>
</div>

</div>
<script>
const $ = (id) => document.getElementById(id);
/* ── i18n：zh / en 双语，localStorage 持久化；t() 取串，缺 key 回落 zh ── */
const I18N = {
  zh: {
    title: "10Router · fnOS 管理面板",
    subtitle: "独立于主应用运行；更新失败自动回滚。默认仅本机回环可访问。",
    tabOverview: "总览", tabOps: "运维", tabSettings: "设置",
    themeTitle: "切换日/夜主题", ghTitle: "GitHub",
    mainStatus: "主应用状态", versionCard: "版本与更新", autoCard: "定时自动更新",
    loading: "加载中…", running: "运行中 pid", stopped: "已停止",
    healthy: "健康检查通过", unhealthy: "健康检查失败", stale: "构建不一致（需重启）",
    ver: "版本", uptime: "已运行", day: "天", hour: "小时", min: "分",
    local: "本地", latest: "latest", upToDate: "已是最新", updatable: "可更新",
    inFlight: "更新进行中: ", last: "上次: ",
    autoEnable: "启用", freqDaily: "每天", freqWeekly: "每周",
    weekdayNames: ["周日", "周一", "周二", "周三", "周四", "周五", "周六"],
    next: "下次: ", every: "每天", everyWeek: "每周",
    wd0: "周日", wd1: "周一", wd2: "周二", wd3: "周三", wd4: "周四", wd5: "周五", wd6: "周六",
    autoHint: "到点检查 npm latest → 排队更新 → 健康检查，失败 2h 后重试（当日最多 3 次），启动失败自动回滚上一版。",
    quickUpdate: "快速更新", checkUpdate: "检查更新", btnUpdate: "一键更新到 latest",
    uploadCard: "上传安装（离线通道）", pickFile: "选择 tgz", noFile: "未选择文件",
    uploadBtn: "上传安装", uploadHint: "NAS 拉不到外网时：本机浏览器上传 tgz → 魔数校验 → 安装并重启。",
    opsCard: "服务操作", restartBtn: "重启主应用",
    logsCard: "主应用日志", logPh: "日志关键字过滤", refresh: "刷新",
    proxyCard: "出站代理（面板自身）", proxyPh: "http://user:pass@host:port（留空直连）", save: "保存",
    proxyHint: "仅对面板自身的下载 / 版本检查生效（CONNECT 后已做 TLS 握手）；主应用的出站代理在主面板「设置」页配置。",
    authOk: "已授权", authOkDesc: "重启走应用生命周期（appcenter-cli stop+start，状态机一致）",
    authNo: "未授权", authNoDesc: "重启将回退内部模式（kill+nohup），应用中心状态可能短暂不同步。放行一次即永久生效：",
    authSteps: "1. SSH 登录 NAS（管理员账号）\\n2. 复制下方命令执行\\n3. 点「重新检测」",
    copy: "复制", recheck: "重新检测",
    saved: "定时更新已保存", proxySaved: "出站代理已保存", copied: "已复制到剪贴板",
    stage_starting: "准备中", stage_checking: "检查 npm latest", stage_downloading: "下载中",
    stage_extracting: "解包", stage_swapping: "热覆盖 server 产物", stage_restarting: "重启主应用",
    stage_health: "健康检查", stage_done: "完成", stage_failed: "失败",
    dlAria: "aria2c 分段下载 {0}", dlNode: "Node 原生下载",
    extracting: "解包（{0}）", swapping: "热覆盖 server 产物{1}",
    restarting: "重启主应用", healthCheck: "等待健康检查",
    upToDateWith: "已是最新（{0}）", updatedTo: "已更新 {0} → {1}", installedTo: "已安装 {0} → {1}",
    restartSent: "重启指令已发送…", pickFirst: "先选择 tgz 文件", uploading: "上传中… 正在写入 NAS",
    installSent: "安装指令已下发，约 20 秒后刷新观察", checking: "检查中…",
    confirmRestartT: "确认重启", confirmRestartM: "将通过应用生命周期（appcenter-cli stop+start）重启主应用，约 1 分钟内恢复。未授权时回退内部重启。",
    tokenT: "需要面板令牌", tokenM: "服务端设置了 PANEL_TOKEN，输入后本机记住。",
    langBtn: "EN",
  },
  en: {
    title: "10Router · fnOS Panel",
    subtitle: "Runs independently of the main app; failed updates roll back automatically. Loopback-only by default.",
    tabOverview: "Overview", tabOps: "Ops", tabSettings: "Settings",
    themeTitle: "Toggle light/dark theme", ghTitle: "GitHub",
    mainStatus: "Main app status", versionCard: "Version & update", autoCard: "Scheduled auto-update",
    loading: "Loading…", running: "Running pid", stopped: "Stopped",
    healthy: "Health check OK", unhealthy: "Health check failed", stale: "Build mismatch (restart needed)",
    ver: "ver", uptime: "up ", day: "d", hour: "h", min: "m",
    local: "Local", latest: "latest", upToDate: "Up to date", updatable: "Update available",
    inFlight: "Update in progress: ", last: "Last: ",
    autoEnable: "Enable", freqDaily: "Daily", freqWeekly: "Weekly",
    weekdayNames: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    next: "Next: ", every: "Daily", everyWeek: "Weekly ",
    wd0: "Sun", wd1: "Mon", wd2: "Tue", wd3: "Wed", wd4: "Thu", wd5: "Fri", wd6: "Sat",
    autoHint: "Checks npm latest at the scheduled time → queues the update → health check. Retries every 2h on failure (max 3/day), rolls back to the previous build if startup fails.",
    quickUpdate: "Quick update", checkUpdate: "Check update", btnUpdate: "Update to latest",
    uploadCard: "Upload install (offline)", pickFile: "Pick tgz", noFile: "No file selected",
    uploadBtn: "Upload & install", uploadHint: "When the NAS cannot reach the internet: upload the tgz from your browser → magic check → install & restart.",
    opsCard: "Service ops", restartBtn: "Restart main app",
    logsCard: "Main app logs", logPh: "Filter logs by keyword", refresh: "Refresh",
    proxyCard: "Outbound proxy (panel only)", proxyPh: "http://user:pass@host:port (empty = direct)", save: "Save",
    proxyHint: "Applies only to the panel's own downloads / version checks (TLS handshake done after CONNECT); the main app's proxy is configured in the main dashboard's Settings page.",
    authOk: "Authorized", authOkDesc: "Restarts go through the app lifecycle (appcenter-cli stop+start, state machine stays in sync)",
    authNo: "Not authorized", authNoDesc: "Restart falls back to internal mode (kill+nohup); App Center state may briefly desync. Grant once — it persists:",
    authSteps: "1. SSH into the NAS (admin)\\n2. Run the command below\\n3. Click Re-check",
    copy: "Copy", recheck: "Re-check",
    saved: "Auto-update saved", proxySaved: "Proxy saved", copied: "Copied to clipboard",
    stage_starting: "Preparing", stage_checking: "Checking npm latest", stage_downloading: "Downloading",
    stage_extracting: "Extracting", stage_swapping: "Overlaying server build", stage_restarting: "Restarting main app",
    stage_health: "Health check", stage_done: "Done", stage_failed: "Failed",
    dlAria: "aria2c segmented download {0}", dlNode: "Node native download",
    extracting: "Extracting ({0})", swapping: "Overlaying server build{1}",
    restarting: "Restarting main app", healthCheck: "Waiting for health check",
    upToDateWith: "Already latest ({0})", updatedTo: "Updated {0} → {1}", installedTo: "Installed {0} → {1}",
    restartSent: "Restart command sent…", pickFirst: "Pick a tgz file first", uploading: "Uploading… writing to NAS",
    installSent: "Install dispatched — refresh in ~20s", checking: "Checking…",
    confirmRestartT: "Confirm restart", confirmRestartM: "Restarts the main app via the app lifecycle (appcenter-cli stop+start); back within ~1 min. Falls back to internal restart when unauthorized.",
    tokenT: "Panel token required", tokenM: "The server has PANEL_TOKEN set; enter it once and it stays on this device.",
    langBtn: "中",
  },
};
let LANG = (() => { try { const v = localStorage.getItem("panelLang"); if (v === "en" || v === "zh") return v; } catch {} return (navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en"; })();
function t(key) { const d = I18N[LANG] || I18N.zh; const v = d[key] !== undefined ? d[key] : I18N.zh[key]; return v === undefined ? key : v; }
function toggleLang() {
  LANG = LANG === "zh" ? "en" : "zh";
  try { localStorage.setItem("panelLang", LANG); } catch {}
  applyLang();
}
function applyLang() {
  document.documentElement.lang = LANG === "zh" ? "zh-CN" : "en";
  document.title = t("title");
  $("h1Title").textContent = t("title");
  $("subTitle").textContent = t("subtitle");
  $("themeBtn").title = t("themeTitle"); $("themeBtn").setAttribute("aria-label", t("themeTitle"));
  $("ghBtn").title = t("ghTitle"); $("ghBtn").setAttribute("aria-label", t("ghTitle"));
  $("langBtn").textContent = t("langBtn");
  document.querySelectorAll(".tabs button").forEach((b) => { b.textContent = t("tab" + b.dataset.tab[0].toUpperCase() + b.dataset.tab.slice(1)); });
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  applyTheme(curTheme());
  loadLogs();
}
const token = localStorage.getItem("panelToken") || "";
const headers = token ? { "x-panel-token": token } : {};
async function jget(u) {
  const r = await fetch(u, { headers });
  if (r.status === 401) {
    const t = await localModal({ title: t("tokenT"), msg: t("tokenM"), input: "" });
    if (t) { localStorage.setItem("panelToken", t); location.reload(); }
    throw new Error("unauthorized");
  }
  return r.json();
}
async function jpost(u, body) { const r = await fetch(u, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body || {}) }); return r.json(); }

/* ── toast / modal / 授权卡片 ── */
function toast(msg, kind) {
  const box = document.createElement("div");
  box.className = "toast " + (kind || "");
  box.textContent = msg;
  $("toasts").appendChild(box);
  setTimeout(() => box.remove(), kind === "bad" ? 6000 : 3200);
}
let modalState = null;
function localModal({ title, msg, input = null, okText = "确定", danger = false }) {
  return new Promise((resolve) => {
    modalState = { resolve };
    $("modalTitle").textContent = title;
    $("modalMsg").textContent = msg || "";
    $("modalMsg").style.display = msg ? "" : "none";
    $("modalInput").style.display = input === null ? "none" : "";
    $("modalInput").value = input === null ? "" : input;
    $("modalOk").textContent = okText;
    $("modalOk").style.background = danger ? "var(--bad)" : "var(--brand)";
    $("modalMask").classList.add("on");
    if (input !== null) { $("modalInput").focus(); $("modalInput").select(); }
  });
}
function modalDone(val) {
  if (!modalState) return;
  $("modalMask").classList.remove("on");
  const r = modalState.resolve; modalState = null;
  r(val);
}
$("modalOk").onclick = () => modalDone($("modalInput").style.display === "none" ? true : $("modalInput").value);
$("modalCancel").onclick = () => modalDone(null);
$("modalMask").onclick = (e) => { if (e.target.id === "modalMask") modalDone(null); };
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && modalState) modalDone(null); });
function localAlert(msg, kind) { toast(msg, kind || ""); }
function localConfirm(title, msg, danger) { return localModal({ title, msg, okText: "确定", danger: !!danger }); }
async function copyText(text, btn) {
  try { await navigator.clipboard.writeText(text); }
  catch { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); }
  if (btn) { const old = btn.textContent; btn.textContent = "已复制"; setTimeout(() => (btn.textContent = old), 1500); }
  toast("已复制到剪贴板", "ok");
}

/* ── 主题 ── */
function curTheme() { return document.documentElement.getAttribute("data-theme"); }
const THEME_ICON_PATHS = {
  // 月亮（暗色态显示，点击回亮色）：crescent
  dark: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>',
  // 太阳（亮色态显示，点击回暗色）：circle + 8 rays
  light: '<circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"></path>',
};
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  $("themeIcon").innerHTML = THEME_ICON_PATHS[t] || THEME_ICON_PATHS.light;
}
function toggleTheme() {
  const next = curTheme() === "dark" ? "light" : "dark";
  try { localStorage.setItem("panelTheme", next); } catch (e) {}
  applyTheme(next);
}
applyTheme(curTheme());
applyLang();

/* ── seg 胶囊组 helpers ── */
function markSeg(id, val) {
  document.querySelectorAll("#" + id + " button").forEach((b) => b.classList.toggle("on", b.dataset.v === String(val)));
}
function segValue(id) {
  const on = document.querySelector("#" + id + " button.on");
  return on ? on.dataset.v : "daily";
}
function setFreq(id, val) { markSeg(id, val); saveAuto(); }
function setWeekday(id, val) { markSeg(id, val); saveAuto(); }

/* ── tabs ── */
function switchTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  document.querySelectorAll(".tabpane").forEach((p) => p.classList.toggle("on", p.id === "pane-" + name));
  try { localStorage.setItem("panelTab", name); } catch (e) {}
}
try { const saved = localStorage.getItem("panelTab"); if (saved) switchTab(saved); } catch (e) {}

function pill(ok, on, off) { return '<span class="pill ' + (ok ? "ok" : "bad") + '">' + (ok ? on : off) + "</span>"; }
function fmtUptime(s) { if (s == null) return ""; const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return (d ? d + t("day") : "") + (h ? h + t("hour") : "") + m + t("min"); }
function updateMsgEverywhere(text) { const el = $("updateMsg"); if (el) el.textContent = text; }
// {key, args} 语义对 → 当前语言文案；纯字符串原样返回（含服务端错误文本）
function tMsg(m) {
  if (!m) return "";
  if (typeof m === "string") return m;
  let s = t(m.key);
  (m.args || []).forEach((a, i) => { s = s.split("{" + i + "}").join(a); });
  return s;
}
// 更新卡片 inFlight 行：stage 枚举翻译 + msg 翻译
function inFlightText(u) { return t("stage_" + u.stage) + (u.msg ? " · " + tMsg(u.msg) : ""); }
// lastUpdate 行：ok → tMsg(message)；fail → 原始错误串
function lastUpdateText(lu) {
  return t("last") + new Date(lu.at).toLocaleString() + " " + (lu.ok ? "✓" : "✗") + " " + tMsg(lu.message);
}

async function refresh() {
  try {
    const s = await jget("/api/status");
    $("mainStatus").innerHTML =
      pill(s.main.running, t("running") + " " + s.main.pid, t("stopped")) + " " +
      pill(s.main.healthy, t("healthy"), t("unhealthy")) +
      (s.main.staleBuild ? ' <span class="pill warn">' + t("stale") + "</span>" : "") +
      '<span class="mut spacer"></span><span class="mut">' + t("ver") + ' ' + (s.main.version || "?") + (s.main.uptimeSeconds != null ? " · " + t("uptime") + fmtUptime(s.main.uptimeSeconds) : "") + "</span>";
    $("versionRow").innerHTML =
      t("local") + " <b>" + (s.update.localVersion || "?") + "</b> · latest <b>" + (s.update.latestVersion || "—") + "</b> " +
      (s.update.updateAvailable ? '<span class="pill warn">' + t("updatable") + "</span>" : '<span class="pill ok">' + t("upToDate") + "</span>") +
      (s.update.inFlight ? ' <span class="pill warn">' + inFlightText(s.update.inFlight) + "</span>" : "");
    if (s.update.inFlight) $("btnUpdate").disabled = true; else $("btnUpdate").disabled = false;
    if (s.update.last && s.update.last.at) updateMsgEverywhere(lastUpdateText(s.update.last));

    $("autoEnabled").checked = !!s.autoUpdate.enabled;
    const freq = s.autoUpdate.freq || "daily";
    const wd = String(s.autoUpdate.weekday ?? 3);
    markSeg("autoFreq", freq);
    markSeg("autoWeekday", wd);
    $("autoWeekdayWrap").style.display = (freq === "weekly") ? "" : "none";
    $("autoTime").value = s.autoUpdate.time || "04:30";
    const NEXT_WORD = t("weekdayNames");
    const freqWord = freq === "weekly" ? (t("everyWeek") + (NEXT_WORD[Number(wd)] || "")) : t("every");
    $("autoHint").textContent = s.autoUpdate.enabled && s.autoUpdate.nextRunMs ? (freqWord + " " + new Date(s.autoUpdate.nextRunMs).toLocaleString()) : "";

    $("proxyUrl").value = (s.proxy && s.proxy.url) || "";
    renderAuth(s.lifecycle || { authorized: false });
    if (s.update.inFlight) setTimeout(refresh, 3000);
  } catch (e) { $("mainStatus").innerHTML = '<span class="mut">' + e.message + "</span>"; }
}
async function checkUpdate() { updateMsgEverywhere(t("checking")); const r = await jget("/api/update/check"); updateMsgEverywhere(r.error ? r.error : ("latest " + r.latestVersion + (r.updateAvailable ? "，可更新" : "，已是最新"))); refresh(); }
async function runUpdate() { $("btnUpdate").disabled = true; updateMsgEverywhere("已触发，进行中…"); await jpost("/api/update/run"); refresh(); }
function onFilePick() {
  const f = $("fileInput").files[0];
  $("fileName").textContent = f ? f.name + " (" + Math.round(f.size / 1048576) + "MB)" : t("noFile");
}
const GRANT_CMD = "echo '10router ALL=(root) NOPASSWD: /usr/local/bin/appcenter-cli' | sudo tee /etc/sudoers.d/10router-lifecycle\\nsudo chmod 440 /etc/sudoers.d/10router-lifecycle";
function renderAuth(lc) {
  const box = $("authBox");
  if (lc.authorized) {
    box.innerHTML = '<div class="auth-card ok"><div class="row"><span class="pill ok">' + t("authOk") + '</span><span class="mut">' + t("authOkDesc") + '</span><span class="spacer"></span><button class="ghost" onclick="recheckAuth()">' + t("recheck") + '</button></div></div>';
    return;
  }
  box.innerHTML = '<div class="auth-card">'
    + '<div class="row"><span class="pill warn">' + t("authNo") + '</span><span class="mut">' + t("authNoDesc") + '</span></div>'
    + '<div class="steps">' + t("authSteps").replace(/\\n/g, "<br>") + '</div>'
    + '<div class="auth-cmd"><code>' + GRANT_CMD.replace(/\\n/g, "<br>") + '</code><button class="ghost" onclick="copyText(GRANT_CMD, this)">' + t("copy") + '</button></div>'
    + '<div class="row" style="margin-top:8px"><button class="ghost" onclick="recheckAuth()">' + t("recheck") + '</button></div>'
    + '</div>';
}
async function recheckAuth() {
  toast(t("recheck") + "…");
  try { await jget("/api/auth/recheck"); } catch {}
  toast(t("upToDate"), "ok");
  refresh();
}
async function uploadInstall() {
  const f = $("fileInput").files[0];
  if (!f) { toast(t("pickFirst"), "warn"); return; }
  toast(t("uploading"));
  const r = await fetch("/api/update/upload", { method: "PUT", headers: { "content-type": "application/octet-stream", ...headers }, body: f });
  const j = await r.json();
  if (!r.ok) { toast(t("uploading").slice(0,0) || "Upload failed: " + (j.error || r.status), "bad"); return; }
  const ok = await localConfirm(t("uploadBtn"), "OK (" + j.kind + ", " + Math.round(j.size / 1048576) + "MB) → " + t("uploadHint"), true);
  if (!ok) return;
  await jpost("/api/install", { file: j.file });
  updateMsgEverywhere("安装进行中…");
  toast(t("installSent"), "ok");
  refresh();
}
async function saveAuto() {
  await jpost("/api/settings", { autoUpdate: {
    enabled: $("autoEnabled").checked,
    freq: segValue("autoFreq"),
    time: $("autoTime").value || "04:30",
    weekday: Number(segValue("autoWeekday")),
  } });
  toast(t("saved"), "ok"); refresh();
}
async function saveProxy() { await jpost("/api/settings", { proxy: { url: $("proxyUrl").value } }); toast(t("proxySaved"), "ok"); }
async function restartMain() {
  const ok = await localConfirm(t("confirmRestartT"), t("confirmRestartM"), true);
  if (!ok) return;
  updateMsgEverywhere(t("restartSent"));
  toast(t("restartSent"));
  await jpost("/api/main/restart");
  refresh();
}
async function loadLogs() { const f = $("logFilter").value; const r = await jget("/api/logs?lines=400" + (f ? "&filter=" + encodeURIComponent(f) : "")); $("logBox").textContent = (r.truncated ? "…仅显示末尾\\n" : "") + (r.lines.join("\\n") || "—"); }
applyLang(); loadLogs(); refresh(); setInterval(refresh, 15 * 1000);
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
