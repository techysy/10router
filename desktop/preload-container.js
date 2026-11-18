/**
 * 容器页 preload(主窗体 + 壳内弹窗子窗共用,sandbox 安全)
 *
 * 「壳子容器」的密码捕获/自动填充,全程只与主进程走 IPC,不向页面暴露任何东西
 * (无 contextBridge,页面拿不到本脚本作用域)。规则:
 *  - 捕获:<form> submit(捕获阶段)提取 用户名+密码 → pw:captured;SPA 无 form 登录
 *    靠「密码框输入防抖上报 pw:typed」,主进程在 did-navigate 同 origin 换路径时
 *    视作登录成功转保存询问。多密码框值不同 → 疑似注册/改密表单,跳过。
 *  - 填充:focusin 空密码框/配对用户名框时上报 pw:focus,主进程查「该 origin 恰好
 *    一条」已存条目后回 pw:fill 自动填(多账号必须右键显式选,不自动猜)。
 *  - 只认 isTrusted 输入事件:程序化填充派发的 input/change(isTrusted=false)不会
 *    被当成用户输入再捕获,避免填充→上报→重复弹保存的死循环。
 *  - pw:fill 广播给全部 frame,各 frame 按 location.origin 自滤——条目只会落进
 *    它归属的 origin,跨域 iframe 拿不到。
 */
const { ipcRenderer, contextBridge } = require('electron');

// 会话池白名单 API（#150）：仪表盘页面经此调起壳内站点登录窗/读站点表。
// 只在壳内（preload 存在）暴露；普通浏览器里 contextBridge 不存在，页面拿不到。
if (contextBridge && contextBridge.exposeInMainWorld) {
    contextBridge.exposeInMainWorld('sessionPool', {
        list: () => ipcRenderer.invoke('session-pool:list'),
        login: (siteId, slot) => ipcRenderer.invoke('session-pool:login', siteId, slot),
        onCaptured: (cb) => {
            const listener = (_e, msg) => { try { cb(msg); } catch { /* ignore */ } };
            ipcRenderer.on('cookie-site:captured', listener);
            return () => ipcRenderer.removeListener('cookie-site:captured', listener);
        },
    });
}

