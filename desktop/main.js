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
const { app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme, shell, dialog, ipcMain } = require('electron');
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
        'appmenu.file': 'File',
        'appmenu.edit': 'Edit',
        'appmenu.view': 'View',
        'appmenu.window': 'Window',
        'appmenu.help': 'Help',
        'appmenu.manageRecent': 'Manage Recent…',
        'appmenu.openurl.titlePh': 'Title (optional)',
        'appmenu.mgr.save': 'Save',
        'appmenu.mgr.delete': 'Delete',
        'appmenu.quit': 'Exit',
        'appmenu.undo': 'Undo',
        'appmenu.redo': 'Redo',
        'appmenu.cut': 'Cut',
        'appmenu.copy': 'Copy',
        'appmenu.paste': 'Paste',
        'appmenu.selectall': 'Select All',
        'appmenu.reload': 'Reload',
        'appmenu.forcereload': 'Force Reload',
        'appmenu.back': 'Back',
        'appmenu.forward': 'Forward',
        'appmenu.devtools': 'Developer Tools',
        'appmenu.zoomreset': 'Actual Size',
        'appmenu.zoomin': 'Zoom In',
        'appmenu.zoomout': 'Zoom Out',
        'appmenu.minimize': 'Minimize',
        'appmenu.close': 'Close Window',
        'appmenu.go': 'Go',
        'appmenu.openurl': 'Open URL…',
        'appmenu.openurl.title': 'Open URL',
        'appmenu.openurl.go': 'Open',
        'appmenu.openurl.invalid': 'Invalid URL — check the address',
        'appmenu.home': 'Back to 10Router',
        'appmenu.recent': 'Recent',
        'appmenu.recent.empty': '(none yet)',
        'appmenu.clearrecent': 'Clear Recent',
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
        'appmenu.file': '文件',
        'appmenu.edit': '编辑',
        'appmenu.view': '视图',
        'appmenu.window': '窗口',
        'appmenu.help': '帮助',
        'appmenu.manageRecent': '管理最近打开…',
        'appmenu.openurl.titlePh': '标题（可选）',
        'appmenu.mgr.save': '保存',
        'appmenu.mgr.delete': '删除',
        'appmenu.quit': '退出',
        'appmenu.undo': '撤销',
        'appmenu.redo': '重做',
        'appmenu.cut': '剪切',
        'appmenu.copy': '复制',
        'appmenu.paste': '粘贴',
        'appmenu.selectall': '全选',
        'appmenu.reload': '重新加载',
        'appmenu.forcereload': '强制刷新',
        'appmenu.back': '后退',
        'appmenu.forward': '前进',
        'appmenu.devtools': '开发者工具',
        'appmenu.zoomreset': '实际大小',
        'appmenu.zoomin': '放大',
        'appmenu.zoomout': '缩小',
        'appmenu.minimize': '最小化',
        'appmenu.close': '关闭窗口',
        'appmenu.go': '前往',
        'appmenu.openurl': '打开网址…',
        'appmenu.openurl.title': '打开网址',
        'appmenu.openurl.go': '打开',
        'appmenu.openurl.invalid': '网址无效，请检查地址',
        'appmenu.home': '回到 10Router',
        'appmenu.recent': '最近打开',
        'appmenu.recent.empty': '(还没有记录)',
        'appmenu.clearrecent': '清除最近打开',
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
        'appmenu.file': '檔案',
        'appmenu.edit': '編輯',
        'appmenu.view': '檢視',
        'appmenu.window': '視窗',
        'appmenu.help': '說明',
        'appmenu.manageRecent': '管理最近開啟…',
        'appmenu.openurl.titlePh': '標題（可選）',
        'appmenu.mgr.save': '儲存',
        'appmenu.mgr.delete': '刪除',
        'appmenu.quit': '結束',
        'appmenu.undo': '復原',
        'appmenu.redo': '重做',
        'appmenu.cut': '剪下',
        'appmenu.copy': '複製',
        'appmenu.paste': '貼上',
        'appmenu.selectall': '全選',
        'appmenu.reload': '重新載入',
        'appmenu.forcereload': '強制重新載入',
        'appmenu.back': '返回',
        'appmenu.forward': '前進',
        'appmenu.devtools': '開發人員工具',
        'appmenu.zoomreset': '實際大小',
        'appmenu.zoomin': '放大',
        'appmenu.zoomout': '縮小',
        'appmenu.minimize': '最小化',
        'appmenu.close': '關閉視窗',
        'appmenu.go': '前往',
        'appmenu.openurl': '開啟網址…',
        'appmenu.openurl.title': '開啟網址',
        'appmenu.openurl.go': '開啟',
        'appmenu.openurl.invalid': '網址無效，請檢查地址',
        'appmenu.home': '回到 10Router',
        'appmenu.recent': '最近開啟',
        'appmenu.recent.empty': '(還沒有記錄)',
        'appmenu.clearrecent': '清除最近開啟',
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
let pendingUrl = null;   // 「前往→打开网址/最近」首开时带入的目标 URL(createWindow 首载用一次)

