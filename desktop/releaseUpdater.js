/**
 * 桌面壳「GitHub Releases 直装」更新通道的纯逻辑(不 require('electron'),vitest 可测)
 *
 * 10Router 的 GitHub release 不带 electron-updater 的 latest.yml,壳内自更新走:
 * 最新版本号来自 /api/version(npm latest,与 fpk/CLI 同源);本地服务不在时壳里直查
 * GitHub API 兜底。拿到版本号后从对应 release 取 10Router-Win-Setup-<版本>.exe,
 * 按 SHA256SUMS-desktop.txt 校验后运行安装。网络与 UI 在 main.js,本模块只管
 * "选哪个资产、期望哈希是多少"。
 *
 * 资产命名自 v1.4.0 平台化(对齐 CreditDaddy 的 <App>-<平台>-… 方式,让同平台
 * 资产在 release 列表里自动排序聚类):新名 10Router-Win-Setup-1.4.0.exe 与
 * sums 条目完全一致,下面的点分隔/空格旧名比对只对更早的 release 生效。
 *
 * 旧 release(≤v1.3.5)的已知坑:安装包资产名是 10Router.Setup.1.2.1.exe(点
 * 分隔 — electron-builder 默认名里的空格被 GitHub 渲染成点),而
 * SHA256SUMS-desktop.txt 里写的是 "10Router Setup 1.2.1.exe"(空格分隔,
 * sha256sum -b 的 * 二进制标记也在),按原样 endsWith 永远失配——归一化
 * (小写 + 去掉所有非字母数字)后再比对。
 */
'use strict';

// x.y.z 逐段数值比较:next > cur 才算新版本。忽略 v 前缀;缺失段按 0,
// 非数字段(预发布尾巴)parseInt 截断,只影响同版本号的极端场景。
function isNewerVersion(next, cur) {
    const p = (s) => String(s).replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
    const a = p(next);
    const b = p(cur);
    for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
    return false;
}

// release 资产里找 Windows 安装包。Portable(覆盖式,会丢用户数据)与
// nsis-web(依赖在线包源的网页安装器)都不参与壳内自更新,只认 Setup。
// 新旧两代命名都要认:v1.4.0 起为 10Router-Win-Setup-<版本>.exe(平台化),
// 更早的 release 是 10Router.Setup.<版本>.exe(点分隔旧名)。两代前缀都锚定在
// Setup 段本身 — 新名以 10Router-Win-Setup- 开头(Web-Setup 前面隔着 -Win-),
// 旧名以点分隔形式开头 — 故 Web-Setup/Portable 均不会误配。
function findSetupAsset(release) {
    const assets = (release && release.assets) || [];
    return assets.find((a) => /^(?:10Router-Win-Setup-|10Router\.Setup\.).+\.exe$/i.test(a.name)) || null;
}

// SHA256SUMS 一行 "<hex>[ *]<name>" → { sha256, name };解析不了返回 null。
function parseChecksumLine(line) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(String(line || '').trim());
    if (!m) return null;
    return { sha256: m[1].toLowerCase(), name: m[2] };
}

// 资产名 ↔ sums 文件名归一:小写 + 去掉所有非字母数字。
// "10Router.Setup.1.2.1.exe" 与 "10Router Setup 1.2.1.exe" 归一后同串;
// Portable / Web-Setup / nsis.7z 归一后仍互不相同,不会误配。
function normalizeAssetName(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// 在 sums 全文里找 assetName 对应的哈希,找不到返回 null。
function matchChecksum(sumsText, assetName) {
    const want = normalizeAssetName(assetName);
    if (!want) return null;
    for (const line of String(sumsText || '').split(/\r?\n/)) {
        const parsed = parseChecksumLine(line);
        if (parsed && normalizeAssetName(parsed.name) === want) return parsed.sha256;
    }
    return null;
}

// release → 安装包描述;没有 Setup 资产(如纯 fpk/dmg 的 release)返回 null。
// expectedSha 先取 GitHub 资产自带的 digest(GitHub 服务端算的),sums 文件
// 由 main.js 下载后经 resolveExpectedSha 覆盖——两路任一命中即可校验。
function pickInstaller(release) {
    const asset = findSetupAsset(release);
    if (!asset || !asset.browser_download_url) return null;
    const tag = String((release && release.tag_name) || '');
    const digest = typeof asset.digest === 'string' && asset.digest.startsWith('sha256:') ? asset.digest.slice(7) : null;
    const sums = (release.assets || []).find((a) => /^SHA256SUMS-desktop\.txt$/i.test(a.name));
    return {
        version: tag.replace(/^v/i, ''),
        asset: { name: asset.name, url: asset.browser_download_url, size: asset.size || 0 },
        expectedSha: digest,
        sumsUrl: sums ? sums.browser_download_url : null,
    };
}

// 汇合两路哈希来源:sums 文本匹配优先(与发布产物同批生成),缺省回落资产 digest。
function resolveExpectedSha(installer, sumsText) {
    if (!installer) return null;
    if (sumsText) {
        const fromSums = matchChecksum(sumsText, installer.asset.name);
        if (fromSums) return fromSums;
    }
    return installer.expectedSha || null;
}

module.exports = { isNewerVersion, findSetupAsset, parseChecksumLine, matchChecksum, normalizeAssetName, pickInstaller, resolveExpectedSha };