(() => {
    'use strict';

    const FOCUS_THROTTLE_MS = 300;
    const TYPED_DEBOUNCE_MS = 400;
    const USERNAME_TYPES = ['text', 'email', 'tel', 'username', ''];

    let lastFocusSent = 0;
    let typedTimer = null;

    function isVisible(el) {
        try {
            if (!(el instanceof HTMLElement) || el.disabled || el.readOnly) return false;
            if ((el.getAttribute('type') || '').toLowerCase() === 'hidden') return false;
            return el.getClientRects().length > 0;
        } catch { return false; }
    }

    // 密码框前面(同 form/文档 DOM 序)最贴近的非空用户名框;都空则取最后一个可见候选
    function findUsernameTarget(pw) {
        const scope = pw.form || document;
        let fallback = null;
        let hinted = null;
        for (const el of scope.querySelectorAll('input')) {
            if (el === pw) break;
            const t = (el.getAttribute('type') || 'text').toLowerCase();
            if (!USERNAME_TYPES.includes(t)) continue;
            if (!isVisible(el)) continue;
            if (!hinted && (el.autocomplete === 'username' || /user|email|login|account|phone|mobile/i.test(el.name || ''))) {
                hinted = el;
            }
            fallback = el;
        }
        if (hinted && hinted.value) return hinted;
        for (const el of scope.querySelectorAll('input')) {
            if (el === pw) break;
            const t = (el.getAttribute('type') || 'text').toLowerCase();
            if (USERNAME_TYPES.includes(t) && isVisible(el) && el.value) return el;
        }
        return fallback;
    }

    function usernameValue(pw) {
        try {
            const el = findUsernameTarget(pw);
            return el ? String(el.value || '').trim() : '';
        } catch { return ''; }
    }

    // 多个非空密码框且值不同 → 注册/改密表单,不捕获
    function credsFromPasswordInput(pw) {
        try {
            const password = String(pw.value || '');
            if (!password) return null;
            const filled = Array.from((pw.form || document).querySelectorAll('input[type=password]'))
                .filter((el) => el.value && el.value !== password);
            if (filled.length) return null;
            return { username: usernameValue(pw), password };
        } catch { return null; }
    }

    // ── 捕获:form submit(捕获阶段,页面自己的 handler 前后都不影响) ──
    window.addEventListener('submit', (e) => {
        try {
            if (!e.isTrusted) return;
            const form = e.target;
            if (!form || !form.querySelectorAll) return;
            for (const pw of form.querySelectorAll('input[type=password]')) {
                const creds = credsFromPasswordInput(pw);
                if (creds) { ipcRenderer.send('pw:captured', creds); break; }
            }
        } catch { /* 不影响页面提交流程 */ }
    }, true);

    // ── 捕获:SPA 无 form 登录——密码框输入防抖上报,主进程存 pending,
    //    did-navigate 同 origin 换路径时转保存询问 ──
    document.addEventListener('input', (e) => {
        try {
            if (!e.isTrusted) return;
            const t = e.target;
            if (!t || t.tagName !== 'INPUT' || (t.getAttribute('type') || '').toLowerCase() !== 'password' || !t.value) return;
            clearTimeout(typedTimer);
            typedTimer = setTimeout(() => {
                try {
                    const creds = credsFromPasswordInput(t);
                    if (creds) ipcRenderer.send('pw:typed', creds);
                } catch { }
            }, TYPED_DEBOUNCE_MS);
        } catch { }
    }, true);

    // ── 自动填充:focusin 上报(节流),主进程恰好一条时回 pw:fill ──
    function looksLikeLoginField(el) {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        if (t === 'password') return true;
        if (!USERNAME_TYPES.includes(t)) return false;
        // 用户名框必须是某个可见密码框的配对位才上报,避免页面里随便一个输入框都触发
        try {
            const pws = Array.from(document.querySelectorAll('input[type=password]')).filter(isVisible);
            return pws.some((pw) => findUsernameTarget(pw) === el);
        } catch { return false; }
    }

    document.addEventListener('focusin', (e) => {
        try {
            const t = e.target;
            if (!t || t.tagName !== 'INPUT' || t.value) return;
            if (!looksLikeLoginField(t)) return;
            const now = Date.now();
            if (now - lastFocusSent < FOCUS_THROTTLE_MS) return;
            lastFocusSent = now;
            ipcRenderer.send('pw:focus', {});
        } catch { }
    }, true);

    // ── 填充执行:React 受控输入走原型 setter + 冒泡 input/change ──
    function setNativeValue(input, value) {
        const proto = Object.getPrototypeOf(input);
        const desc = Object.getOwnPropertyDescriptor(proto, 'value')
            || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        if (desc && desc.set) desc.set.call(input, value);
        else input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function fillLogin(username, password) {
        try {
            const pws = Array.from(document.querySelectorAll('input[type=password]')).filter(isVisible);
            if (!pws.length) return false;
            const pw = pws.find((el) => !el.value) || pws[0];
            if (password) setNativeValue(pw, password);
            if (username) {
                const un = findUsernameTarget(pw);
                if (un) setNativeValue(un, username);
            }
            return true;
        } catch { return false; }
    }

    ipcRenderer.on('pw:fill', (e, msg) => {
        try {
            if (!msg || typeof msg !== 'object') return;
            // 只认本 frame 自己 origin 的条目(主进程已按来源 frame 过滤,这里双保险)
            if (msg.origin && msg.origin !== location.origin) return;
            fillLogin(String(msg.username || ''), String(msg.password || ''));
        } catch { /* 不影响页面 */ }
    });
})();