function createWindow() {
    if (win && !win.isDestroyed()) {
        win.show();
        win.focus();
        // 主窗体 = 本地仪表盘的家:如果正停在远端服务上,「显示主窗体」顺带回家。
        try {
            const cur = win.webContents.getURL();
            if (cur && !cur.startsWith(BASE_URL) && !pendingUrl) win.loadURL(DASHBOARD_URL).catch(() => {});
        } catch { /* 读 URL 失败不致命 */ }
        return;
    }
    const firstUrl = pendingUrl || DASHBOARD_URL;
    pendingUrl = null;
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
        // 主窗体当通用视图用:http(s) 一律放行(「前往→打开网址」的既有语义);
        // 其余 scheme(file: 等)拦下,已知外部协议丢系统浏览器。
        if (/^https?:/i.test(url)) return;
        e.preventDefault();
        if (/^(mailto|tel):/i.test(url)) shell.openExternal(url);
    });
    win.webContents.on('page-title-updated', (e, title) => {
        // 「最近打开」自动起名:页面真的加载出标题就把 document.title 回填到
        // 最近列表(零额外网络请求)。只认 http(s) 且已在列表里的 URL——
        // 本地仪表盘/未经「打开网址」进来的页面都不入册;手动标题不覆盖。
        try {
            const u = win.webContents.getURL();
            if (u && /^https?:/i.test(u) && !u.startsWith(BASE_URL)) updateRecentUrlTitle(u, title, false);
        } catch { /* ignore */ }
    });
    win.webContents.on('did-navigate', (e, url) => {
        // 视图本地/外部切换时重建菜单(Edit 角色是否注册快捷键见上方注释)
        const ext = !(url || '').startsWith(BASE_URL);
        if (ext !== externalView) { externalView = ext; setAppMenu(); }
    });
    attachContextMenu(win);
    win.on('closed', () => { win = null; });
    win.on('close', (e) => {
        if (!quitting) {          // 点关闭 = 缩到托盘
            e.preventDefault();
            win.hide();
        }
    });
    win.loadURL(firstUrl).catch(() => {
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
const GITHUB_URL = 'https://github.com/techysy/10router';

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
    }).then((r) => { if (r.response === 0) shell.openExternal(GITHUB_URL); });
}

// 内嵌服务版本 = resources/app/package.json 的 version(打包时与壳版本同步,
// 开发模式下回退壳版本);读不到不致命。
function getServiceVersion() {
    try {
        return require(path.join(APP_DIR, 'package.json')).version || app.getVersion();
    } catch { return app.getVersion(); }
}

// ──────────────────────── 前往菜单:打开网址 / 最近打开 ────────────────────────
// 主窗体当通用视图用:任意网址(Ctrl+L 输入,不限 10Router)、最近打开自动记录
// (userData/recent-urls.json, newest-first, 上限 10)、「回到 10Router」一键回家。
const RECENT_FILE = path.join(app.getPath('userData'), 'recent-urls.json');
let urlPromptWin = null;

function loadRecentUrls() {
    try {
        const raw = JSON.parse(fs.readFileSync(RECENT_FILE, 'utf8'));
        if (!Array.isArray(raw)) return [];
        // 旧格式是纯字符串数组(无标题):逐条迁移成对象,两格式都能读
        return raw.slice(0, 10).map((e) => {
            if (typeof e === 'string' && e) return { url: e, title: '', titleManual: false };
            if (e && typeof e === 'object' && typeof e.url === 'string' && e.url) {
                return {
                    url: e.url,
                    title: typeof e.title === 'string' ? e.title.slice(0, 60) : '',
                    titleManual: e.titleManual === true,
                };
            }
            return null;
        }).filter(Boolean);
    } catch { return []; }
}

