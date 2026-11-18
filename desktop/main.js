/**
 * 10Router 桌面托盘版 (Electron)
 *
 * 职责:
 *  - 以子进程方式拉起/停止/重启 10Router standalone 服务(cli/app 产物,纯 Node)
 *  - 轮询 /api/health 判断服务就绪
 *  - 托盘图标 + 菜单(打开控制台 / 启动 / 重启 / 停止 / 开机自启 / 数据目录 / 退出)
 *  - 内嵌 BrowserWindow 展示 Web 控制台;尺寸型弹窗就地开窗(同源共享会话,跨域
 *    用一次性无痕分区承载账号授权,参考 CreditDaddy),普通外链走系统默认浏览器
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
const { app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme, shell, dialog, ipcMain, session, safeStorage, net } = require('electron');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPasswordStore } = require('./passwordStore');
const releaseUpdater = require('./releaseUpdater');
const updateRequest = require('./updateRequest');
const updateScheduler = require('./updateScheduler');

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
        'win.authWindowTitle': 'Account Authorization',
        'win.sessionLoginTitle': 'Login (Session {n})',
        'win.sessionLoginReuseTitle': 'Login (Session {n} · Saved)',
        'win.openSiteUrl': 'URL',
        'win.openSiteSlot': 'Slot',
        'win.openSiteShortcuts': 'Shortcuts (click to fill)',
        'win.openSiteTypeUrl': 'Type a URL first',
        'win.authSlotTitle': 'Authorize (Account {n})',
        'win.incognitoLoginTitle': 'Login (Incognito)',
        'sessionPool.open': 'Session Pool',
        'sessionPool.openHint': 'Multiple login slots per site — each slot is an isolated saved session.',
        'sessionPool.slot': 'Session {n}',
        'sessionPool.loginSlot': 'Login (Slot {n})',
        'sessionPool.clearSlot': 'Clear Session {n}',
        'sessionPool.renameSlot': 'Rename',
        'sessionPool.empty': 'No saved session in this slot.',
        'sessionPool.captured': '{name}: session captured (slot {n})',
        'sessionPool.captureFailed': '{name}: session capture failed — please log in again',
        'sessionPool.cleared': '{name}: session {n} cleared',
        'sessionPool.renamed': '{name}: session {n} renamed to {label}',
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
        'update.readyBalloonBody': 'v{latest} has been downloaded and verified in the background — open the tray menu "Check for Updates" and click "Install Now".',
        'update.downloadInstall': 'Download and Install',
        'update.downloadBody': 'v{latest} is available (you are on v{current}).\n\n10Router will download 10Router-Win-Setup-{latest}.exe ({size}) from GitHub Releases, verify its SHA256 and run the installer — the app quits during install.',
        'update.downloadingTitle': 'Downloading v{latest}',
        'update.readyTitle': 'v{latest} is ready to install',
        'update.readyBody': 'The installer has been downloaded and verified.\n\nClick "Install Now" to run it — 10Router quits first and the installer takes over.',
        'update.installNow': 'Install Now',
        'update.downloadFailedTitle': 'Update download failed',
        'update.checksumMismatch': 'SHA256 checksum mismatch — the downloaded installer is corrupted, install aborted.',
        'update.spawnFailedTitle': 'Could not start the installer',
        'update.spawnFailedBody': 'Failed to launch the installer:\n{message}\n\nYou can run it manually:\n{path}',
        'update.sizeUnknown': 'size unknown',
        'update.windowTitle': '10Router Update',
        'update.checking': 'Checking for updates…',
        'update.cancel': 'Cancel',
        'update.retry': 'Retry',
        'about.tagline': 'FREE AI Router & Token Saver',
        'about.detail': 'Shell: v{shell}\nData folder: {dataDir}',
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
        'appmenu.openSite': 'Open Site (with account)…',
        'appmenu.openurl.title': 'Open URL',
        'appmenu.openurl.go': 'Open',
        'appmenu.openurl.invalid': 'Invalid URL — check the address',
        'appmenu.home': 'Back to 10Router',
        'appmenu.recent': 'Recent',
        'appmenu.recent.empty': '(none yet)',
        'appmenu.clearrecent': 'Clear Recent',
        'appmenu.managePw': 'Saved Passwords…',
        'pw.save.title': 'Save password?',
        'pw.save.updateTitle': 'Update password?',
        'pw.save.site': 'Site',
        'pw.save.user': 'Username',
        'pw.save.pass': 'Password',
        'pw.save.save': 'Save',
        'pw.save.update': 'Update',
        'pw.save.never': 'Never for this site',
        'pw.save.notNow': 'Not now',
        'pw.notify.disabled': 'System credential encryption is unavailable — password saving is disabled.',
        'pw.mgr.title': 'Saved Passwords',
        'pw.mgr.empty': 'No saved passwords yet — save on login or add one below.',
        'pw.mgr.add': 'Add',
        'pw.mgr.originPh': 'Site (https://example.com)',
        'pw.mgr.userPh': 'Username',
        'pw.mgr.passPh': 'Password',
        'pw.mgr.keepPw': 'Leave empty to keep current password',
        'pw.mgr.reveal': 'Show',
        'pw.mgr.hide': 'Hide',
        'pw.mgr.copy': 'Copy',
        'pw.mgr.copied': 'Copied',
        'pw.mgr.confirmDel': 'Sure?',
        'pw.mgr.noUser': '(no username)',
        'pw.mgr.fill': 'Fill password: {user}',
        'pw.mgr.invalid': 'Site must be a valid http(s) address',
        'pw.mgr.needPw': 'Password cannot be empty',
        'pw.mgr.err': 'Operation failed',
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
        'win.authWindowTitle': '账号授权',
        'win.sessionLoginTitle': '登录（会话 {n}）',
        'win.sessionLoginReuseTitle': '登录（会话 {n} · 复用）',
        'win.openSiteUrl': '网址',
        'win.openSiteSlot': '账号槽',
        'win.openSiteShortcuts': '常用站点（点击填入）',
        'win.openSiteTypeUrl': '先输入网址',
        'win.authSlotTitle': '授权（账号 {n}）',
        'win.incognitoLoginTitle': '登录（无痕窗口）',
        'sessionPool.open': '会话池',
        'sessionPool.openHint': '每站点多个登录槽——各槽是独立的持久登录会话。',
        'sessionPool.slot': '会话 {n}',
        'sessionPool.loginSlot': '登录（槽 {n}）',
        'sessionPool.clearSlot': '清除会话 {n}',
        'sessionPool.renameSlot': '重命名',
        'sessionPool.empty': '该槽暂无已存会话。',
        'sessionPool.captured': '{name}：会话已捕获（槽 {n}）',
        'sessionPool.captureFailed': '{name}：会话捕获失败——请重新登录',
        'sessionPool.cleared': '{name}：会话 {n} 已清除',
        'sessionPool.renamed': '{name}：会话 {n} 已重命名为 {label}',
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
        'update.readyBalloonBody': 'v{latest} 已在后台下载并通过校验——打开托盘菜单「检查更新」后点击「立即安装」即可。',
        'update.downloadInstall': '下载并安装',
        'update.downloadBody': '新版本 v{latest} 已发布(当前 v{current})。\n\n将从 GitHub Releases 下载 10Router-Win-Setup-{latest}.exe({size}),SHA256 校验通过后运行安装——安装时 10Router 会先退出。',
        'update.downloadingTitle': '正在下载 v{latest}',
        'update.readyTitle': 'v{latest} 安装包已就绪',
        'update.readyBody': '安装包已下载并通过校验。\n\n点击「立即安装」运行安装程序(10Router 会先退出)。',
        'update.installNow': '立即安装',
        'update.downloadFailedTitle': '下载更新失败',
        'update.checksumMismatch': '安装包 SHA256 校验不符,已放弃安装。',
        'update.spawnFailedTitle': '无法启动安装程序',
        'update.spawnFailedBody': '安装程序启动失败:\n{message}\n\n也可以手动运行已下载的安装包:\n{path}',
        'update.sizeUnknown': '大小未知',
        'update.windowTitle': '10Router 更新',
        'update.checking': '正在检查更新…',
        'update.cancel': '取消',
        'update.retry': '重试',
        'about.tagline': 'FREE AI Router & Token Saver',
        'about.detail': '壳版本: v{shell}\n数据目录: {dataDir}',
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
        'appmenu.openSite': '打开服务网址（带账号）…',
        'appmenu.openurl.title': '打开网址',
        'appmenu.openurl.go': '打开',
        'appmenu.openurl.invalid': '网址无效，请检查地址',
        'appmenu.home': '回到 10Router',
        'appmenu.recent': '最近打开',
        'appmenu.recent.empty': '(还没有记录)',
        'appmenu.clearrecent': '清除最近打开',
        'appmenu.managePw': '管理已保存的密码…',
        'pw.save.title': '保存密码？',
        'pw.save.updateTitle': '更新密码？',
        'pw.save.site': '站点',
        'pw.save.user': '用户名',
        'pw.save.pass': '密码',
        'pw.save.save': '保存',
        'pw.save.update': '更新',
        'pw.save.never': '永不保存此站点',
        'pw.save.notNow': '暂不',
        'pw.notify.disabled': '系统凭据加密不可用，密码保存功能已停用。',
        'pw.mgr.title': '已保存的密码',
        'pw.mgr.empty': '还没有已保存的密码。可在网页登录时保存，或在下方手动添加。',
        'pw.mgr.add': '添加',
        'pw.mgr.originPh': '站点（https://example.com）',
        'pw.mgr.userPh': '用户名',
        'pw.mgr.passPh': '密码',
        'pw.mgr.keepPw': '留空则保持原密码',
        'pw.mgr.reveal': '显示',
        'pw.mgr.hide': '隐藏',
        'pw.mgr.copy': '复制',
        'pw.mgr.copied': '已复制',
        'pw.mgr.confirmDel': '确认删除？',
        'pw.mgr.noUser': '（无用户名）',
        'pw.mgr.fill': '填充密码：{user}',
        'pw.mgr.invalid': '站点必须是合法的 http(s) 地址',
        'pw.mgr.needPw': '密码不能为空',
        'pw.mgr.err': '操作失败',
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
        'win.authWindowTitle': '帳號授權',
        'win.sessionLoginTitle': '登入（工作階段 {n}）',
        'win.sessionLoginReuseTitle': '登入（工作階段 {n} · 復用）',
        'win.openSiteUrl': '網址',
        'win.openSiteSlot': '帳號槽',
        'win.openSiteShortcuts': '常用站點（點擊填入）',
        'win.openSiteTypeUrl': '請先輸入網址',
        'win.authSlotTitle': '授權（帳號 {n}）',
        'win.incognitoLoginTitle': '登入（無痕視窗）',
        'sessionPool.open': '工作階段池',
        'sessionPool.openHint': '每站點多個登入槽——各槽是獨立的持久登入工作階段。',
        'sessionPool.slot': '工作階段 {n}',
        'sessionPool.loginSlot': '登入（槽 {n}）',
        'sessionPool.clearSlot': '清除工作階段 {n}',
        'sessionPool.renameSlot': '重新命名',
        'sessionPool.empty': '該槽暫無已存工作階段。',
        'sessionPool.captured': '{name}：工作階段已擷取（槽 {n}）',
        'sessionPool.captureFailed': '{name}：工作階段擷取失敗——請重新登入',
        'sessionPool.cleared': '{name}：工作階段 {n} 已清除',
        'sessionPool.renamed': '{name}：工作階段 {n} 已重新命名為 {label}',
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
        'update.readyBalloonBody': 'v{latest} 已在背景下載並通過校驗——開啟系統列選單「檢查更新」後點擊「立即安裝」即可。',
        'update.downloadInstall': '下載並安裝',
        'update.downloadBody': '新版本 v{latest} 已發布(目前 v{current})。\n\n將從 GitHub Releases 下載 10Router-Win-Setup-{latest}.exe({size}),SHA256 校驗通過後執行安裝——安裝時 10Router 會先結束。',
        'update.downloadingTitle': '正在下載 v{latest}',
        'update.readyTitle': 'v{latest} 安裝包已就緒',
        'update.readyBody': '安裝包已下載並通過校驗。\n\n點擊「立即安裝」執行安裝程式(10Router 會先結束)。',
        'update.installNow': '立即安裝',
        'update.downloadFailedTitle': '下載更新失敗',
        'update.checksumMismatch': '安裝包 SHA256 校驗不符,已放棄安裝。',
        'update.spawnFailedTitle': '無法啟動安裝程式',
        'update.spawnFailedBody': '安裝程式啟動失敗:\n{message}\n\n也可以手動執行已下載的安裝包:\n{path}',
        'update.sizeUnknown': '大小未知',
        'update.windowTitle': '10Router 更新',
        'update.checking': '正在檢查更新…',
        'update.cancel': '取消',
        'update.retry': '重試',
        'about.tagline': 'FREE AI Router & Token Saver',
        'about.detail': '殼版本: v{shell}\n資料目錄: {dataDir}',
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
        'appmenu.openSite': '開啟服務網址（帶帳號）…',
        'appmenu.openurl.title': '開啟網址',
        'appmenu.openurl.go': '開啟',
        'appmenu.openurl.invalid': '網址無效，請檢查地址',
        'appmenu.home': '回到 10Router',
        'appmenu.recent': '最近開啟',
        'appmenu.recent.empty': '(還沒有記錄)',
        'appmenu.clearrecent': '清除最近開啟',
        'appmenu.managePw': '管理已儲存的密碼…',
        'pw.save.title': '儲存密碼？',
        'pw.save.updateTitle': '更新密碼？',
        'pw.save.site': '站點',
        'pw.save.user': '使用者名稱',
        'pw.save.pass': '密碼',
        'pw.save.save': '儲存',
        'pw.save.update': '更新',
        'pw.save.never': '永不儲存此站點',
        'pw.save.notNow': '暫不',
        'pw.notify.disabled': '系統憑證加密不可用，密碼儲存功能已停用。',
        'pw.mgr.title': '已儲存的密碼',
        'pw.mgr.empty': '還沒有已儲存的密碼。可在網頁登入時儲存，或在下方手動新增。',
        'pw.mgr.add': '新增',
        'pw.mgr.originPh': '站點（https://example.com）',
        'pw.mgr.userPh': '使用者名稱',
        'pw.mgr.passPh': '密碼',
        'pw.mgr.keepPw': '留空則保持原密碼',
        'pw.mgr.reveal': '顯示',
        'pw.mgr.hide': '隱藏',
        'pw.mgr.copy': '複製',
        'pw.mgr.copied': '已複製',
        'pw.mgr.confirmDel': '確認刪除？',
        'pw.mgr.noUser': '（無使用者名稱）',
        'pw.mgr.fill': '填入密碼：{user}',
        'pw.mgr.invalid': '站點必須是合法的 http(s) 位址',
        'pw.mgr.needPw': '密碼不能為空',
        'pw.mgr.err': '操作失敗',
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

// 磁盘版本标记（与 npm CLI / fpk 安装路径对齐）：内容 = 内嵌服务（resources/app）的版本。
// 桌面版不走 cli/cli.js（直接 spawn custom-server.js），没人替它写这个标记，
// 于是仪表盘的「已安装版本 ≠ 运行中构建」横幅在桌面安装上永远不会亮 —— 而那正是
// chunk 500 白屏（issue #24）最需要被提示的场景：壳已经换成新构建，旧的服务进程
// 还占着端口在服务（HTML 引的 chunk 已从磁盘删除）。写失败不致命，横幅退化成不显示。
function writeDiskVersionMarker() {
    try {
        const version = getServiceVersion();
        if (!version) return;
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(path.join(DATA_DIR, '.disk-version'), version, 'utf8');
    } catch (err) {
        log(`disk-version marker write failed: ${err && err.message}`);
    }
}

async function startServer() {
    if (nodeProc || state === 'running' || state === 'starting') return;

    // 先落盘版本标记，再判断端口：即使下面走「端口已被外部服务占用」分支
    // （旧版服务还在跑），运行中的旧服务也能读到新版本并亮出横幅。
    writeDiskVersionMarker();

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
        scheduleBackgroundUpdateChecks();     // 后台定时检查更新(30s 首检 + 6h 轮询,预下载不自动装)
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

// ──────────────────────── 授权/弹窗窗体（参考 CreditDaddy） ────────────────────────
// 界面里 window.open 弹出的尺寸型窗口(features 带 width/height)就地开子窗:
//  - 同源(与发起页同 origin)→ 普通子窗,继承发起页 session——仪表盘 cookie 罐共享,
//    MiMo 服务端登录页(/mimo-login/*)依赖这一点,绝不能隔离;
//  - 跨域 → 一次性「账号授权」无痕窗:随机内存态 session 分区(不带 persist: 前缀
//    =不落盘,进程退出即消失),关窗即清存储——供应商登录态不进主窗、多账号互不串;
//    同一登录流程里站点自弹的子窗(第三方账号选择/二次验证)复用同一分区(CreditDaddy
//    的 openIncognitoWindow 语义);
//  - 无尺寸的 _blank(文档/验证页等普通链接)保持原语义:丢系统默认浏览器。
// 渲染层拿到的都是真 WindowProxy(window.open 返回值与 .closed 照常可用),仪表盘零改动。
function sameOriginUrl(a, b) {
    try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}

// ──────────────────────── 会话池(每站点 9 个登录槽) ────────────────────────
// Chrome 多 profile 式:同一站点并排养多个独立持久登录分区,换号 = 选另一槽开窗,
// 不再来回清登录态。分区命名 cookie-site-<id>(槽 1)/ cookie-site-<id>-sN(槽 2-9);
// 收割的 cookie 带 slot 上报,落连接 providerSpecificData.cookieSlot,面板按槽分行。
// 设计对齐 CreditDaddy 会话池(两仓同 AGPL-3.0),实现按本仓结构重写。
const SESSION_POOL_SLOTS = 9;

function cookieSiteSlotOf(persistKey) {
    const m = /-s([2-9])$/.exec(persistKey || '');
    return m ? Number(m[1]) : 1;
}

function cookieSitePersistKey(siteId, slot) {
    const n = Math.min(Math.max(Number(slot) || 1, 1), SESSION_POOL_SLOTS);
    return n === 1 ? `cookie-site-${siteId}` : `cookie-site-${siteId}-s${n}`;
}

function serializeSessionCookies(cookies) {
    const byName = new Map();
    for (const c of cookies || []) {
        if (c && typeof c.name === 'string' && c.name) byName.set(c.name, String(c.value ?? ''));
    }
    return [...byName.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

// CLI token:与 CLI 客户端同式(machineId + '9r-cli-auth' + cli-secret → sha256 前 16 位)。
// 桌面壳与 CLI/服务同机同 DATA_DIR,读同一对文件即可;读不到机器号时退空(上报会 401,
// 由面板重登解决,不阻塞收割)。
function readCliTokenForReport() {
    try {
        const mid = fs.readFileSync(path.join(DATA_DIR, 'machine-id'), 'utf8').trim();
        const secret = fs.readFileSync(path.join(DATA_DIR, 'auth', 'cli-secret'), 'utf8').trim();
        if (!mid) return '';
        return crypto.createHash('sha256').update(mid + '9r-cli-auth' + secret).digest('hex').substring(0, 16);
    } catch { return ''; }
}

// 关窗时收割该持久分区的全量 cookie(不过滤 URL——带 Path 域的会话 cookie 按 URL
// 过滤会丢),带 slot 上报 /api/cookie-sites/<site>(POST=capture)。持久分区不擦存储
// (复用登录态正是其意义);由面板「清除会话」显式抹除。
async function harvestCookieSiteSession(ses, siteId, slot) {
    let all = [];
    try { all = await ses.cookies.get({}); } catch { /* 分区已随窗销毁 */ }
    const cookie = serializeSessionCookies(all);
    if (!cookie) return { ok: false, error: 'empty' };
    const token = readCliTokenForReport();
    try {
        const r = await net.fetch(`${BASE_URL}/api/cookie-sites/${encodeURIComponent(siteId)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(token ? { 'x-10r-cli-token': token } : {}) },
            body: JSON.stringify({ cookie, slot }),
            signal: AbortSignal.timeout(10000),
        });
        const detail = await r.json().catch(() => ({}));
        return { ok: r.ok, status: r.status, error: detail.error || (r.ok ? '' : `HTTP ${r.status}`) };
    } catch (e) {
        return { ok: false, error: e?.cause?.code || e?.message || String(e) };
    }
}

// 打开站点登录窗(会话池入口):persistKey → 持久分区复用登录态;slot 计标题。
// 与 attachWindowOpenRouting 的一次性授权窗区分:那是仪表盘 window.open 的跨域兜底,
// 本窗由「会话池 / 登录」显式打开,可重复使用。
function openSiteLoginWindow(site, slot) {
    const persistKey = cookieSitePersistKey(site.id, slot);
    const n = cookieSiteSlotOf(persistKey);
    const ses = session.fromPartition('persist:' + persistKey);
    const authWin = new BrowserWindow({
        width: 480,
        height: 720,
        title: tr(n > 1 ? 'win.sessionLoginReuseTitle' : 'win.sessionLoginTitle', { n }),
        autoHideMenuBar: true,
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#FDFAF6',
        webPreferences: {
            session: ses,
            preload: CONTAINER_PRELOAD,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    attachContainerCapture(authWin.webContents);
    attachContextMenu(authWin);
    authWin.webContents.setWindowOpenHandler(({ url: subUrl }) => {
        if (/^https:\/\//i.test(subUrl)) {
            return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { session: ses, preload: CONTAINER_PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true } } };
        }
        return { action: 'deny' };
    });
    authWin.on('closed', () => {
        // 注册站点:收割上报(落连接行,面板可见)。通用网址:不 harvest——
        // 持久分区自存 Cookie,同槽再开直接复用登录态。
        if (!site.provider) return;
        harvestCookieSiteSession(ses, site.id, n).then((res) => {
            try {
                if (win && !win.isDestroyed()) {
                    win.webContents.send('cookie-site:captured', { site: site.id, slot: n, ok: res.ok, error: res.error || '' });
                }
            } catch { /* 主窗已关 */ }
            notify(tr('sessionPool.open'), tr(res.ok ? 'sessionPool.captured' : 'sessionPool.captureFailed', { name: site.name, n }));
        });
    });
    authWin.loadURL(site.loginUrl);
    return authWin;
}

function attachWindowOpenRouting(openerContents, fixedSession) {
    openerContents.setWindowOpenHandler(({ url, features }) => {
        if (!/^https?:/i.test(url)) return { action: 'deny' };
        // 只有真正带尺寸的弹窗才进壳内;普通 _blank 链接维持系统浏览器
        if (!/(?:^|,)\s*width\s*=/.test(features || '')) {
            shell.openExternal(url);
            return { action: 'deny' };
        }
        // 授权弹窗带 authslot=N(features 里未知键 Chromium 会忽略,只到得了 handler):
        // 开进该持久身份分区,不清存储——同槽下次授权免登录。回调链不变(opener 保留)。
        const slotM = /(?:^|,)\s*authslot=(\d+)/.exec(features || '');
        if (slotM && !fixedSession) {
            const n = Math.min(Math.max(Number(slotM[1]) || 1, 1), SESSION_POOL_SLOTS);
            const slotSes = session.fromPartition(`persist:auth-slot-${n}`);
            openerContents.once('did-create-window', (child) => {
                attachWindowOpenRouting(child.webContents, slotSes);
                attachContainerCapture(child.webContents);
                attachContextMenu(child);
            });
            return {
                action: 'allow',
                overrideBrowserWindowOptions: {
                    autoHideMenuBar: true,
                    title: tr('win.authSlotTitle', { n }),
                    webPreferences: {
                        session: slotSes,
                        preload: CONTAINER_PRELOAD,
                        contextIsolation: true,
                        nodeIntegration: false,
                        sandbox: true,
                    },
                },
            };
        }
        if (fixedSession) {
            // 无痕授权流程内站点自弹的子窗:复用同一分区;不清存储(随顶层授权窗关闭统一清)
            openerContents.once('did-create-window', (child) => {
                attachWindowOpenRouting(child.webContents, fixedSession);
                attachContainerCapture(child.webContents);
                attachContextMenu(child);
            });
            return {
                action: 'allow',
                overrideBrowserWindowOptions: {
                    autoHideMenuBar: true,
                    webPreferences: {
                        session: fixedSession,
                        preload: CONTAINER_PRELOAD,
                        contextIsolation: true,
                        nodeIntegration: false,
                        sandbox: true,
                    },
                },
            };
        }
        let openerUrl = '';
        try { openerUrl = openerContents.getURL(); } catch { /* 读不到就当跨域处理 */ }
        const childSession = sameOriginUrl(openerUrl, url)
            ? undefined
            : session.fromPartition('auth-' + crypto.randomUUID());
        openerContents.once('did-create-window', (child) => {
            attachWindowOpenRouting(child.webContents, childSession);
            attachContainerCapture(child.webContents);
            attachContextMenu(child);
            if (childSession) {
                // 顶层无痕授权窗关闭 = 本次登录流程结束:清掉该分区的全部存储
                child.on('closed', () => {
                    try { childSession.clearStorageData().catch(() => { }); } catch { }
                });
            }
        });
        return {
            action: 'allow',
            overrideBrowserWindowOptions: {
                autoHideMenuBar: true,
                ...(childSession ? { title: tr('win.authWindowTitle') } : {}),
                webPreferences: {
                    ...(childSession ? { session: childSession } : {}),
                    preload: CONTAINER_PRELOAD,
                    contextIsolation: true,
                    nodeIntegration: false,
                    sandbox: true,
                },
            },
        };
    });
}

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
    // 窗口底色跟随系统日/夜(Windows 个性化 / macOS 外观),与页面内联引导脚本
    // 的首帧配色一致,避免亮色系统下开窗先闪黑;系统切换时实时跟随。
    const shellBg = () => (nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#FDFAF6');
    win = new BrowserWindow({
        width: 1380,
        height: 880,
        title: '10Router',
        autoHideMenuBar: true,
        icon: path.join(__dirname, 'icon.ico'),
        backgroundColor: shellBg(),
        show: false,
        webPreferences: {
            preload: CONTAINER_PRELOAD,   // 容器密码管理:捕获/自动填充(见下方密码管理段)
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    nativeTheme.on('updated', () => {
        try { if (win && !win.isDestroyed()) win.setBackgroundColor(shellBg()); } catch { /* 非致命 */ }
    });
    win.once('ready-to-show', () => win.show());
    attachWindowOpenRouting(win.webContents, null);
    attachContainerCapture(win.webContents);
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

// net.fetch 没有默认超时：GitHub release 资产实际托管在 objects.githubusercontent.com
// （browser_download_url 302 跳过去），国内网络下常是「挂起」而非「报错」——
// 裸 fetch 会无限卡住，这正是更新下载卡死的根因（CreditDaddy 走 npm 国内镜像所以流畅）。
// 这里包一层：合并调用方 signal（关窗取消）与固定超时，任一触发即 abort。
// 用 AbortController + setTimeout 手动合并（不依赖 AbortSignal.timeout/any，
// Electron net.fetch 的 Chromium 网络栈对这两个新 API 兼容性未经验证）。
function fetchWithTimeout(url, timeoutMs, init = {}) {
    const { signal, ...rest } = init || {};
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
    let onAbort = null;
    if (signal) {
        if (signal.aborted) {
            clearTimeout(timer);
            ctrl.abort(signal.reason);
        } else {
            onAbort = () => { clearTimeout(timer); ctrl.abort(signal.reason); };
            signal.addEventListener('abort', onAbort);
        }
    }
    const p = net.fetch(url, { ...rest, signal: ctrl.signal });
    p.finally(() => {
        clearTimeout(timer);
        if (onAbort) signal.removeEventListener('abort', onAbort);
    });
    return p;
}

// ──────────────────────── 应用内更新窗（统一 HTML 承载更新全流程） ─────────────
// 一个无边框小窗(update-window.html + preload-update.js)承载整个状态机:
//   checking → available(manual=只引导 Releases / download=可下载安装)
//            → downloading(进度+取消) → ready(立即安装/稍后) → 安装退出
//        任意节点 ↘ latest(已最新) / error(重试 / 打开 Releases)
// 关窗即取消下载(AbortController);页面无 nodeIntegration(contextIsolation +
// sandbox + preload 白名单 API),文案全部主进程 tr() 渲染后 IPC 推送——tr() 单源,
// 页面只做展示。替代旧的原生 dialog/数据 URL 进度窗。
const UPDATE_HTML = path.join(__dirname, 'update-window.html');
const UPDATE_PRELOAD = path.join(__dirname, 'preload-update.js');
let updateWin = null;
let updateDlCtrl = null;                       // 下载中的 AbortController(关窗/取消 → abort)
let backgroundDlCtrl = null;                   // 后台静默预下载的 AbortController(手动下载启动时 abort,防两路并发写同一临时文件)
let updateView = { state: 'checking' };        // 最近一次推给页面的状态(页面晚加载时由 bootstrap 补发)
let updateCtx = { phase: 'check', inst: null, file: null };   // error 态「重试」所需的上下文

function sendUpdateState(state, extra) {
    updateView = { state, ...(extra || {}) };
    try {
        if (updateWin && !updateWin.isDestroyed()) updateWin.webContents.send('update:state', updateView);
    } catch { /* 窗口可能已关 */ }
}

// 页面静态按钮/标题文案(bootstrap 一次性下发);带参数的正文在各状态 payload 里现算
function updateStrings() {
    return {
        windowTitle: tr('update.windowTitle'),
        downloadInstall: tr('update.downloadInstall'),
        openReleases: tr('update.openReleases'),
        later: tr('dialog.later'),
        ok: tr('dialog.ok'),
        cancel: tr('update.cancel'),
        retry: tr('update.retry'),
        close: tr('dialog.close'),
    };
}

function clearUpdateProgress() {
    try { if (updateWin && !updateWin.isDestroyed()) updateWin.setProgressBar(-1); } catch { /* ignore */ }
}

function openUpdateWindow() {
    if (updateWin && !updateWin.isDestroyed()) {
        updateWin.show();
        updateWin.focus();
        return;
    }
    updateWin = new BrowserWindow({
        width: 420,
        height: 360,
        useContentSize: true,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        frame: false,                      // 页面内自定义标题栏(拖拽区 + 关闭按钮)
        title: tr('update.windowTitle'),
        autoHideMenuBar: true,
        show: false,
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#FDFAF6',   // 与仪表盘 --color-bg(globals.css)一致
        webPreferences: {
            preload: UPDATE_PRELOAD,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    updateWin.once('ready-to-show', () => { try { if (updateWin && !updateWin.isDestroyed()) updateWin.show(); } catch { /* ignore */ } });
    // 本地 file 页面:外链/导航一律拦死(「打开 Releases」走主进程 shell.openExternal)
    updateWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    updateWin.webContents.on('will-navigate', (e, url) => {
        if (!String(url).startsWith('file://')) e.preventDefault();
    });
    updateWin.on('closed', () => {
        // 关窗即取消下载
        if (updateDlCtrl) { try { updateDlCtrl.abort(); } catch { /* ignore */ } updateDlCtrl = null; }
        updateWin = null;
    });
    updateWin.loadFile(UPDATE_HTML).catch((e) => {
        log(`update window load failed: ${e && e.message}`);
        try { updateWin.close(); } catch { /* ignore */ }
    });
}

// 页面 bootstrap:一次性静态文案 + 当前状态(页面可能比状态推送晚完成加载)
ipcMain.handle('update:bootstrap', (e) => {
    if (!updateWin || updateWin.isDestroyed() || e.sender !== updateWin.webContents) return null;
    return { strings: updateStrings(), view: updateView };
});

// 页面量好内容高度后回报,窗口按状态贴合(各态高度不同,宽度恒 420)
ipcMain.on('update:fit', (e, height) => {
    if (!updateWin || updateWin.isDestroyed() || e.sender !== updateWin.webContents) return;
    const h = Math.max(200, Math.min(640, Math.ceil(Number(height) || 0)));
    try { updateWin.setContentSize(420, h); } catch { /* ignore */ }
});

ipcMain.on('update:action', (e, msg) => {
    if (!updateWin || updateWin.isDestroyed() || e.sender !== updateWin.webContents) return;
    const action = msg && msg.action;
    if (action === 'close' || action === 'later') { updateWin.close(); return; }
    if (action === 'cancel') {
        if (updateDlCtrl) { try { updateDlCtrl.abort(); } catch { /* ignore */ } updateDlCtrl = null; }
        updateWin.close();   // closed 处理器兜底 abort,语义与关窗一致
        return;
    }
    if (action === 'open-releases') { shell.openExternal(RELEASES_URL); return; }
    if (action === 'download') { if (updateCtx.inst && !updateDlCtrl) startUpdateDownload(updateCtx.inst); return; }
    if (action === 'install') { installDownloadedUpdate(); return; }
    if (action === 'retry') retryUpdatePhase();
});

function retryUpdatePhase() {
    if (updateCtx.phase === 'download' && updateCtx.inst) { startUpdateDownload(updateCtx.inst); return; }
    if (updateCtx.phase === 'install' && updateCtx.file) { installDownloadedUpdate(); return; }
    checkForUpdates();   // phase === 'check':重跑完整检查流程
}

// 检查更新:主路径走本地服务 /api/version(免鉴权,带 npm latest 1h 缓存),
// 与 fpk/CLI 同一数据源。Windows 安装版发现新版本后可直接下载对应 release 的
// 10Router-Win-Setup-<版本>.exe(SHA256 校验)并运行安装,不再只引导去 Releases 页;
// 本地服务不在时直查 GitHub Releases API 兜底。release 缺安装包、macOS、
// Portable 则维持「打开 Releases 页面」的旧引导。
async function checkForUpdates() {
    openUpdateWindow();
    const prevPhase = updateCtx.phase;
    const prevInst = updateCtx.inst;
    const prevFile = updateCtx.file;
    updateCtx.phase = 'check';
    sendUpdateState('checking', { title: tr('update.checking') });
    let info = null;
    try {
        // ?check=1:手动检查是明确操作,即使「设置 → 安全」关闭了自动检查更新也照常查询。
        info = await fetchJson(`${BASE_URL}/api/version?check=1`);
    } catch { /* 服务未运行/网络失败 */ }
    if (!info || !info.currentVersion) {
        await checkUpdateViaGitHub();
        return;
    }
    if (info.hasUpdate) {
        // 后台已为本版本预下载过安装包 → 直接进 ready 态（秒装，不重新下载）
        if (updateScheduler.canReuseDownloadedInstaller({
            phase: prevPhase,
            instVersion: prevInst ? prevInst.version : null,
            fileExists: !!prevFile && fs.existsSync(prevFile),
            latestVersion: info.latestVersion,
        })) {
            updateCtx.phase = 'install';
            updateCtx.inst = prevInst;
            updateCtx.file = prevFile;
            sendUpdateState('ready', {
                title: tr('update.readyTitle', { latest: info.latestVersion }),
                body: tr('update.readyBody'),
                installLabel: tr('update.installNow'),
            });
            return;
        }
        await offerUpdate(info.latestVersion, info.currentVersion);
    } else {
        sendUpdateState('latest', {
            title: tr('update.latestTitle'),
            body: tr('update.latestBody', { current: info.currentVersion }),
        });
    }
}

// 壳内可自更新的形态:Windows 安装版(NSIS)。Portable 是覆盖式解压,自装安装包
// 会双份并存;macOS 未签名没有可静默接管的安装流程——两者都只引导手动下载。
function canInstallInPlace() {
    return process.platform === 'win32' && !process.env.PORTABLE_EXECUTABLE_DIR;
}

// v<latestVersion> 对应 release 里的安装包描述(SHA256SUMS 优先,回落资产 digest)。
// npm 已发而 GitHub release 还没建时 404,抛给调用方退回手动引导。
async function resolveInstaller(latestVersion, preloadedRelease) {
    let rel = preloadedRelease;
    if (!rel) {
        const res = await fetchWithTimeout(`https://api.github.com/repos/techysy/10router/releases/tags/v${latestVersion}`, 15000, { headers: { Accept: 'application/vnd.github+json' } });
        if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
        rel = await res.json();
    }
    return releaseUpdater.pickInstaller(rel);
}

