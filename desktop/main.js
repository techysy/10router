/**
 * 10Router 桌面托盘版 (Electron)
 *
 * 职责:
 *  - 以子进程方式拉起/停止/重启 10Router standalone 服务(cli/app 产物,纯 Node)
 *  - 轮询 /api/health 判断服务就绪
 *  - 托盘图标 + 菜单(打开控制台 / 启动 / 重启 / 停止 / 开机自启 / 数据目录 / 退出)
 *  - 内嵌 BrowserWindow 展示 Web 控制台,外链一律走系统默认浏览器
 *
 * 与参考实现(inspection-visualizer)的差异:
 *  - sidecar 是 Node 而非 Python:用 process.execPath + ELECTRON_RUN_AS_NODE=1 运行
 *    custom-server.js,无需内嵌独立 Node 运行时(子进程 updater/MITM 继承该 env,
 *    同样以纯 Node 运行,ABI 一致)
 *  - 数据目录不改:服务侧固定 %APPDATA%\10router(mac/linux ~/.10router),与 npm CLI
 *    形态共享数据;两形态通过端口健康预检互斥(端口被占且健康 → external 模式)
 *
 * 环境约定:
 *  - 打包版: resources/app/(Next standalone 产物),sidecar 脚本 resources/app/custom-server.js
 *  - 开发版: 仓库 cli/app/(可用 ROUTER_APP_DIR 覆盖)
 *  - 端口: ROUTER_PORT > 20128(与 CLI 默认一致)
 *  - 界面语言: 跟随系统(与 npm CLI 的 i18n 同规则),TENROUTER_LANG 可覆盖
 */
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog } = require('electron');
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 必须先于一切 getPath('userData') 调用:productName "10Router" 在 Windows(大小写
// 不敏感)上会与服务数据目录 %APPDATA%\10router 撞名,壳日志会混进服务数据。
app.setName('10router-desktop');

// ──────────────────────── i18n(与 cli/src/cli/i18n 同规则,内嵌避免跨包依赖) ────
const STRINGS = {
    en: {
        'status.stopped': 'Service not running',
        'status.starting': 'Service starting…',
        'status.running': 'Service running',
        'status.external': 'External service running (port in use)',
        'menu.open': 'Open 10Router',
        'menu.openInBrowser': 'Open in Browser',
        'menu.start': 'Start Service',
        'menu.restart': 'Restart Service',
        'menu.stop': 'Stop Service',
        'menu.autostart': 'Launch at Login',
        'menu.openDataDir': 'Open Data Folder',
        'menu.openLogs': 'Open Service Log',
        'menu.quit': 'Quit',
        'notify.portOccupied': 'Port already in use',
        'notify.portOccupiedBody': 'A 10Router service is already running on port {port} (maybe started by the CLI). Opening the UI directly.',
        'notify.started': '10Router started',
        'notify.restarting': 'Restarting service',
        'notify.restartingBody': 'Please wait…',
        'notify.lanHint': '\nOther devices on the LAN can reach it at http://{ip}:{port}',
        'notify.stopped': 'Service stopped',
        'notify.stoppedBody': 'The 10Router service exited unexpectedly. Restart it from the tray menu.',
        'notify.startTimeout': 'Start timed out',
        'notify.startTimeoutBody': 'Service was not ready within 90 seconds. See log: {log}',
        'err.noAppDirTitle': 'Server bundle not found',
        'err.noAppDirBody': 'Not found: {path}\nBuild the CLI bundle (cli/app) first, or run desktop\\build.ps1.',
        'err.startFailedTitle': 'Start failed',
        'err.startFailedBody': 'Failed to launch the service process:\n{message}',
        'win.notReadyTitle': 'Service not ready',
        'win.notReadyBody': 'Please use the tray icon menu "Start Service" and try again.',
        'menu.checkUpdate': 'Check for Updates',
        'menu.about': 'About 10Router',
        'update.failedTitle': 'Update check failed',
        'update.failedBody': 'Could not reach the local service. Start it first, then try again.',
        'update.availableTitle': 'New version available',
        'update.availableBody': 'v{latest} is available (you are on v{current}).\n\nDesktop updates install a new version from GitHub Releases — download the installer for your platform there.',
        'update.openReleases': 'Open Releases',
        'update.latestTitle': 'Up to date',
        'update.latestBody': 'You are on the latest version v{current}.',
        'update.balloonBody': 'v{latest} is available (current v{current}). Open the tray menu "Check for Updates" to visit the Releases download page.',
        'about.detail': 'FREE AI Router & Token Saver\n\nVersion: v{version}\nShell: v{shell}\nData folder: {dataDir}',
        'about.github': 'GitHub Page',
        'dialog.later': 'Later',
        'dialog.ok': 'OK',
        'dialog.close': 'Close',
    },
    'zh-CN': {
        'status.stopped': '服务未运行',
        'status.starting': '服务启动中…',
        'status.running': '服务运行中',
        'status.external': '外部服务运行中(端口占用)',
        'menu.open': '打开 10Router',
        'menu.openInBrowser': '在浏览器中打开',
        'menu.start': '启动服务',
        'menu.restart': '重启服务',
        'menu.stop': '停止服务',
        'menu.autostart': '开机自启',
        'menu.openDataDir': '打开数据目录',
        'menu.openLogs': '打开服务日志',
        'menu.quit': '退出',
        'notify.portOccupied': '端口已被占用',
        'notify.portOccupiedBody': '{port} 端口已有 10Router 服务在运行(可能由 CLI 启动),将直接打开界面',
        'notify.started': '10Router 已启动',
        'notify.restarting': '正在重启服务',
        'notify.restartingBody': '请稍候…',
        'notify.lanHint': '\n局域网内其他设备可通过 http://{ip}:{port} 访问',
        'notify.stopped': '服务已停止',
        'notify.stoppedBody': '10Router 服务意外退出,可从托盘菜单重新启动',
        'notify.startTimeout': '启动超时',
        'notify.startTimeoutBody': '服务在 90 秒内未就绪,日志见 {log}',
        'err.noAppDirTitle': '未找到服务产物',
        'err.noAppDirBody': '未找到 {path}\n请先构建 CLI 产物(cli/app)再运行,或执行 desktop\\build.ps1。',
        'err.startFailedTitle': '启动失败',
        'err.startFailedBody': '服务进程启动失败:\n{message}',
        'win.notReadyTitle': '服务未就绪',
        'win.notReadyBody': '请从托盘图标菜单「启动服务」后重试。',
        'menu.checkUpdate': '检查更新',
        'menu.about': '关于 10Router',
        'update.failedTitle': '检查更新失败',
        'update.failedBody': '无法连接本地服务,请先启动服务后重试。',
        'update.availableTitle': '发现新版本',
        'update.availableBody': '新版本 v{latest} 已发布(当前 v{current})。\n\n桌面版请前往 GitHub Releases 下载对应平台的安装包更新。',
        'update.openReleases': '打开 Releases 页面',
        'update.latestTitle': '已是最新版本',
        'update.latestBody': '当前 v{current} 已是最新版本。',
        'update.balloonBody': '发现新版本 v{latest}(当前 v{current})。可打开托盘菜单「检查更新」前往 Releases 下载页。',
        'about.detail': 'FREE AI Router & Token Saver\n\n版本: v{version}\n壳版本: v{shell}\n数据目录: {dataDir}',
        'about.github': 'GitHub 主页',
        'dialog.later': '稍后',
        'dialog.ok': '好',
        'dialog.close': '关闭',
    },
    'zh-TW': {
        'status.stopped': '服務未執行',
        'status.starting': '服務啟動中…',
        'status.running': '服務執行中',
        'status.external': '外部服務執行中(連接埠被占用)',
        'menu.open': '開啟 10Router',
        'menu.openInBrowser': '在瀏覽器中開啟',
        'menu.start': '啟動服務',
        'menu.restart': '重新啟動服務',
        'menu.stop': '停止服務',
        'menu.autostart': '開機自啟',
        'menu.openDataDir': '開啟資料目錄',
        'menu.openLogs': '開啟服務日誌',
        'menu.quit': '結束',
        'notify.portOccupied': '連接埠已被占用',
        'notify.portOccupiedBody': '連接埠 {port} 已有 10Router 服務在執行(可能由 CLI 啟動),將直接開啟介面',
        'notify.started': '10Router 已啟動',
        'notify.restarting': '正在重新啟動服務',
        'notify.restartingBody': '請稍候…',
        'notify.lanHint': '\n區域網路內其他裝置可透過 http://{ip}:{port} 存取',
        'notify.stopped': '服務已停止',
        'notify.stoppedBody': '10Router 服務意外結束,可從系統列選單重新啟動',
        'notify.startTimeout': '啟動逾時',
        'notify.startTimeoutBody': '服務在 90 秒內未就緒,日誌見 {log}',
        'err.noAppDirTitle': '找不到服務產物',
        'err.noAppDirBody': '找不到 {path}\n請先建置 CLI 產物(cli/app)再執行,或執行 desktop\\build.ps1。',
        'err.startFailedTitle': '啟動失敗',
        'err.startFailedBody': '服務程序啟動失敗:\n{message}',
        'win.notReadyTitle': '服務未就緒',
        'win.notReadyBody': '請從系統列圖示選單「啟動服務」後重試。',
        'menu.checkUpdate': '檢查更新',
        'menu.about': '關於 10Router',
        'update.failedTitle': '檢查更新失敗',
        'update.failedBody': '無法連線本地服務,請先啟動服務後重試。',
        'update.availableTitle': '發現新版本',
        'update.availableBody': '新版本 v{latest} 已發布(目前 v{current})。\n\n桌面版請前往 GitHub Releases 下載對應平台的安裝包更新。',
        'update.openReleases': '開啟 Releases 頁面',
        'update.latestTitle': '已是最新版本',
        'update.latestBody': '目前 v{current} 已是最新版本。',
        'update.balloonBody': '發現新版本 v{latest}(目前 v{current})。可開啟系統列選單「檢查更新」前往 Releases 下載頁。',
        'about.detail': 'FREE AI Router & Token Saver\n\n版本: v{version}\n殼版本: v{shell}\n資料目錄: {dataDir}',
        'about.github': 'GitHub 首頁',
        'dialog.later': '稍後',
        'dialog.ok': '好',
        'dialog.close': '關閉',
    },
};

function detectLocale() {
    for (const envKey of ['TENROUTER_LANG', 'LC_ALL']) {
        const raw = process.env[envKey];
        if (raw) {
            const loc = String(raw).trim().replace(/_/g, '-').toLowerCase();
            if (/^zh($|-)/.test(loc)) return /(tw|hk|mo|hant)/.test(loc) ? 'zh-TW' : 'zh-CN';
            if (loc.startsWith('en')) return 'en';
        }
    }
    // macOS: 系统 UI 语言的权威来源是 AppleLanguages(Terminal 的 LANG 常年 en_US/C,
    // 与系统语言脱节);Electron 直接暴露该列表,无需 shell out defaults
    if (process.platform === 'darwin') {
        try {
            for (const lang of app.getPreferredSystemLanguages()) {
                const loc = String(lang).replace(/_/g, '-').toLowerCase();
                if (/^zh($|-)/.test(loc)) return /(tw|hk|mo|hant)/.test(loc) ? 'zh-TW' : 'zh-CN';
                if (loc.startsWith('en')) return 'en';
            }
        } catch (e) { /* 取不到继续走通用链 */ }
    }
    const langEnv = process.env.LANG;
    if (langEnv) {
        const loc = String(langEnv).trim().replace(/_/g, '-').toLowerCase();
        if (/^zh($|-)/.test(loc)) return /(tw|hk|mo|hant)/.test(loc) ? 'zh-TW' : 'zh-CN';
        if (loc.startsWith('en')) return 'en';
    }
    try {
        const loc = String(Intl.DateTimeFormat().resolvedOptions().locale || '').replace(/_/g, '-').toLowerCase();
        if (/^zh($|-)/.test(loc)) return /(tw|hk|mo|hant)/.test(loc) ? 'zh-TW' : 'zh-CN';
        if (loc.startsWith('en')) return 'en';
    } catch (e) { /* ICU 不可用时回退 en */ }
    return 'en';
}

const LOCALE = detectLocale();

function tr(key, params) {
    let str = (STRINGS[LOCALE] && STRINGS[LOCALE][key] !== undefined)
        ? STRINGS[LOCALE][key]
        : (STRINGS.en[key] !== undefined ? STRINGS.en[key] : key);
    if (params) {
        for (const [name, value] of Object.entries(params)) {
            str = str.split(`{${name}}`).join(String(value));
        }
    }
    return str;
}

// ──────────────────────── 常量与全局状态 ────────────────────────
const PORT = parseInt(process.env.ROUTER_PORT || '20128', 10);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DASHBOARD_URL = `${BASE_URL}/dashboard`;
const IS_PACKAGED = app.isPackaged;
const ROOT = path.join(__dirname, '..');                     // 开发模式下的仓库根目录
const RESOURCES = IS_PACKAGED ? process.resourcesPath : __dirname;
const APP_DIR = IS_PACKAGED
    ? path.join(RESOURCES, 'app')
    : (process.env.ROUTER_APP_DIR || path.join(ROOT, 'cli', 'app'));
const DATA_DIR = process.platform === 'win32'
    ? path.join(process.env.APPDATA || app.getPath('userData'), '10router')
    : path.join(os.homedir(), '.10router');
const LOG_DIR = path.join(app.getPath('userData'), 'logs');
const MAX_LOG_SIZE = 5 * 1024 * 1024;

/** @type {import('child_process').ChildProcess | null} */
let nodeProc = null;
let state = 'stopped';          // stopped | starting | running | external
let quitting = false;
let tray = null;
let win = null;
let serverLogFd = null;

function log(msg) {
    const line = `[${new Date().toLocaleString('sv-SE')}] ${msg}\n`;
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        fs.appendFileSync(path.join(LOG_DIR, 'tray.log'), line);
    } catch { /* 日志失败不影响主流程 */ }
}

