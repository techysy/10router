import { XIAOHUANXIONG_CONFIG } from "../constants/oauth.js";

// 商汤小浣熊 (SenseTime Raccoon) — 微信小程序扫码 OAuth。
// 复用 device_code 流：requestDeviceCode 在服务端 mint 一个 qrcode_code，
// verification_uri 指向内置 /api/oauth/xiaohuanxiong/qr?data=<mpUrl>，它渲染
// 一张 SVG 二维码图（微信扫开小程序登录页），pollToken 轮询到 success 后
// 再调 iam/confirm 激活 token。深链兜底走 buildAuthUrl + paste-code。
const xiaohuanxiong = {
  config: XIAOHUANXIONG_CONFIG,
  flowType: "device_code",

  // POST {iam}/auth/mp/qrcode {} -> {data:{qrcode_code, scan_path, expires_in, poll_interval}}
  // QR 内容 = {site}{scan_path}?code=<qrcode_code>（/login/mp 是小程序路由，
  // 浏览器打开 404，只能靠二维码图承接）。
  requestDeviceCode: async (config) => {
    const r = await fetch(config.qrcodeCreateUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: "{}",
    });
    const j = await r.json().catch(() => ({}));
    const d = j?.data || {};
    const code = d.qrcode_code;
    if (!code) {
      throw new Error(`xiaohuanxiong createQr failed: ${j?.message || `HTTP ${r.status}`}`);
    }
    const scanPath = d.scan_path || "/login/mp";
    const site = config.apiBaseUrl || "https://xiaohuanxiong.com";
    const mpUrl = `${site}${scanPath}?code=${encodeURIComponent(code)}`;
    return {
      device_code: code,
      user_code: code,
      verification_uri: `/api/oauth/xiaohuanxiong/qr?data=${encodeURIComponent(mpUrl)}`,
      verification_uri_complete: `/api/oauth/xiaohuanxiong/qr?data=${encodeURIComponent(mpUrl)}`,
      expires_in: Math.min(d.expires_in || 300, 300),
      interval: Math.max(d.poll_interval || 2, 2),
    };
  },

  // POST {iam}/auth/mp/qrcode/login {qrcode_code} -> {status, access_token}
  pollToken: async (config, deviceCode) => {
    let j;
    try {
      const r = await fetch(config.qrcodePollUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ qrcode_code: deviceCode }),
      });
      j = await r.json().catch(() => ({}));
    } catch {
      return { ok: true, data: { error: "authorization_pending" } };
    }
    const d = j?.data || j;
    const st = d?.status;
    if (st === "success" && d?.access_token) {
      // IAM token 先激活（绑 session），LLM API 才认；失败不致命，连接测试时再补。
      try {
        await fetch(config.iamConfirmUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${d.access_token}` },
          body: "{}",
        });
      } catch (e) {
        console.warn("[xiaohuanxiong] iam/confirm failed:", e?.message || e);
      }
      return {
        ok: true,
        data: {
          access_token: d.access_token,
          refresh_token: d.refresh_token,
          expires_in: d.expires_in || 86400 * 30,
          office_identity: d.office_identity,
          office_org_name: d.office_org_name,
          office_org_role: d.office_org_role,
        },
      };
    }
    if (st === "canceled") {
      return { ok: true, data: { error: "access_denied", error_description: "用户在手机上取消了登录" } };
    }
    // pending / logging / expired -> 继续轮询（过期码下轮由 requestDeviceCode 重发）
    return { ok: true, data: { error: "authorization_pending" } };
  },

  // 兜底：授权码 + loopback / 粘贴回调 code（桌面 deep-link 路径）。
  buildAuthUrl: (config, redirectUri, state) => {
    const u = new URL(config.authorizeUrl);
    u.searchParams.set("login_source", "desktop");
    u.searchParams.set("appname", "办公小浣熊客户端");
    u.searchParams.set("desktop_callback", "loopback");
    u.searchParams.set("redirect", redirectUri);
    u.searchParams.set("state", state);
    return u.toString();
  },

  // POST {auth}/login_with_authorization_code {authorization_code}（非标准字段）
  exchangeToken: async (config, code) => {
    let c = String(code || "").trim();
    if (c.includes("code=")) {
      try { c = new URL(c).searchParams.get("code") || c; } catch {}
    }
    if (!c) throw new Error("xiaohuanxiong: empty authorization code");
    const r = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ authorization_code: c }),
    });
    const j = await r.json().catch(() => ({}));
    const d = j?.data || j;
    if (!r.ok || !d?.access_token) {
      throw new Error(`xiaohuanxiong token exchange failed: ${j?.message || `HTTP ${r.status}`}`);
    }
    return {
      access_token: d.access_token,
      refresh_token: d.refresh_token,
      expires_in: d.expires_in || 86400 * 30,
      office_identity: d.office_identity,
      office_org_name: d.office_org_name,
      office_org_role: d.office_org_role,
    };
  },

  mapTokens: (t) => ({
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresIn: Number(t.expires_in) > 0 ? Number(t.expires_in) : 86400 * 30,
    name: `小浣熊 ${t.office_identity || ""}${t.office_org_name ? ` (${t.office_org_name})` : ""}`.trim(),
    displayName: t.office_identity || null,
    lastRefreshAt: new Date().toISOString(),
    providerSpecificData: {
      authMethod: "oauth",
      identity: t.office_identity || null,
      orgName: t.office_org_name || null,
      orgRole: t.office_org_role || null,
    },
  }),
};

export default xiaohuanxiong;