function saveRecentUrls(list) {
    try {
        fs.mkdirSync(path.dirname(RECENT_FILE), { recursive: true });
        fs.writeFileSync(RECENT_FILE, JSON.stringify(list.slice(0, 10), null, 2) + '\n');
    } catch { /* 记录失败不影响打开 */ }
    setAppMenu();   // 重建菜单以刷新「最近打开」
}

// title 在「打开网址」弹窗里手动填的算手动标题(不被自动回填覆盖);留空交给自动获取
function pushRecentUrl(url, title = '') {
    const t = String(title || '').trim().slice(0, 60);
    const list = loadRecentUrls().filter((e) => e.url.toLowerCase() !== url.toLowerCase());
    list.unshift({ url, title: t, titleManual: !!t });
    saveRecentUrls(list);
}

// 页面标题回填:manual=true(管理窗改名)直接生效,空标题=清除;
// manual=false(自动)只回填无手动标题的条目。
function updateRecentUrlTitle(url, title, manual = false) {
    const t = String(title || '').trim().slice(0, 60);
    const list = loadRecentUrls();
    const e = list.find((x) => x.url.toLowerCase() === url.toLowerCase());
    if (!e) return;
    if (manual) {
        if (e.title === t && e.titleManual === !!t) return;
        e.title = t;
        e.titleManual = !!t;
    } else {
        if (!t || e.titleManual || e.title === t) return;
        e.title = t;
    }
    saveRecentUrls(list);
}

function removeRecentUrl(url) {
    saveRecentUrls(loadRecentUrls().filter((e) => e.url.toLowerCase() !== url.toLowerCase()));
}

// 菜单标签:标题优先;没有标题只显示域名,长网址不再怼进菜单
function recentLabel(e) {
    if (e.title) return e.title;
    try { return new URL(e.url).hostname; } catch { return e.url; }
}

function clearRecentUrls() {
    try { fs.writeFileSync(RECENT_FILE, '[]'); } catch { /* ignore */ }
    setAppMenu();
}