function resolveServerEntry() {
    const custom = path.join(APP_DIR, 'custom-server.js');   // 注入真实 socket IP,本地请求免鉴权
    if (fs.existsSync(custom)) return custom;
    return path.join(APP_DIR, 'server.js');
}

function getLanIp() {
    for (const ifaces of Object.values(os.networkInterfaces())) {
        for (const i of ifaces || []) {
            if (i.family === 'IPv4' && !i.internal) return i.address;
        }
    }
    return null;
}

// ──────────────────────── 健康检查 ────────────────────────
function checkHealth(timeoutMs = 2000) {
    return new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/health', timeout: timeoutMs }, (res) => {
            res.resume();
            resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

async function waitForHealth(deadlineMs) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        if (!nodeProc && state !== 'external') return false;   // 进程已退出,停止等待
        if (await checkHealth()) return true;
        await new Promise(r => setTimeout(r, 1200));
    }
    return false;
}

// ──────────────────────── 服务管理 ────────────────────────
function openServerLogFd() {
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        const logFile = path.join(LOG_DIR, 'server.log');
        try {
            if (fs.statSync(logFile).size > MAX_LOG_SIZE) fs.truncateSync(logFile, 0);
        } catch { /* 文件不存在 */ }
        serverLogFd = fs.openSync(logFile, 'a');
    } catch {
        serverLogFd = null;
    }
}