async function offerUpdate(latestVersion, currentVersion) {
    let inst = null;
    if (canInstallInPlace()) {
        try { inst = await resolveInstaller(latestVersion); } catch { /* release 未发布/网络失败 → 手动引导 */ }
    }
    if (inst) {
        offerDownloadableUpdate(inst, currentVersion);
    } else {
        offerManualUpdate(latestVersion, currentVersion);
    }
}

// 手动引导:应用内装不了(macOS / Portable / release 缺安装包),只给「打开 Releases」
function offerManualUpdate(latestVersion, currentVersion) {
    sendUpdateState('available', {
        mode: 'manual',
        version: latestVersion,
        title: tr('update.availableTitle'),
        body: tr('update.availableBody', { latest: latestVersion, current: currentVersion }),
    });
}

// 可下载:给「下载并安装 / 打开 Releases / 稍后」,下载走 startUpdateDownload
function offerDownloadableUpdate(inst, currentVersion) {
    updateCtx.inst = inst;
    const sizeText = inst.asset.size ? `≈${(inst.asset.size / 1048576).toFixed(1)} MB` : tr('update.sizeUnknown');
    sendUpdateState('available', {
        mode: 'download',
        version: inst.version,
        title: tr('update.availableTitle'),
        body: tr('update.downloadBody', { latest: inst.version, current: currentVersion, size: sizeText }),
    });
}

