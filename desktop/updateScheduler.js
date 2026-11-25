/**
 * Background update-check scheduling — pure decision logic, no Electron imports.
 *
 * 对齐 CreditDaddy 的「后台定时检查 + 预下载」，但不自动安装（10R 是常驻
 * 网关，静默重启会掐断正在跑的 agent 会话；安装始终由用户点「立即安装」）。
 * 这里的函数只做决策，副作用（网络/下载/托盘）全部留在 main.js：
 *
 *  - shouldRunBackgroundCheck: 开关守卫。读取设置里「自动检查更新」镜像出的
 *    marker 文件（src/lib/updateCheck.js syncUpdateCheckMarker），关闭则不调度、
 *    已挂着的定时器空转；手动检查（托盘/仪表盘 ?check=1）不受它影响。
 *  - resolveBackgroundUpdateAction: 后台发现新版本后的动作——可原地安装的
 *    （Windows NSIS 安装版）预下载安装包；Portable / macOS 只提示不下载；
 *    已为该版本预下载过则只提示「立即安装」，绝不重复下载。
 *  - canReuseDownloadedInstaller: 手动检查（checkForUpdates）发现后台已把
 *    当前版本预下载好时，直接进入 ready 态，秒装。
 */

const path = require('path');

const INITIAL_DELAY_MS = 30 * 1000;             // 启动后首次静默检查的延迟（避开启动高峰）
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;   // 之后每 6 小时（同 CreditDaddy）
const UPDATE_CHECK_DISABLED_MARKER = 'update-check-disabled';

function updateCheckDisabledMarkerPath(dataDir) {
    return path.join(dataDir || '', UPDATE_CHECK_DISABLED_MARKER);
}

/**
 * @param {{ markerExists: boolean }} state  marker 文件是否存在（存在 = 用户关闭了自动检查）
 * @returns {boolean} true = 允许后台检查
 */
function shouldRunBackgroundCheck({ markerExists }) {
    return markerExists !== true;
}

/**
 * 后台发现新版本后的动作。
 * @param {{
 *   hasUpdate: boolean,
 *   latestVersion: string|null,
 *   canInstallInPlace: boolean,
 *   alreadyReadyForVersion: boolean,   // updateCtx 已是该版本的已下载安装包
 * }} state
 * @returns {'pre-download'|'notify-ready'|'notify-only'|'none'}
 */
function resolveBackgroundUpdateAction({ hasUpdate, latestVersion, canInstallInPlace, alreadyReadyForVersion }) {
    if (!hasUpdate || !latestVersion) return 'none';
    if (alreadyReadyForVersion) return 'notify-ready';
    if (canInstallInPlace) return 'pre-download';
    return 'notify-only';   // Portable / macOS：只提示，不下载
}

/**
 * 手动检查时能否直接复用后台已预下载的安装包（跳过下载阶段）。
 * @param {{ phase: string, instVersion: string|null, fileExists: boolean, latestVersion: string|null }} state
 */
function canReuseDownloadedInstaller({ phase, instVersion, fileExists, latestVersion }) {
    return phase === 'install'
        && !!latestVersion
        && instVersion === latestVersion
        && fileExists === true;
}

module.exports = {
    INITIAL_DELAY_MS,
    CHECK_INTERVAL_MS,
    UPDATE_CHECK_DISABLED_MARKER,
    updateCheckDisabledMarkerPath,
    shouldRunBackgroundCheck,
    resolveBackgroundUpdateAction,
    canReuseDownloadedInstaller,
};