function normalizeOpenUrl(raw) {
    let v = String(raw || '').trim();
    if (!v) return null;
    if (!/^https?:\/\//i.test(v)) v = 'http://' + v;   // "nas.lan:20127" 也算数
    try {
        const u = new URL(v);
        if (!u.hostname || !/^https?:$/.test(u.protocol)) return null;
        return u.toString();
    } catch { return null; }
}

// 在主窗体内打开任意网址(loadURL 是程序化导航,不经 will-navigate 守卫)
function openInWindow(url) {
    if (win && !win.isDestroyed()) {
        win.show();
        win.focus();
        try {
            const cur = win.webContents.getURL();
            if (cur !== url) win.loadURL(url).catch(() => {});
        } catch { /* 读 URL 失败直接导航 */ }
        return;
    }
    pendingUrl = url;
    createWindow();
}

function promptOpenUrl() {
    if (urlPromptWin && !urlPromptWin.isDestroyed()) { urlPromptWin.focus(); return; }
    const hasParent = win && !win.isDestroyed();
    urlPromptWin = new BrowserWindow({
        width: 500,
        height: 178,
        parent: hasParent ? win : null,
        // 刻意不用 modal:模态子窗在 show:false + ready-to-show 未命中等场景会把
        // 父窗体永久禁用(表现为整个应用卡死)。普通子窗 + alwaysOnTop 同样钉在前面。
        alwaysOnTop: true,
        title: tr('appmenu.openurl.title'),
        resizable: false,
        minimizable: false,
        maximizable: false,
        autoHideMenuBar: true,
        show: true,   // 小页面直接显示,不等 ready-to-show(同类卡死源)
        webPreferences: { contextIsolation: false, nodeIntegration: true, sandbox: false },
    });
    attachContextMenu(urlPromptWin);
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const html = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="font-family:inherit;margin:0;padding:12px 14px;display:flex;flex-direction:column;gap:8px;background:transparent">
<div style="display:flex;gap:8px">
<input id="u" autofocus placeholder="https://… 或 host:port"
  style="flex:1;padding:6px 10px;font-size:14px;border:1px solid #8883;border-radius:6px;outline:none">
<button id="go" style="padding:6px 14px;font-size:14px;border:1px solid #8883;border-radius:6px;cursor:pointer">${esc(tr('appmenu.openurl.go'))}</button>
</div>
<input id="t" placeholder="${esc(tr('appmenu.openurl.titlePh'))}"
  style="padding:5px 10px;font-size:12px;border:1px solid #8883;border-radius:6px;outline:none">
<script>
const { ipcRenderer } = require('electron');
const go = () => {
  const v = document.getElementById('u').value.trim();
  if (!v) return;
  ipcRenderer.send('url-prompt-submit', { url: v, title: document.getElementById('t').value });
};
document.getElementById('go').addEventListener('click', go);
['u', 't'].forEach((id) => document.getElementById(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') go();
    if (e.key === 'Escape') window.close();
}));
</script>
</body></html>`;
    urlPromptWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
        .catch((e) => { log(`url prompt load failed: ${e.message}`); try { urlPromptWin.close(); } catch { /* ignore */ } });
    urlPromptWin.on('closed', () => { urlPromptWin = null; });
}

// 输入框「打开」/回车 → 主进程校验:合法就记最近+主窗体打开(输入窗关闭);
// 非法关窗并气泡提示。ipcRenderer.send 没有回报通道,提示走 notify。
ipcMain.on('url-prompt-submit', (e, raw) => {
    const fromPrompt = urlPromptWin && !urlPromptWin.isDestroyed() && e.sender === urlPromptWin.webContents;
    // 旧版只传字符串;现版带可选标题 {url, title}
    const rawUrl = typeof raw === 'string' ? raw : (raw && raw.url);
    const rawTitle = (raw && typeof raw === 'object') ? String(raw.title || '') : '';
    const url = normalizeOpenUrl(rawUrl);
    if (fromPrompt) urlPromptWin.close();
    if (!url) { notify(tr('appmenu.openurl.title'), tr('appmenu.openurl.invalid')); return; }
    pushRecentUrl(url, rawTitle);
    openInWindow(url);
});

// ──────────────────────── 管理最近打开(改名/单条删除) ────────────────────────
let recentMgrWin = null;
function promptManageRecent() {
    if (recentMgrWin && !recentMgrWin.isDestroyed()) { recentMgrWin.focus(); return; }
    recentMgrWin = new BrowserWindow({
        width: 620,
        height: 420,
        parent: (win && !win.isDestroyed()) ? win : null,
        alwaysOnTop: true,
        title: tr('appmenu.manageRecent'),
        autoHideMenuBar: true,
        show: true,
        webPreferences: { contextIsolation: false, nodeIntegration: true, sandbox: false },
    });
    attachContextMenu(recentMgrWin);
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const html = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="font-family:inherit;margin:0;padding:12px;background:transparent">
<div id="list" style="display:flex;flex-direction:column;gap:6px"></div>
<script>
const { ipcRenderer } = require('electron');
const BTN = 'padding:3px 10px;font-size:12px;border:1px solid #8883;border-radius:6px;cursor:pointer;background:transparent';
const INP = 'flex:1;min-width:0;padding:4px 8px;font-size:13px;border:1px solid #8883;border-radius:6px;outline:none';
const URLSTY = 'flex-basis:100%;font-size:11px;color:#888;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
// 行内容全部用 DOM API 构建(textContent),不拼 HTML 字符串,天然免注入
function render(list) {
    const box = document.getElementById('list');
    box.textContent = '';
    if (!list.length) { box.textContent = ${JSON.stringify('RECENT_EMPTY_PLACEHOLDER')}; return; }
    for (const it of list) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;border:1px solid #8883;border-radius:8px;padding:8px';
        const t = document.createElement('input');
        t.style.cssText = INP;
        t.value = it.title || '';
        t.placeholder = it.url;
        const save = document.createElement('button');
        save.textContent = ${JSON.stringify('SAVE_PLACEHOLDER')};
        save.style.cssText = BTN;
        const del = document.createElement('button');
        del.textContent = ${JSON.stringify('DELETE_PLACEHOLDER')};
        del.style.cssText = BTN;
        const u = document.createElement('div');
        u.style.cssText = URLSTY;
        u.textContent = it.url;
        u.title = it.url;
        save.onclick = () => { render(ipcRenderer.sendSync('recent-mgr', { action: 'rename', url: it.url, title: t.value }).list || []); };
        del.onclick = () => { render(ipcRenderer.sendSync('recent-mgr', { action: 'remove', url: it.url }).list || []); };
        row.append(t, save, del, u);
        box.appendChild(row);
    }
}
render((ipcRenderer.sendSync('recent-mgr', { action: 'list' }) || {}).list || []);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.close(); });
</script>
</body></html>`;
    const filled = html
        .replace('RECENT_EMPTY_PLACEHOLDER', esc(tr('appmenu.recent.empty')))
        .replace('SAVE_PLACEHOLDER', esc(tr('appmenu.mgr.save')))
        .replace('DELETE_PLACEHOLDER', esc(tr('appmenu.mgr.delete')));
    recentMgrWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(filled))
        .catch((e) => { log(`recent mgr load failed: ${e.message}`); try { recentMgrWin.close(); } catch { /* ignore */ } });
    recentMgrWin.on('closed', () => { recentMgrWin = null; });
}