// 下载安装包到临时目录(进度推更新窗 + 任务栏进度条,关窗/取消即 abort),
// SHA256 校验通过返回文件路径
async function downloadInstallerToTemp(inst, onProgress, signal) {
    let expectedSha = inst.expectedSha || null;
    if (inst.sumsUrl) {
        try {
            const sumsRes = await fetchWithTimeout(inst.sumsUrl, 30000, { signal });
            if (sumsRes.ok) expectedSha = releaseUpdater.resolveExpectedSha(inst, await sumsRes.text());
        } catch { /* sums 拉不到就回落资产 digest,再没有只能跳过校验 */ }
    }
    const res = await fetchWithTimeout(inst.asset.url, 60 * 60 * 1000, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || inst.asset.size || 0;
    const chunks = [];
    let got = 0;
    if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        for (;;) {
            let chunk;
            try {
                chunk = await reader.read();
            } catch (err) {
                // 网络中断/超时：reader 抛的不一定是 AbortError（Chromium 网络栈
                // 对已 abort 的流常抛 TypeError/其他），但只要是下载尚未完成的失败
                // 都按「可重试的失败」处理，绝不能在这里挂死或当成校验通过。
                reader.cancel().catch(() => {});
                throw err;
            }
            const { done, value } = chunk;
            if (done) break;
            chunks.push(Buffer.from(value));
            got += value.length;
            if (onProgress) onProgress(got, total);
        }
    } else {
        const buf = Buffer.from(await res.arrayBuffer());
        chunks.push(buf);
        if (onProgress) onProgress(buf.length, buf.length);
    }
    const buf = Buffer.concat(chunks);
    if (expectedSha && crypto.createHash('sha256').update(buf).digest('hex') !== expectedSha) {
        throw new Error(tr('update.checksumMismatch'));
    }
    const file = path.join(app.getPath('temp'), inst.asset.name);
    fs.writeFileSync(file, buf);
    return file;
}