function setState(next) {
    state = next;
    rebuildMenu();
}

async function startServer() {
    if (nodeProc || state === 'running' || state === 'starting') return;

    // 端口已被占用且健康 → 视为外部已有服务在跑(npm CLI 或手动启动),直接打开界面
    if (await checkHealth()) {
        setState('external');
        notify(tr('notify.portOccupied'), tr('notify.portOccupiedBody', { port: PORT }));
        createWindow();
        return;
    }

    const serverPath = resolveServerEntry();
    if (!fs.existsSync(serverPath)) {
        dialog.showErrorBox(tr('err.noAppDirTitle'), tr('err.noAppDirBody', { path: serverPath }));
        return;
    }

    openServerLogFd();
    const env = {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',      // 用 Electron 二进制以纯 Node 模式运行 sidecar
        NODE_ENV: 'production',
        PORT: String(PORT),
        HOSTNAME: '0.0.0.0',            // 与 CLI 一致,局域网设备可直接访问
        // 安装渠道标记:仪表盘「检查更新」据此显示 GitHub Releases 链接而非
        // npm 安装命令(桌面版更新 = 下载新安装包,更新 npm 包碰不到内嵌 cli/app)。
        INSTALL_CHANNEL: 'desktop',
    };
    delete env.NODE_OPTIONS;            // Electron 的 NODE_OPTIONS 白名单与纯 Node 不同,避免干扰
    log(`start server: ${process.execPath} ${serverPath} (data=${DATA_DIR})`);
    const proc = spawn(process.execPath, ['--dns-result-order=ipv4first', '--max-old-space-size=6144', serverPath], {
        cwd: APP_DIR,
        env,
        detached: process.platform !== 'win32',   // posix 下成组,便于整组 kill
        windowsHide: true,
        stdio: ['ignore', serverLogFd, serverLogFd],
    });
    nodeProc = proc;
    setState('starting');

    proc.on('error', (err) => {
        log(`server spawn error: ${err.message}`);
        dialog.showErrorBox(tr('err.startFailedTitle'), tr('err.startFailedBody', { message: err.message }));
    });
    proc.on('exit', (code) => {
        log(`server exited (code=${code})`);
        const wasRunning = state === 'running';
        if (serverLogFd !== null) { try { fs.closeSync(serverLogFd); } catch { } serverLogFd = null; }
        nodeProc = null;
        if (!quitting) {
            setState('stopped');
            if (wasRunning) notify(tr('notify.stopped'), tr('notify.stoppedBody'));
        }
    });

    const ok = await waitForHealth(90 * 1000);
    if (!nodeProc) return;                    // 启动过程中进程退出了
    if (ok) {
        setState('running');
        const lanIp = getLanIp();
        notify(tr('notify.started'), `${DASHBOARD_URL}${lanIp ? tr('notify.lanHint', { ip: lanIp, port: PORT }) : ''}`);
        if (!win || win.isDestroyed()) createWindow();      // 启动成功直接打开界面
        else win.loadURL(DASHBOARD_URL).catch(() => { });
        autoCheckUpdate();                    // 静默检查,仅发现新版本时弹托盘气泡引导
    } else {
        setState('stopped');
        if (nodeProc) { try { killProcTree(nodeProc.pid); } catch { } }
        notify(tr('notify.startTimeout'), tr('notify.startTimeoutBody', { log: path.join(LOG_DIR, 'server.log') }));
    }
}