// 管理窗与主进程的单通道 RPC(sendSync):list/rename/remove,一律回当前全表
ipcMain.on('recent-mgr', (e, msg) => {
    const fromMgr = recentMgrWin && !recentMgrWin.isDestroyed() && e.sender === recentMgrWin.webContents;
    if (fromMgr && msg && typeof msg === 'object') {
        if (msg.action === 'rename' && typeof msg.url === 'string') updateRecentUrlTitle(msg.url, msg.title, true);
        else if (msg.action === 'remove' && typeof msg.url === 'string') removeRecentUrl(msg.url);
    }
    e.returnValue = { ok: !!fromMgr, list: loadRecentUrls() };
});

// ──────────────────────── 右键菜单(网页/TUI 复制粘贴) ────────────────────────
// Electron 窗口没有浏览器右键菜单:在 Hermes 这类 web TUI 里,选中复制/粘贴
// 只能靠它(Chrome 的右键在壳里是空的)。菜单项走 webContents 原生动作,
// 不与页面按键交互。词条复用应用菜单的 appmenu.copy/paste/selectall。
let externalView = false;   // 主窗体当前视图是否为外部页面(非本地仪表盘)
function attachContextMenu(target) {
    target.webContents.on('context-menu', (e, params) => {
        const menu = Menu.buildFromTemplate([
            { label: tr('appmenu.copy'), enabled: params.editFlags.canCopy, click: () => target.webContents.copy() },
            { label: tr('appmenu.paste'), enabled: params.editFlags.canPaste, click: () => target.webContents.paste() },
            { label: tr('appmenu.selectall'), enabled: params.editFlags.canSelectAll, click: () => target.webContents.selectAll() },
        ]);
        menu.popup({ window: target, x: params.x, y: params.y });
    });
}