// 下载中:进度推页(got/total,页面格式化 % 与 MB)+ 任务栏进度条;
// 关窗/取消按钮 → AbortController → 静默结束;失败 → error 态(可重试)
function startUpdateDownload(inst) {
    // 后台静默预下载在途则先中止（它无 UI、失败静默等下个周期）——两路并发写
    // 同一个 temp 安装包文件会互相损坏
    if (backgroundDlCtrl) {
        try { backgroundDlCtrl.abort(); } catch { /* noop */ }
        backgroundDlCtrl = null;
    }
    updateCtx.phase = 'download';
    const ctrl = new AbortController();
    updateDlCtrl = ctrl;
    const title = tr('update.downloadingTitle', { latest: inst.version });
    const push = (got, total) => {
        sendUpdateState('downloading', { title, file: inst.asset.name, got, total });
        try {
            if (updateWin && !updateWin.isDestroyed()) updateWin.setProgressBar(total ? Math.min(1, got / total) : 2);
        } catch { /* 窗口可能已关 */ }
    };
    push(0, inst.asset.size || 0);
    downloadInstallerToTemp(inst, push, ctrl.signal)
        .then((file) => {
            updateDlCtrl = null;
            clearUpdateProgress();
            updateCtx.phase = 'install';
            updateCtx.file = file;
            sendUpdateState('ready', {
                title: tr('update.readyTitle', { latest: inst.version }),
                body: tr('update.readyBody'),
                installLabel: tr('update.installNow'),
            });
        })
        .catch((err) => {
            updateDlCtrl = null;
            clearUpdateProgress();
            // 关窗/取消按钮都会先关窗再 abort：窗口没了就当用户主动放弃，静默。
            if (!updateWin || updateWin.isDestroyed()) return;
            if ((err && err.name) === 'AbortError') return;
            // 清理下载到一半的临时文件（若有），避免 temp 里堆积脏文件。
            try {
                const tmp = path.join(app.getPath('temp'), inst.asset.name);
                if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
            } catch { /* best effort */ }
            sendUpdateState('error', {
                title: tr('update.downloadFailedTitle'),
                detail: String((err && err.message) || err),
            });
        });
}

// 就绪态「立即安装」:先确定性停 sidecar 再起安装器(文件锁必须先释放,
// 同路径注释见文件尾部 before-quit);失败回落 error 态,可重试。
async function installDownloadedUpdate() {
    const file = updateCtx.file;
    if (!file || !fs.existsSync(file)) {
        sendUpdateState('error', {
            title: tr('update.spawnFailedTitle'),
            detail: tr('update.spawnFailedBody', { message: 'Installer file not found', path: file || '' }),
        });
        return;
    }
    try {
        // 先停服务再 spawn:安装器到达卸载/替换阶段时文件锁必须已经释放。
        await stopServer();
        const child = spawn(file, [], { detached: true, stdio: 'ignore' });
        child.on('error', (e) => {
            sendUpdateState('error', {
                title: tr('update.spawnFailedTitle'),
                detail: tr('update.spawnFailedBody', { message: String((e && e.message) || e), path: file }),
            });
        });
        child.unref();
        app.quit();   // 先退出再让安装器接管;NSIS 遇到残留进程也会引导关闭
    } catch (e) {
        sendUpdateState('error', {
            title: tr('update.spawnFailedTitle'),
            detail: tr('update.spawnFailedBody', { message: String((e && e.message) || e), path: file }),
        });
    }
}