function killProcTree(pid) {
    if (process.platform === 'win32') {
        // 服务可能带子进程(updater/MITM),taskkill 杀整棵树;被拒绝(权限)时 wmic 兜底
        const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
        if (r.error) throw r.error;
        if (r.status !== 0) {
            spawnSync('wmic', ['process', 'where', `processid=${pid}`, 'delete'], { windowsHide: true });
        }
    } else {
        try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { } }
    }
}

function stopServer() {
    return new Promise((resolve) => {
        if (!nodeProc) return resolve();
        const proc = nodeProc;
        log(`stop server pid=${proc.pid}`);
        try { killProcTree(proc.pid); } catch (e) { log(`kill failed: ${e.message}`); try { proc.kill(); } catch { } }
        const t = setTimeout(() => resolve(), 5000);
        proc.once('exit', () => { clearTimeout(t); resolve(); });
    });
}

async function restartServer() {
    notify(tr('notify.restarting'), tr('notify.restartingBody'));
    await stopServer();
    await new Promise(r => setTimeout(r, 800));
    await startServer();
}

// ──────────────────────── 窗口 ────────────────────────
function createWindow() {
    if (win && !win.isDestroyed()) {
        win.show();
        win.focus();
        return;
    }
    win = new BrowserWindow({
        width: 1380,
        height: 880,
        title: '10Router',
        autoHideMenuBar: true,
        icon: path.join(__dirname, 'icon.ico'),
        backgroundColor: '#0a0a0a',
        show: false,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    win.once('ready-to-show', () => win.show());
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/i.test(url)) shell.openExternal(url);   // 外链走系统浏览器
        return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
        if (!url.startsWith(BASE_URL)) {
            e.preventDefault();
            if (/^https?:/i.test(url)) shell.openExternal(url);
        }
    });
    win.on('closed', () => { win = null; });
    win.on('close', (e) => {
        if (!quitting) {          // 点关闭 = 缩到托盘
            e.preventDefault();
            win.hide();
        }
    });
    win.loadURL(DASHBOARD_URL).catch(() => {
        win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
            `<body style="font-family:sans-serif;padding:40px"><h3>${tr('win.notReadyTitle')}</h3><p>${tr('win.notReadyBody')}</p></body>`));
    });
}