// ──────────────────────── 应用菜单(Alt 呼出) ────────────────────────
// Electron 默认菜单是英文的;按 tr() 出三语,role 保住快捷键与原生行为。
function setAppMenu() {
    const template = [
        ...(process.platform === 'darwin' ? [{
            label: app.name,
            submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit', label: tr('appmenu.quit') }],
        }] : []),
        {
            label: tr('appmenu.file'),
            submenu: [
                { label: tr('appmenu.quit'), click: () => { quitting = true; app.quit(); } },
            ],
        },
        {
            label: tr('appmenu.go'),
            submenu: [
                { label: tr('appmenu.openurl'), accelerator: 'CmdOrCtrl+L', click: promptOpenUrl },
                { label: tr('appmenu.home'), accelerator: 'CmdOrCtrl+Shift+H', click: () => openInWindow(DASHBOARD_URL) },
                { type: 'separator' },
                ...(() => {
                    const recents = loadRecentUrls();
                    const items = recents.map((e) => ({
                        label: recentLabel(e),
                        click: () => openInWindow(e.url),
                    }));
                    items.push({ type: 'separator' });
                    items.push({ label: tr('appmenu.manageRecent'), enabled: recents.length > 0, click: promptManageRecent });
                    items.push({ label: tr('appmenu.clearrecent'), enabled: recents.length > 0, click: clearRecentUrls });
                    return items;
                })(),
            ],
        },
        {
            label: tr('appmenu.edit'),
            submenu: [
                { role: 'undo', label: tr('appmenu.undo') },
                { role: 'redo', label: tr('appmenu.redo') },
                { type: 'separator' },
                { role: 'cut', label: tr('appmenu.cut') },
                { role: 'copy', label: tr('appmenu.copy') },
                { role: 'paste', label: tr('appmenu.paste') },
                { role: 'selectAll', label: tr('appmenu.selectall') },
                // 外部视图(web TUI 等)不注册快捷键:Ctrl+C/V/Z 直达页面,行为同
                // Chrome —— TUI 里 Ctrl+C 是 SIGINT、Ctrl+Z 是挂起任务,不能被
                // 菜单拦走。本地仪表盘保持注册(键盘编辑行为不变)。
            ].map((it) => (it.role && externalView ? { ...it, registerAccelerator: false } : it)),
        },
        {
            label: tr('appmenu.view'),
            submenu: [
                { role: 'back', label: tr('appmenu.back') },
                { role: 'forward', label: tr('appmenu.forward') },
                { type: 'separator' },
                { role: 'reload', label: tr('appmenu.reload') },
                { role: 'forceReload', label: tr('appmenu.forcereload') },
                { role: 'toggleDevTools', label: tr('appmenu.devtools') },
                { type: 'separator' },
                { role: 'resetZoom', label: tr('appmenu.zoomreset') },
                { role: 'zoomIn', label: tr('appmenu.zoomin') },
                { role: 'zoomOut', label: tr('appmenu.zoomout') },
            ],
        },
        {
            label: tr('appmenu.window'),
            submenu: [
                { role: 'minimize', label: tr('appmenu.minimize') },
                { role: 'close', label: tr('appmenu.close') },
            ],
        },
        {
            label: tr('appmenu.help'),
            submenu: [
                { label: tr('menu.checkUpdate'), click: () => checkForUpdates() },
                { type: 'separator' },
                // 国际惯例:关于放帮助菜单(File 只留退出)。GitHub 入口保留在
                // 关于对话框的按钮里——独立菜单项与之重复,按用户意见撤除。
                { label: tr('menu.about'), click: () => showAbout() },
            ],
        },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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

function winTaskbarDark() {
    // 任务栏深浅由「Windows 模式」(SystemUsesLightTheme)决定,不是「应用模式」;
    // 自定义主题下两者可不同(任务栏深+应用浅),必须读任务栏自己的值。
    try {
        const out = spawnSync('reg', [
            'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize',
            '/v', 'SystemUsesLightTheme'
        ], { encoding: 'utf8', timeout: 2000, windowsHide: true });
        if (out.status === 0) return !/0x1\b/.test(out.stdout || '');
    } catch (e) { /* 读不到 → 退回应用模式 */ }
    return nativeTheme.shouldUseDarkColors;
}

function trayIconImage() {
    // 单色托盘(mac template / win 主题黑白):alpha 即图形(方框描边+10),
    // 与系统菜单栏/任务栏深浅色自适应。缺资产时回落彩色品牌图标。
    if (process.platform === 'darwin') {
        const img = nativeImage.createFromPath(path.join(__dirname, 'icon-template.png'));
        if (!img.isEmpty()) { img.setTemplateImage(true); return img; }
    } else if (process.platform === 'win32') {
        const file = winTaskbarDark() ? 'icon-mono-white.ico' : 'icon-mono-black.ico';
        const img = nativeImage.createFromPath(path.join(__dirname, file));
        if (!img.isEmpty()) return img;
    }
    let icon = nativeImage.createFromPath(path.join(__dirname, 'icon.ico'));
    if (icon.isEmpty()) icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
    if (process.platform === 'darwin') {
        // macOS 菜单栏图标要小
        icon = icon.resize({ width: 16, height: 16 });
    }
    return icon;
}

function createTray() {
    tray = new Tray(trayIconImage());
    rebuildMenu();
    tray.on('click', () => {
        if (state === 'running' || state === 'external') createWindow();
        else if (state === 'stopped') startServer();
    });
    // win 无 template 机制:主题切换时换对应黑白图标
    if (process.platform === 'win32') {
        nativeTheme.on('updated', () => { if (tray) tray.setImage(trayIconImage()); });
    }
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
        setAppMenu();
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