// /api/version 不可达(服务没起/挂了)时的兜底:直查 GitHub 最新正式 release,
// 与当前壳/服务版本比;两路都通时 GitHub 只是备份口径,不改变 npm 为主的数据源。
async function checkUpdateViaGitHub() {
    try {
        const res = await fetchWithTimeout('https://api.github.com/repos/techysy/10router/releases/latest', 15000, { headers: { Accept: 'application/vnd.github+json' } });
        if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
        const rel = await res.json();
        const inst = releaseUpdater.pickInstaller(rel);
        const current = getServiceVersion();
        if (!inst || !releaseUpdater.isNewerVersion(inst.version, current)) {
            sendUpdateState('latest', {
                title: tr('update.latestTitle'),
                body: tr('update.latestBody', { current }),
            });
            return;
        }
        if (canInstallInPlace()) {
            offerDownloadableUpdate(inst, current);
        } else {
            offerManualUpdate(inst.version, current);
        }
    } catch (e) {
        sendUpdateState('error', {
            title: tr('update.failedTitle'),
            detail: `${tr('update.failedBody')}\n\n${String((e && e.message) || e)}`,
        });
    }
}

// ───────────────── 后台定时检查更新（预下载，不自动安装） ─────────────────
// 对齐 CreditDaddy 的「定时检查 + 预下载」，但不自动装：10R 是常驻网关，
// 静默重启会掐断正在跑的 agent 会话，安装始终由用户点「立即安装」触发。
// 后台路径绝不打开更新窗（sendUpdateState 在窗口未开时只落 updateView，
// 用户之后手动开窗经 update:bootstrap 即见最新状态），所有失败一律静默。
let backgroundUpdateTimer = null;
let backgroundCheckInFlight = false;
let lastNotifiedUpdateVersion = null;

// 设置「自动检查更新」的镜像 marker（src/lib/updateCheck.js 同步写入）。
// 直读文件而非问 /api/version：服务未起/挂了时判定依然正确。
function autoUpdateCheckDisabled() {
    try {
        return fs.existsSync(updateScheduler.updateCheckDisabledMarkerPath(DATA_DIR));
    } catch { return false; }
}

async function backgroundCheckForUpdates() {
    if (backgroundCheckInFlight) return;
    // 每次触发前重读开关：设置里关闭后，已挂着的定时器不再产生任何查询
    // （手动「检查更新」走强制刷新参数，不受此开关影响）。
    if (!updateScheduler.shouldRunBackgroundCheck({ markerExists: autoUpdateCheckDisabled() })) return;
    backgroundCheckInFlight = true;
    try {
        // 普通探测(无强制刷新参数):后台路径尊重服务端开关与 1h 缓存,不主动打 npm registry
        const info = await fetchJson(`${BASE_URL}/api/version`);
        if (!info || !info.hasUpdate || !info.latestVersion) {
            lastNotifiedUpdateVersion = null;
            return;
        }
        const action = updateScheduler.resolveBackgroundUpdateAction({
            hasUpdate: true,
            latestVersion: info.latestVersion,
            canInstallInPlace: canInstallInPlace(),
            alreadyReadyForVersion: updateCtx.phase === 'install'
                && updateCtx.inst && updateCtx.inst.version === info.latestVersion
                && !!updateCtx.file && fs.existsSync(updateCtx.file),
        });
        if (action === 'pre-download') {
            // 前台正在手动下载中则避让，不发起并发预下载
            if (!updateDlCtrl && !backgroundDlCtrl) {
                await backgroundPreDownload(info.latestVersion);
            }
        } else if (action === 'notify-ready') {
            if (lastNotifiedUpdateVersion !== info.latestVersion) {
                lastNotifiedUpdateVersion = info.latestVersion;
                notify(
                    tr('update.readyTitle', { latest: info.latestVersion }),
                    tr('update.readyBalloonBody', { latest: info.latestVersion })
                );
            }
        } else if (action === 'notify-only') {
            if (lastNotifiedUpdateVersion !== info.latestVersion) {
                lastNotifiedUpdateVersion = info.latestVersion;
                notify(
                    tr('update.availableTitle'),
                    tr('update.balloonBody', { latest: info.latestVersion, current: info.currentVersion })
                );
            }
        }
    } catch { /* 后台路径绝不打扰用户 */ } finally {
        backgroundCheckInFlight = false;
    }
}

// 静默预下载:无进度 UI(downloadInstallerToTemp 的 onProgress 传 null 即可,
// SHA256 校验内建),成功后 updateCtx 进入 install 态——用户点「立即安装」秒装。
async function backgroundPreDownload(latestVersion) {
    if (updateDlCtrl || backgroundDlCtrl) return;
    let inst = null;
    try {
        inst = await resolveInstaller(latestVersion);
    } catch { /* release 未发布 / 网络失败 → 静默,等下个周期 */ }
    if (!inst || updateDlCtrl || backgroundDlCtrl) return;
    // 在途标志全程持有：两路（后台/手动）写的是同一个 temp 路径（asset.name），
    // 并发写会互相损坏——手动路径启动时会 abort 这条腿，SHA256 门只是最后防线
    const ctrl = new AbortController();
    backgroundDlCtrl = ctrl;
    try {
        const file = await downloadInstallerToTemp(inst, null, ctrl.signal);
        if (ctrl.signal.aborted || backgroundDlCtrl !== ctrl) return;
        updateCtx.phase = 'install';
        updateCtx.inst = inst;
        updateCtx.file = file;
        sendUpdateState('ready', {
            title: tr('update.readyTitle', { latest: inst.version }),
            body: tr('update.readyBody'),
            installLabel: tr('update.installNow'),
        });
        if (lastNotifiedUpdateVersion !== inst.version) {
            lastNotifiedUpdateVersion = inst.version;
            notify(
                tr('update.readyTitle', { latest: inst.version }),
                tr('update.readyBalloonBody', { latest: inst.version })
            );
        }
    } catch { /* 下载/校验失败静默,等下个周期或手动检查 */ } finally {
        if (backgroundDlCtrl === ctrl) backgroundDlCtrl = null;
    }
}

// 调度:启动 30s 后首检(避开启动高峰),之后每 6h 一轮;.unref() 不阻塞退出。
function scheduleBackgroundUpdateChecks() {
    if (backgroundUpdateTimer) return;
    const first = setTimeout(async () => {
        await backgroundCheckForUpdates();
        backgroundUpdateTimer = setInterval(backgroundCheckForUpdates, updateScheduler.CHECK_INTERVAL_MS);
        if (backgroundUpdateTimer.unref) backgroundUpdateTimer.unref();
    }, updateScheduler.INITIAL_DELAY_MS);
    if (first.unref) first.unref();
    backgroundUpdateTimer = first;
}

// ───────────────── 仪表盘发起的更新请求（数据目录 marker 握手） ─────────────────
// 仪表盘「检查更新」发现新版本且本端是桌面安装时，POST /api/version/shell-update
// 在 DATA_DIR 落一个 update-request.json（写入侧 src/lib/updateCheck.js）；这里
// 轮询消费，命中即跑壳自己的检查流程（打开更新窗 → available → 用户确认下载），
// 下载/SHA256/安装全走既有路径。远端（LAN/Tailscale）打开的仪表盘同样生效：
// sidecar 与壳同机、共用同一 DATA_DIR。
const UPDATE_REQUEST_POLL_MS = 3000;
let updateRequestTimer = null;
function startUpdateRequestPolling() {
    if (updateRequestTimer) return;
    updateRequestTimer = setInterval(() => {
        if (quitting) return;
        const req = updateRequest.consumeUpdateRequest(DATA_DIR);
        if (!req) return;
        if (updateDlCtrl || backgroundDlCtrl) {
            log('dashboard update request ignored: a download is already running');
            return;
        }
        log(`dashboard update request${req.version ? ` (v${req.version})` : ''} → checkForUpdates`);
        checkForUpdates();
    }, UPDATE_REQUEST_POLL_MS);
    if (updateRequestTimer.unref) updateRequestTimer.unref();
}

// ──────────────────────── 应用内关于窗(与更新窗同款 UI) ─────────────────────
// 一个无边框小窗(about-window.html + preload-about.js)承载「关于」:品牌图标 +
// 标题/标语、版本胶囊、壳版本与数据目录、GitHub 外链按钮(主进程 shell.openExternal)。
// 页面无 nodeIntegration,文案全部主进程 tr() 渲染后随 bootstrap 下发——替代旧的
// 原生 MessageBox(样式与系统主题脱节,和更新窗不统一)。
const ABOUT_HTML = path.join(__dirname, 'about-window.html');
const ABOUT_PRELOAD = path.join(__dirname, 'preload-about.js');
let aboutWin = null;