// ──────────────────────── 托盘 ────────────────────────
function notify(title, content) {
    if (!tray) return;
    try {
        if (process.platform === 'win32') tray.displayBalloon({ iconType: 'info', title, content });
        else new Notification({ title, body: content }).show();
    } catch { /* 部分环境不支持系统通知 */ }
    log(`notify: ${title}`);
}

const STATE_LABEL = {
    stopped: () => tr('status.stopped'),
    starting: () => tr('status.starting'),
    running: () => tr('status.running'),
    external: () => tr('status.external'),
};

const RELEASES_URL = 'https://github.com/techysy/10router/releases';

function fetchJson(url, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { timeout: timeoutMs }, (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

// 检查更新:走本地服务 /api/version(免鉴权,带 npm latest 1h 缓存),
// 与 fpk/CLI 同一数据源;桌面版结果以对话框呈现并引导去 Releases 下载安装包。
async function checkForUpdates() {
    let info = null;
    try {
        info = await fetchJson(`${BASE_URL}/api/version`);
    } catch { /* 服务未运行/网络失败 */ }
    if (!info || !info.currentVersion) {
        dialog.showMessageBox({ type: 'warning', title: tr('update.failedTitle'), message: tr('update.failedTitle'), detail: tr('update.failedBody'), buttons: [tr('dialog.ok')] });
        return;
    }
    if (info.hasUpdate) {
        const relUrl = info.releaseUrl || RELEASES_URL;
        const choice = await dialog.showMessageBox({
            type: 'info',
            title: tr('update.availableTitle'),
            message: tr('update.availableTitle'),
            detail: tr('update.availableBody', { latest: info.latestVersion, current: info.currentVersion }),
            buttons: [tr('update.openReleases'), tr('dialog.later')],
            defaultId: 0,
            cancelId: 1,
        });
        if (choice.response === 0) shell.openExternal(relUrl);
    } else {
        dialog.showMessageBox({ type: 'info', title: tr('update.latestTitle'), message: tr('update.latestTitle'), detail: tr('update.latestBody', { current: info.currentVersion }), buttons: [tr('dialog.ok')] });
    }
}

// 启动后静默检查更新:仅发现新版本时弹托盘气泡引导(点击气泡打开 Releases);
// 无更新/网络失败均静默,不打扰。与手动「检查更新」菜单项互补。
async function autoCheckUpdate() {
    try {
        const info = await fetchJson(`${BASE_URL}/api/version`);
        if (info && info.hasUpdate && info.latestVersion) {
            notify(
                tr('update.availableTitle'),
                tr('update.balloonBody', { latest: info.latestVersion, current: info.currentVersion })
            );
        }
    } catch { /* 静默失败 */ }
}

function showAbout() {
    dialog.showMessageBox({
        type: 'info',
        title: '10Router',
        message: '10Router',
        detail: tr('about.detail', { version: getServiceVersion(), shell: app.getVersion(), dataDir: DATA_DIR }),
        buttons: [tr('about.github'), tr('dialog.close')],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
    }).then((r) => { if (r.response === 0) shell.openExternal('https://github.com/techysy/10router'); });
}

// 内嵌服务版本 = resources/app/package.json 的 version(打包时与壳版本同步,
// 开发模式下回退壳版本);读不到不致命。
function getServiceVersion() {
    try {
        return require(path.join(APP_DIR, 'package.json')).version || app.getVersion();
    } catch { return app.getVersion(); }
}

function rebuildMenu() {
    if (!tray) return;
    const canOpen = state === 'running' || state === 'external';
    // 启动/停止合一:按当前状态显示唯一动作项(菜单更短,语义更明确)
    const toggleItem = state === 'running'
        ? { label: tr('menu.stop'), enabled: true, click: () => stopServer() }
        : state === 'starting'
            ? { label: tr('menu.start'), enabled: false }
            : { label: tr('menu.start'), enabled: state === 'stopped', click: () => startServer() };
    const menu = Menu.buildFromTemplate([
        { label: tr('menu.open'), enabled: canOpen, click: createWindow },
        { label: tr('menu.openInBrowser'), enabled: canOpen, click: () => shell.openExternal(DASHBOARD_URL) },
        { type: 'separator' },
        { label: STATE_LABEL[state](), enabled: false },
        toggleItem,
        { label: tr('menu.restart'), enabled: state === 'running', click: () => restartServer() },
        { type: 'separator' },
        { label: tr('menu.checkUpdate'), click: () => checkForUpdates() },
        {
            label: tr('menu.autostart'),
            type: 'checkbox',
            checked: app.getLoginItemSettings().openAtLogin,
            enabled: IS_PACKAGED,          // 开发模式注册的是 electron.exe,不提供
            click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, path: app.getPath('exe') }),
        },
        { type: 'separator' },
        { label: tr('menu.openDataDir'), click: () => shell.openPath(DATA_DIR) },
        { label: tr('menu.openLogs'), click: () => shell.openPath(path.join(LOG_DIR, 'server.log')) },
        { label: tr('menu.about'), click: () => showAbout() },
        { type: 'separator' },
        {
            label: tr('menu.quit'),
            click: () => { quitting = true; app.quit(); },
        },
    ]);
    tray.setContextMenu(menu);
    tray.setToolTip(`10Router — ${STATE_LABEL[state]()}`);
}

