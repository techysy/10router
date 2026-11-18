// 会话池站点表（#150，对齐 CreditDaddy 会话池）。
//
// 「网页会话」站点 = 仪表盘里以 webCookie 接入的供应商：登录在壳内站点窗完成，
// 收割的 Cookie 罐落连接 apiKey（与 lingxi/dumate 的 capture 同构），额外带
// cookieSlot（1-9，Chrome 多 profile 等价物）——同身份同槽一行、同身份异槽分行。
//
// 每条：id（分区前缀 cookie-site-<id>）、name（面板显示）、loginUrl（壳开窗地址）、
// provider（落库 provider）、accountKey（psd 里的归户键，与各自 lib.js 对齐）。

export const SESSION_POOL_SLOTS = 9;

export const COOKIE_SITES = [
  {
    id: 'lingxi',
    name: 'WPS 灵犀',
    loginUrl: 'https://lingxi.kdocs.cn',
    provider: 'lingxi',
    accountKey: 'lingxiAccountKey',
  },
  {
    id: 'dumate',
    name: 'DuMate 百度搭子',
    loginUrl: 'https://dumate.baidu.com',
    provider: 'dumate',
    accountKey: 'dumateAccountKey',
  },
];

export const getCookieSite = (id) => COOKIE_SITES.find((s) => s.id === id) || null;