function showAbout() {
    if (aboutWin && !aboutWin.isDestroyed()) {
        aboutWin.show();
        aboutWin.focus();
        return;
    }
    aboutWin = new BrowserWindow({
        width: 420,
        height: 320,
        useContentSize: true,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        frame: false,                      // 页面内自定义标题栏(拖拽区 + 关闭按钮)
        title: tr('menu.about'),
        autoHideMenuBar: true,
        show: false,
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#FDFAF6',
        webPreferences: {
            preload: ABOUT_PRELOAD,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    aboutWin.once('ready-to-show', () => { try { if (aboutWin && !aboutWin.isDestroyed()) aboutWin.show(); } catch { /* ignore */ } });
    // 本地 file 页面:外链/导航一律拦死(「GitHub 主页」走主进程 shell.openExternal)
    aboutWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    aboutWin.webContents.on('will-navigate', (e, url) => {
        if (!String(url).startsWith('file://')) e.preventDefault();
    });
    aboutWin.on('closed', () => { aboutWin = null; });
    aboutWin.loadFile(ABOUT_HTML).catch((e) => {
        log(`about window load failed: ${e && e.message}`);
        try { aboutWin.close(); } catch { /* ignore */ }
    });
}

// 页面 bootstrap:一次性静态文案 + 版本信息(服务版本即 dashboard 版本,通常与壳同步)
ipcMain.handle('about:bootstrap', (e) => {
    if (!aboutWin || aboutWin.isDestroyed() || e.sender !== aboutWin.webContents) return null;
    return {
        strings: {
            windowTitle: tr('menu.about'),
            tagline: tr('about.tagline'),
            github: tr('about.github'),
            close: tr('dialog.close'),
        },
        view: {
            version: getServiceVersion(),
            detail: tr('about.detail', { shell: app.getVersion(), dataDir: DATA_DIR }),
        },
    };
});

// 页面量好内容高度后回报,窗口贴合(长数据目录换行时高度由 fit 精确回报)
ipcMain.on('about:fit', (e, height) => {
    if (!aboutWin || aboutWin.isDestroyed() || e.sender !== aboutWin.webContents) return;
    const h = Math.max(200, Math.min(640, Math.ceil(Number(height) || 0)));
    try { aboutWin.setContentSize(420, h); } catch { /* ignore */ }
});

ipcMain.on('about:action', (e, msg) => {
    if (!aboutWin || aboutWin.isDestroyed() || e.sender !== aboutWin.webContents) return;
    const action = msg && msg.action;
    if (action === 'close') { aboutWin.close(); return; }
    // 与原对话框行为一致:打开主页后顺手关窗
    if (action === 'github') { shell.openExternal(GITHUB_URL); aboutWin.close(); return; }
});

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
let sitePromptWin = null;
let authSlotWin = null;

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
// 会话池（#150）：仪表盘 preload 调起站点登录窗（指定槽位）。
// 站点表与 daemon /api/cookie-sites 同源（这里只取 id/loginUrl/name 供开窗）。
const SHELL_COOKIE_SITES = [
    { id: 'lingxi', name: 'WPS 灵犀', loginUrl: 'https://lingxi.kdocs.cn', provider: 'lingxi' },
    { id: 'dumate', name: 'DuMate 百度搭子', loginUrl: 'https://dumate.baidu.com', provider: 'dumate' },
];

// 通用网址 → 合成站点:分区键按 host 派生(u-<host>),槽位语义与站点槽一致;
// provider 为空 = 关窗不 harvest(持久分区自存 Cookie,下次同槽开窗直接复用)。
function genericSiteFromUrl(url) {
    const u = new URL(url);
    const hostKey = u.host.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'site';
    return { id: `u-${hostKey}`, name: u.host, loginUrl: url, provider: null };
}

// 授权账号槽(全局身份分区):OAuth 登录页开在 persist:auth-slot-<n> 里,
// 同一槽跨供应商共享登录态(像 Chrome profile)——上次用槽 3 登过某站,
// 下次再授权选槽 3 直接免登录。device-code 流靠仪表盘轮询拿 token,开窗方式
// 不影响回调;关窗不 harvest(授权凭证走服务端 exchange,不落 cookie 连接行)。
function openAuthSlotWindow(url, slot) {
    const n = Math.min(Math.max(Number(slot) || 1, 1), SESSION_POOL_SLOTS);
    const ses = session.fromPartition(`persist:auth-slot-${n}`);
    const authWin = new BrowserWindow({
        width: 600,
        height: 720,
        title: tr('win.authSlotTitle', { n }),
        autoHideMenuBar: true,
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#FDFAF6',
        webPreferences: {
            session: ses,
            preload: CONTAINER_PRELOAD,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    attachContainerCapture(authWin.webContents);
    attachContextMenu(authWin);
    authWin.webContents.setWindowOpenHandler(({ url: subUrl }) => {
        if (/^https?:\/\//i.test(subUrl)) {
            return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { session: ses, preload: CONTAINER_PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true } } };
        }
        return { action: 'deny' };
    });
    authWin.loadURL(url).catch(() => { /* 站点自行重定向 */ });
    return authWin;
}

// 站点表以 daemon /api/cookie-sites 为准（本机 CLI token 鉴权）；静态表兜底。
ipcMain.handle('session-pool:list', () => SHELL_COOKIE_SITES);
ipcMain.on('site-pick', (e, pick) => {
    // 注册站点(siteId 旧调用)或直接给的网址 → 统一成站点对象。
    // 网址命中注册站点 origin 时沿用注册站点(关窗收割上报);否则通用分区(自存 Cookie)。
    let site = SHELL_COOKIE_SITES.find((s) => s.id === pick?.siteId) || null;
    if (!site && pick?.url) {
        const norm = normalizeOpenUrl(pick.url);
        if (!norm) return;
        pushRecentUrl(norm);   // 与「打开网址…」共用同一份 recent-urls.json
        try {
            const origin = new URL(norm).origin;
            site = SHELL_COOKIE_SITES.find((s) => {
                try { return new URL(s.loginUrl).origin === origin; } catch { return false; }
            }) || genericSiteFromUrl(norm);
        } catch { return; }
    }
    if (!site) return;
    if (sitePromptWin && !sitePromptWin.isDestroyed()) sitePromptWin.close();
    openSiteLoginWindow(site, pick?.slot || 1);
});
ipcMain.handle('session-pool:login', (e, siteId, slot) => {
    const site = SHELL_COOKIE_SITES.find((s) => s.id === siteId);
    if (!site) return { ok: false, error: 'unknown site' };
    openSiteLoginWindow(site, slot);
    return { ok: true, site: siteId, slot: Math.min(Math.max(Number(slot) || 1, 1), 9) };
});

// 仪表盘 OAuth 弹窗「用账号槽打开」:登录页开进选定的授权槽分区(壳内开窗)。
// 只收 http(s);渲染层给的 URL 不额外信任——分区隔离 + 无 node 集成兜底。
ipcMain.handle('auth-slot:open', (e, rawUrl, slot) => {
    const url = normalizeOpenUrl(rawUrl);
    if (!url) return { ok: false, error: 'invalid url' };
    openAuthSlotWindow(url, slot);
    return { ok: true, slot: Math.min(Math.max(Number(slot) || 1, 1), SESSION_POOL_SLOTS) };
});

// 「打开服务网址（带账号）」：任意网址 × 槽位（身份分区）在壳内开窗。
// 槽 = 持久分区身份（Chrome profile 式），与站点无关：同一网址不同槽 = 不同账号。
// 最近打开与「打开网址…」共用 recent-urls.json；点条目填入网址。网址命中注册
// 站点 origin 时关窗带收割上报，其余靠分区自存 Cookie。不传 title——壳内窗自带标题。
function promptOpenSite() {
    if (sitePromptWin && !sitePromptWin.isDestroyed()) { sitePromptWin.focus(); return; }
    const hasParent = win && !win.isDestroyed();
    sitePromptWin = new BrowserWindow({
        width: 460,
        height: 470,
        parent: hasParent ? win : null,
        alwaysOnTop: true,
        title: tr('appmenu.openSite'),
        resizable: false,
        minimizable: false,
        maximizable: false,
        autoHideMenuBar: true,
        show: true,
        webPreferences: { contextIsolation: false, nodeIntegration: true, sandbox: false },
    });
    attachContextMenu(sitePromptWin);
    // 最近打开直接推过去（本地文件读取，无需拉 daemon）。
    sitePromptWin.webContents.once('did-finish-load', () => {
        const recents = loadRecentUrls();
        try { if (!sitePromptWin.isDestroyed()) sitePromptWin.webContents.send('site-list', { recents }); } catch { /* 窗已关 */ }
    });
    const html = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="font-family:inherit;margin:0;padding:10px 12px;background:transparent">
<div id="main">
<div style="font-size:12px;color:#888;margin-bottom:4px">${tr('win.openSiteUrl')}</div>
<input id="url" type="text" placeholder="https://…" autofocus
  style="flex:1;width:100%;box-sizing:border-box;font-size:13px;padding:5px 8px;border:1px solid #8885;border-radius:6px;background:transparent;color:inherit;outline:none" />
<div style="display:flex;align-items:center;gap:6px;margin-top:8px">
<span style="font-size:12px;color:#888">${tr('win.openSiteSlot')}</span>
<span id="slots" style="display:flex;gap:4px"></span>
</div>
<div id="hint" style="font-size:11px;color:#888;margin-top:4px;min-height:14px"></div>
</div>
<div style="font-size:12px;color:#888;margin:8px 0 4px">${tr('appmenu.recent')}</div>
<div id="recents" style="display:flex;flex-direction:column;gap:4px;max-height:150px;overflow-y:auto"></div>
<script>
const { ipcRenderer } = require('electron');
const urlInput = document.getElementById('url');
const hint = document.getElementById('hint');
function pickSlot(n) {
    const v = urlInput.value.trim();
    if (!v) { hint.textContent = ${JSON.stringify(tr('win.openSiteTypeUrl'))}; urlInput.focus(); return; }
    ipcRenderer.send('site-pick', { url: v, slot: n });
}
const slots = document.getElementById('slots');
for (let n = 1; n <= 9; n++) {
    const b = document.createElement('button');
    b.textContent = n;
    b.title = 'slot ' + n;
    b.style.cssText = 'width:28px;height:26px;font-size:12px;border:1px solid #8883;border-radius:5px;cursor:pointer;padding:0';
    b.addEventListener('click', () => pickSlot(n));
    slots.appendChild(b);
}
urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') pickSlot(1); });
function quickRow(label, sub, url) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 8px;border:1px solid #8883;border-radius:6px;cursor:pointer';
    row.title = url;
    const name = document.createElement('div');
    name.style.cssText = 'flex:1;min-width:0;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    name.textContent = label;
    row.appendChild(name);
    if (sub) {
        const tag = document.createElement('div');
        tag.style.cssText = 'font-size:11px;color:#888;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        tag.textContent = sub;
        row.appendChild(tag);
    }
    row.addEventListener('click', () => { urlInput.value = url; urlInput.focus(); urlInput.select(); });
    return row;
}
ipcRenderer.on('site-list', (e, data) => {
    const recents = data.recents || [];
    const rc = document.getElementById('recents');
    for (const it of recents) rc.appendChild(quickRow(it.title || it.url, it.title ? it.url : '', it.url));
    if (!recents.length) {
        const empty = document.createElement('div');
        empty.style.cssText = 'font-size:11px;color:#888;padding:2px 8px';
        empty.textContent = ${JSON.stringify(tr('appmenu.recent.empty'))};
        rc.appendChild(empty);
    }
});
</script>
</body></html>`;
    sitePromptWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
        .catch((e) => { log(`site prompt load failed: ${e.message}`); try { sitePromptWin.close(); } catch { /* ignore */ } });
    sitePromptWin.on('closed', () => { sitePromptWin = null; });
}

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

// ──────────────────────── 容器密码管理(捕获/自动填充/管理窗) ────────────────────────
// 「容器」= 主窗体加载的外部网页(「前往→打开网址/最近打开」)与壳内弹窗子窗。
// 捕获与填充逻辑在 preload-container.js(sandbox 安全,不向页面暴露任何东西),
// 这里只做:登记容器 webContents、密码库(passwords.json,safeStorage 密文)、
// 保存询问窗、管理窗、右键填充。约定:
//  - 渲染层传来的 url 一律不采信,归属 origin 只按主进程侧读到的 senderFrame.url;
//  - pw:fill 广播给全部 frame,各 frame 按 location.origin 自滤,跨域 iframe 拿不到;
//  - cipher 用 Electron safeStorage(Windows=DPAPI 绑当前系统用户),不可用即停用,
//    绝不落明文(库模块 passwordStore.js 同款约定)。
const PASSWORD_FILE = path.join(app.getPath('userData'), 'passwords.json');
const CONTAINER_PRELOAD = path.join(__dirname, 'preload-container.js');

const safeStorageCipher = {
    available: () => { try { return safeStorage.isEncryptionAvailable() === true; } catch { return false; } },
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (blob) => safeStorage.decryptString(Buffer.from(String(blob), 'base64')).toString('utf8'),
};

let pwStore = null;
function getPwStore() {
    if (!pwStore) pwStore = createPasswordStore({ file: PASSWORD_FILE, cipher: safeStorageCipher, log: (m) => log(m) });
    return pwStore;
}

function listPasswords() {
    try { return getPwStore().list(); } catch { return []; }
}

const cleanText = (v) => String(v === undefined || v === null ? '' : v).trim().slice(0, 300);

// pw:* 事件的归属 origin:优先取发送 frame 的真实 URL(iframe 里的登录框归 iframe),
// frame 已销毁等场景回退整页 URL。
function frameOrigin(e) {
    try {
        const fu = e.senderFrame && e.senderFrame.url;
        if (fu) return new URL(fu).origin;
    } catch { /* 回退 sender */ }
    try { return new URL(e.sender.getURL()).origin; } catch { return null; }
}

// 容器 webContents 登记:只有这些窗的 pw:* IPC 会被受理;弹窗子窗同享捕获/填充
const containerContents = new Set();
const typedCaptures = new Map();   // webContents.id → {origin, url, username, password, ts}

function attachContainerCapture(contents) {
    if (!contents || containerContents.has(contents)) return;
    containerContents.add(contents);
    contents.once('destroyed', () => {
        containerContents.delete(contents);
        typedCaptures.delete(contents.id);
    });
    // SPA 登录启发式:输入过密码后同 origin 换路径 → 视作登录成功,转保存询问。
    // 原地提交(失败重试同 URL)/换站/超 10 分钟都不算。
    contents.on('did-navigate', (e, url) => {
        const rec = typedCaptures.get(contents.id);
        if (!rec) return;
        typedCaptures.delete(contents.id);
        try {
            const next = new URL(url || '');
            if (!/^https?:$/.test(next.protocol)) return;
            if (next.origin.toLowerCase() !== String(rec.origin).toLowerCase()) return;
            if (next.toString() === rec.url) return;
            if (Date.now() - rec.ts > 10 * 60 * 1000) return;
            offerPasswordSave({ origin: rec.origin, username: rec.username, password: rec.password });
        } catch { }
    });
}

let pwDisabledNotified = false;
// 保存询问的唯一入口(form 捕获/typed 启发式共用):去重 + 更新判定,再弹窗
function offerPasswordSave({ origin, username, password }) {
    if (!origin || !password) return;
    const store = getPwStore();
    if (!store.isAvailable()) {
        if (!pwDisabledNotified) {
            pwDisabledNotified = true;
            notify(tr('pw.mgr.title'), tr('pw.notify.disabled'));
        }
        return;
    }
    if (store.isNeverAsk(origin)) return;
    const existing = store.findEntry(origin, username || '');
    let isUpdate = false;
    if (existing) {
        try { if (store.reveal(existing.id) === password) return; } catch { /* 解不开按更新处理 */ }
        isUpdate = true;
    }
    promptSavePassword({ origin, username: username || '', password, isUpdate });
}

// ── 保存询问窗(保存/更新、永不保存此站点、暂不) ──
let savePwWin = null;
let savePwPending = null;   // {origin, username, password, isUpdate}

function promptSavePassword(payload) {
    if (savePwWin && !savePwWin.isDestroyed()) { savePwWin.focus(); return; }   // 一次只处理一条
    savePwPending = payload;
    savePwWin = new BrowserWindow({
        width: 470,
        height: 256,
        parent: (win && !win.isDestroyed()) ? win : null,
        // 刻意不用 modal(见 promptOpenUrl 注释:模态子窗会永久卡死父窗体)
        alwaysOnTop: true,
        title: tr(payload.isUpdate ? 'pw.save.updateTitle' : 'pw.save.title'),
        resizable: false,
        minimizable: false,
        maximizable: false,
        autoHideMenuBar: true,
        show: true,
        webPreferences: { contextIsolation: false, nodeIntegration: true, sandbox: false },
    });
    attachContextMenu(savePwWin);
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const html = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="font-family:inherit;margin:0;padding:14px;display:flex;flex-direction:column;gap:8px;background:transparent">
<div style="font-size:14px;font-weight:600">PW_TITLE</div>
<div style="display:flex;gap:8px;align-items:center">
<span style="width:56px;font-size:12px;color:#888">SITE_LBL</span>
<input value="SITE_VAL" readonly style="flex:1;min-width:0;padding:5px 10px;font-size:13px;border:1px solid #8883;border-radius:6px;color:#555;background:transparent">
</div>
<div style="display:flex;gap:8px;align-items:center">
<span style="width:56px;font-size:12px;color:#888">USER_LBL</span>
<input id="u" value="USER_VAL" placeholder="USER_PH" style="flex:1;min-width:0;padding:5px 10px;font-size:13px;border:1px solid #8883;border-radius:6px;outline:none">
</div>
<div style="display:flex;gap:8px;align-items:center">
<span style="width:56px;font-size:12px;color:#888">PASS_LBL</span>
<input id="p" type="password" value="PASS_VAL" style="flex:1;min-width:0;padding:5px 10px;font-size:13px;border:1px solid #8883;border-radius:6px;outline:none">
</div>
<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:4px">
<button id="never" style="padding:5px 12px;font-size:13px;border:1px solid #8883;border-radius:6px;cursor:pointer;background:transparent">NEVER_LBL</button>
<button id="no" style="padding:5px 12px;font-size:13px;border:1px solid #8883;border-radius:6px;cursor:pointer;background:transparent">NOTNOW_LBL</button>
<button id="ok" style="padding:5px 14px;font-size:13px;border:1px solid #8883;border-radius:6px;cursor:pointer">SAVE_LBL</button>
</div>
<script>
const { ipcRenderer } = require('electron');
const decide = (action) => ipcRenderer.send('pw:save-decide', {
  action,
  username: document.getElementById('u').value,
  password: document.getElementById('p').value,
});
document.getElementById('ok').addEventListener('click', () => decide('save'));
document.getElementById('never').addEventListener('click', () => decide('never'));
document.getElementById('no').addEventListener('click', () => window.close());
['u', 'p'].forEach((id) => document.getElementById(id).addEventListener('keydown', (e) => {
  if (e.key === 'Enter') decide('save');
  if (e.key === 'Escape') window.close();
}));
</script>
</body></html>`;
    const filled = html
        .replace('PW_TITLE', esc(tr(payload.isUpdate ? 'pw.save.updateTitle' : 'pw.save.title')))
        .replace('SITE_LBL', esc(tr('pw.save.site')))
        .replace('USER_LBL', esc(tr('pw.save.user')))
        .replace('PASS_LBL', esc(tr('pw.save.pass')))
        .replace('USER_PH', esc(tr('pw.mgr.userPh')))
        .replace('SITE_VAL', esc(payload.origin))
        .replace('USER_VAL', esc(payload.username))
        .replace('PASS_VAL', esc(payload.password))
        .replace('NEVER_LBL', esc(tr('pw.save.never')))
        .replace('NOTNOW_LBL', esc(tr('pw.save.notNow')))
        .replace('SAVE_LBL', esc(tr(payload.isUpdate ? 'pw.save.update' : 'pw.save.save')));
    savePwWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(filled))
        .catch((e) => { log(`pw save prompt load failed: ${e.message}`); try { savePwWin.close(); } catch { /* ignore */ } });
    savePwWin.on('closed', () => { savePwWin = null; savePwPending = null; });
}

// 用户名/密码以弹窗输入为准(可改完再存);关窗/暂不 = 丢弃这条,下次登录再问
ipcMain.on('pw:save-decide', (e, msg) => {
    const fromPrompt = savePwWin && !savePwWin.isDestroyed() && e.sender === savePwWin.webContents;
    if (!fromPrompt || !savePwPending) return;
    const payload = savePwPending;
    savePwPending = null;
    try { savePwWin.close(); } catch { /* ignore */ }
    if (!msg || typeof msg !== 'object') return;
    if (msg.action === 'never') {
        try { getPwStore().setNeverAsk(payload.origin); } catch { /* ignore */ }
        return;
    }
    if (msg.action === 'save') {
        const username = String(msg.username === undefined ? payload.username : msg.username).trim().slice(0, 300);
        const password = String(msg.password === undefined ? payload.password : msg.password);
        try { getPwStore().upsert({ origin: payload.origin, username, password }); } catch { /* 存不上不阻塞 */ }
    }
});

// 捕获一:<form> submit(preload 捕获阶段送来)
ipcMain.on('pw:captured', (e, payload) => {
    if (!containerContents.has(e.sender) || !payload || typeof payload !== 'object') return;
    const origin = frameOrigin(e);
    if (!origin) return;
    offerPasswordSave({ origin, username: cleanText(payload.username), password: String(payload.password || '') });
});

// 捕获二:SPA 无 form 登录的 pending 输入,等 did-navigate 消费(见 attachContainerCapture)
ipcMain.on('pw:typed', (e, payload) => {
    if (!containerContents.has(e.sender) || !payload || typeof payload !== 'object') return;
    const origin = frameOrigin(e);
    if (!origin) return;
    try {
        typedCaptures.set(e.sender.id, {
            origin,
            url: e.sender.getURL(),
            username: cleanText(payload.username),
            password: String(payload.password || ''),
            ts: Date.now(),
        });
    } catch { /* ignore */ }
});

// 自动填充:该 origin 恰好一条已存条目才自动回填(多账号走右键菜单显式选,不自动猜)
ipcMain.on('pw:focus', (e) => {
    if (!containerContents.has(e.sender)) return;
    const origin = frameOrigin(e);
    if (!origin) return;
    const store = getPwStore();
    if (!store.isAvailable() || store.isNeverAsk(origin)) return;
    let entries = [];
    try { entries = store.listForOrigin(origin); } catch { return; }
    if (entries.length !== 1) return;
    try {
        const password = store.reveal(entries[0].id);
        e.sender.send('pw:fill', { origin, username: entries[0].username, password });
    } catch { /* ignore */ }
});

// ── 管理已保存的密码(列表/手动添加/改/显示/复制/两步删除) ──
let pwMgrWin = null;
function promptManagePasswords() {
    if (pwMgrWin && !pwMgrWin.isDestroyed()) { pwMgrWin.focus(); return; }
    pwMgrWin = new BrowserWindow({
        width: 800,
        height: 520,
        parent: (win && !win.isDestroyed()) ? win : null,
        alwaysOnTop: true,
        title: tr('pw.mgr.title'),
        autoHideMenuBar: true,
        show: true,
        webPreferences: { contextIsolation: false, nodeIntegration: true, sandbox: false },
    });
    attachContextMenu(pwMgrWin);
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const html = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="font-family:inherit;margin:0;padding:12px;display:flex;flex-direction:column;gap:8px;background:transparent">
<div id="err" style="display:none;font-size:12px;color:#c0392b"></div>
<div id="add" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;border:1px dashed #8885;border-radius:8px;padding:8px"></div>
<div id="list" style="display:flex;flex-direction:column;gap:6px"></div>
<script>
const { ipcRenderer, clipboard } = require('electron');
const BTN = 'padding:3px 10px;font-size:12px;border:1px solid #8883;border-radius:6px;cursor:pointer;background:transparent';
const INP = 'flex:1;min-width:0;padding:4px 8px;font-size:13px;border:1px solid #8883;border-radius:6px;outline:none';
const ORIGIN = 'flex-basis:100%;font-size:11px;color:#888;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
const ERRS = { invalidOrigin: 'ERR_INVALID', needPw: 'ERR_NEEDPW', failed: 'ERR_FAILED' };
const errBox = document.getElementById('err');
function showErr(key) { errBox.textContent = ERRS[key] || ERRS.failed; errBox.style.display = 'block'; }
function clearErr() { errBox.style.display = 'none'; }
function rpc(msg) { return ipcRenderer.sendSync('pw:mgr', msg) || {}; }
// 行内容全部用 DOM API 构建(textContent/value),不拼 HTML 字符串,天然免注入
function row(it) {
    const rowEl = document.createElement('div');
    rowEl.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;border:1px solid #8883;border-radius:8px;padding:8px';
    const o = document.createElement('div');
    o.style.cssText = ORIGIN;
    o.textContent = it.origin;
    o.title = it.origin;
    const un = document.createElement('input');
    un.style.cssText = INP + ';flex:2';
    un.value = it.username || '';
    un.placeholder = 'USER_PH';
    const pin = document.createElement('input');
    pin.style.cssText = INP + ';flex:2';
    pin.type = 'password';
    pin.placeholder = 'KEEP_PW_PH';
    let revealed = false;
    const show = document.createElement('button');
    show.style.cssText = BTN;
    show.textContent = 'SHOW_LBL';
    show.onclick = () => {
        if (!revealed) {
            const r = rpc({ action: 'reveal', id: it.id });
            if (!r.ok) return showErr(r.error || 'failed');
            pin.value = String(r.plain || '');
            pin.type = 'text';
            show.textContent = 'HIDE_LBL';
            revealed = true;
        } else {
            pin.value = '';
            pin.type = 'password';
            show.textContent = 'SHOW_LBL';
            revealed = false;
        }
    };
    const save = document.createElement('button');
    save.style.cssText = BTN;
    save.textContent = 'SAVE_LBL';
    save.onclick = () => {
        const r = rpc({ action: 'update', id: it.id, username: un.value, password: pin.value });
        if (!r.ok) return showErr(r.error || 'failed');
        clearErr();
        render();
    };
    const copy = document.createElement('button');
    copy.style.cssText = BTN;
    copy.textContent = 'COPY_LBL';
    copy.onclick = () => {
        const r = rpc({ action: 'reveal', id: it.id });
        if (!r.ok) return showErr(r.error || 'failed');
        clipboard.writeText(String(r.plain || ''));
        copy.textContent = 'COPIED_LBL';
        setTimeout(() => { copy.textContent = 'COPY_LBL'; }, 1200);
    };
    const del = document.createElement('button');
    del.style.cssText = BTN;
    del.textContent = 'DEL_LBL';
    del.onclick = () => {
        // 两步删除:第一次点变「确认删除?」,render 重建节点自动复位
        if (del.dataset.arm !== '1') { del.dataset.arm = '1'; del.textContent = 'CONFIRM_LBL'; return; }
        rpc({ action: 'remove', id: it.id });
        render();
    };
    rowEl.append(o, un, pin, show, save, copy, del);
    return rowEl;
}
function render() {
    const box = document.getElementById('list');
    box.textContent = '';
    const res = rpc({ action: 'list' });
    const list = Array.isArray(res.list) ? res.list : [];
    if (!list.length) { box.textContent = 'EMPTY_PLACEHOLDER'; return; }
    for (const it of list) box.appendChild(row(it));
}
// 手动添加行(origin/用户名/密码)
const addBox = document.getElementById('add');
const aO = document.createElement('input');
aO.style.cssText = INP + ';flex-basis:100%';
aO.placeholder = 'ORIGIN_PH';
const aU = document.createElement('input');
aU.style.cssText = INP;
aU.placeholder = 'USER_PH';
const aP = document.createElement('input');
aP.style.cssText = INP;
aP.type = 'password';
aP.placeholder = 'PASS_PH';
const addBtn = document.createElement('button');
addBtn.style.cssText = BTN;
addBtn.textContent = 'ADD_LBL';
addBtn.onclick = () => {
    if (!aP.value) return showErr('needPw');
    const r = rpc({ action: 'add', origin: aO.value.trim(), username: aU.value, password: aP.value });
    if (!r.ok) return showErr(r.error || 'failed');
    clearErr();
    aO.value = ''; aU.value = ''; aP.value = '';
    render();
};
addBox.append(aO, aU, aP, addBtn);
render();
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.close(); });
</script>
</body></html>`;
    const filled = html
        .replace('EMPTY_PLACEHOLDER', esc(tr('pw.mgr.empty')))
        .replace('ORIGIN_PH', esc(tr('pw.mgr.originPh')))
        .replace('USER_PH', esc(tr('pw.mgr.userPh')))
        .replace('PASS_PH', esc(tr('pw.mgr.passPh')))
        .replace('KEEP_PW_PH', esc(tr('pw.mgr.keepPw')))
        .replace('ADD_LBL', esc(tr('pw.mgr.add')))
        .replace('SHOW_LBL', esc(tr('pw.mgr.reveal')))
        .replace('HIDE_LBL', esc(tr('pw.mgr.hide')))
        .replace('SAVE_LBL', esc(tr('appmenu.mgr.save')))
        .replace('COPY_LBL', esc(tr('pw.mgr.copy')))
        .replace('COPIED_LBL', esc(tr('pw.mgr.copied')))
        .replace('DEL_LBL', esc(tr('appmenu.mgr.delete')))
        .replace('CONFIRM_LBL', esc(tr('pw.mgr.confirmDel')))
        .replace('ERR_INVALID', esc(tr('pw.mgr.invalid')))
        .replace('ERR_NEEDPW', esc(tr('pw.mgr.needPw')))
        .replace('ERR_FAILED', esc(tr('pw.mgr.err')));
    pwMgrWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(filled))
        .catch((e) => { log(`pw mgr load failed: ${e.message}`); try { pwMgrWin.close(); } catch { /* ignore */ } });
    pwMgrWin.on('closed', () => { pwMgrWin = null; });
}

// 管理窗与主进程的单通道 RPC(sendSync):list/add/update/remove/reveal,一律回当前全表
ipcMain.on('pw:mgr', (e, msg) => {
    const fromMgr = pwMgrWin && !pwMgrWin.isDestroyed() && e.sender === pwMgrWin.webContents;
    const out = { ok: !!fromMgr };
    if (fromMgr && msg && typeof msg === 'object') {
        const store = getPwStore();
        try {
            if (msg.action === 'add') {
                if (!String(msg.password || '')) { out.ok = false; out.error = 'needPw'; }
                else store.upsert({ origin: msg.origin, username: cleanText(msg.username), password: String(msg.password) });
            } else if (msg.action === 'update') {
                store.update(String(msg.id || ''), {
                    username: msg.username !== undefined ? cleanText(msg.username) : undefined,
                    password: String(msg.password || ''),
                });
            } else if (msg.action === 'remove') {
                store.remove(String(msg.id || ''));
            } else if (msg.action === 'reveal') {
                out.plain = store.reveal(String(msg.id || ''));
            }
        } catch (err) {
            out.ok = false;
            out.error = /invalid origin/i.test(String(err && err.message)) ? 'invalidOrigin' : 'failed';
        }
    }
    out.list = listPasswords();
    e.returnValue = out;
});

// ──────────────────────── 右键菜单(网页/TUI 复制粘贴) ────────────────────────
// Electron 窗口没有浏览器右键菜单:在 Hermes 这类 web TUI 里,选中复制/粘贴
// 只能靠它(Chrome 的右键在壳里是空的)。菜单项走 webContents 原生动作,
// 不与页面按键交互。词条复用应用菜单的 appmenu.copy/paste/selectall。
let externalView = false;   // 主窗体当前视图是否为外部页面(非本地仪表盘)
function attachContextMenu(target) {
    target.webContents.on('context-menu', (e, params) => {
        const items = [
            { label: tr('appmenu.copy'), enabled: params.editFlags.canCopy, click: () => target.webContents.copy() },
            { label: tr('appmenu.paste'), enabled: params.editFlags.canPaste, click: () => target.webContents.paste() },
            { label: tr('appmenu.selectall'), enabled: params.editFlags.canSelectAll, click: () => target.webContents.selectAll() },
        ];
        // 容器页:当前 frame 的 origin 有已存密码 → 右键列出账号显式填充(多账号的
        // 唯一填充入口;单账号走聚焦自动填充)。管理窗/输入弹窗不在 containerContents
        // 登记里,天然跳过;明文只在点击那一刻 reveal。
        try {
            const origin = params.frameURL ? new URL(params.frameURL).origin : null;
            if (origin && containerContents.has(target.webContents)) {
                const store = getPwStore();
                if (store.isAvailable()) {
                    const fillItems = store.listForOrigin(origin).map((en) => ({
                        label: tr('pw.mgr.fill', { user: en.username || tr('pw.mgr.noUser') }),
                        click: () => {
                            try {
                                target.webContents.send('pw:fill', { origin, username: en.username, password: store.reveal(en.id) });
                            } catch { /* ignore */ }
                        },
                    }));
                    if (fillItems.length) items.unshift({ type: 'separator' }, ...fillItems.reverse(), { type: 'separator' });
                }
            }
        } catch { /* 右键菜单主体不受影响 */ }
        const menu = Menu.buildFromTemplate(items);
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
                { label: tr('appmenu.openSite'), click: promptOpenSite },
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
                { type: 'separator' },
                // 密码管理入口:空列表也开着(首条密码就靠这里手动补录)
                { label: tr('appmenu.managePw'), accelerator: 'CmdOrCtrl+Shift+P', click: promptManagePasswords },
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
        startUpdateRequestPolling();  // 消费仪表盘的更新请求(见 updateRequest.js)
        await startServer();          // 启动即拉起服务
    });

    // 退出=确定性停车：sidecar 与托盘是同一个 10Router.exe（ELECTRON_RUN_AS_NODE，
    // 无窗口），安装器/卸载器对它只能强杀——而旧版本的卸载器没有这一段。
    // 这里在退出前先把服务停掉（≤5s），保证用户手动退出托盘、应用内自更新、
    // NSIS 引导关闭三种路径下文件锁都真正释放。will-quit 的 taskkill 留作兜底。
    let quitStopping = false;
    app.on('before-quit', (e) => {
        quitting = true;
        if (updateRequestTimer) { clearInterval(updateRequestTimer); updateRequestTimer = null; }
        if (backgroundUpdateTimer) { clearTimeout(backgroundUpdateTimer); clearInterval(backgroundUpdateTimer); backgroundUpdateTimer = null; }
        if (!quitStopping && nodeProc) {
            quitStopping = true;
            e.preventDefault();
            stopServer()
                .catch(() => { })
                .finally(() => app.exit(0));
        }
    });

    app.on('will-quit', () => {
        if (nodeProc) {
            try { killProcTree(nodeProc.pid); } catch { try { nodeProc.kill(); } catch { } }
        }
    });

    // 托盘应用:窗口全关也不退出
    app.on('window-all-closed', (e) => { /* no-op,阻止默认退出 */ });
}