function createTray() {
    let icon = nativeImage.createFromPath(path.join(__dirname, 'icon.ico'));
    if (icon.isEmpty()) icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
    if (process.platform === 'darwin') {
        // macOS 菜单栏图标要小;保留品牌橙色(不做 template,黑白会失去辨识度)
        icon = icon.resize({ width: 16, height: 16 });
        icon.setTemplateImage(false);
    }
    tray = new Tray(icon);
    rebuildMenu();
    tray.on('click', () => {
        if (state === 'running' || state === 'external') createWindow();
        else if (state === 'stopped') startServer();
    });
}

// ──────────────────────── 生命周期 ────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (state === 'running' || state === 'external') createWindow();
    });

    app.whenReady().then(async () => {
        log(`app start (packaged=${IS_PACKAGED}, appDir=${APP_DIR}, data=${DATA_DIR}, locale=${LOCALE})`);
        createTray();
        await startServer();          // 启动即拉起服务
    });

    app.on('before-quit', () => { quitting = true; });

    app.on('will-quit', () => {
        if (nodeProc) {
            try { killProcTree(nodeProc.pid); } catch { try { nodeProc.kill(); } catch { } }
        }
    });

    // 托盘应用:窗口全关也不退出
    app.on('window-all-closed', (e) => { /* no-op,阻止默认退出 */ });
}
