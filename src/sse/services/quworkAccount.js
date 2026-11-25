// QuWork 账号操作（连接卡「账号」弹窗）：查看微信绑定/邀请码/邀请人、扫码绑定
// 微信、填写邀请码/兑换码激活。
//
// 一律用该连接的账号 token，网络走连接级代理配置（resolveConnectionProxyConfig：
// 连接代理 / 代理池，与 usage/签到同一份解析）——QuWork 账号网关前置阿里云 WAF，
// 非中国大陆出口会被 405。账号 token 失效时用通用 quwork 刷新器续期一次再重试。
import { randomBytes } from "node:crypto";
import * as log from "../utils/logger.js";

const WECHAT_STATE_TTL_MS = 10 * 60 * 1000;

export class QuworkAccountError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "QuworkAccountError";
    this.status = status;
  }
}

/** Load + validate a QuWork connection that carries an account token. */
export async function loadQuworkAccountConnection(connectionId) {
  const id = String(connectionId || "").trim();
  if (!id) throw new QuworkAccountError("缺少 connectionId");
  const { getProviderConnectionById } = await import("../../lib/localDb.js");
  const conn = await getProviderConnectionById(id);
  if (!conn) throw new QuworkAccountError("Connection not found", 404);
  if (conn.provider !== "quwork") throw new QuworkAccountError("仅 QuWork 连接支持此操作");
  if (conn.providerSpecificData?.quworkTokenOnly === true || !String(conn.accessToken || "").trim()) {
    throw new QuworkAccountError("该连接只有 llm_token，没有账号 access token——请用短信登录或补充 access token");
  }
  return conn;
}

export async function quworkProxyOptionsFor(conn) {
  const { resolveConnectionProxyConfig } = await import("../../lib/network/connectionProxy.js");
  const cfg = await resolveConnectionProxyConfig(conn.providerSpecificData);
  return {
    connectionProxyEnabled: cfg.connectionProxyEnabled === true,
    connectionProxyUrl: cfg.connectionProxyUrl || "",
    connectionNoProxy: cfg.connectionNoProxy || "",
    vercelRelayUrl: cfg.vercelRelayUrl || "",
    strictProxy: cfg.strictProxy === true,
  };
}

/** Run fn(accessToken, proxyOptions); on an expired token renew once and retry. */
async function withAccess(conn, fn) {
  const proxyOptions = await quworkProxyOptionsFor(conn);
  try {
    return await fn(conn.accessToken, proxyOptions);
  } catch (e) {
    if (!e?.expired || !conn.refreshToken) throw e;
    const { refreshQuworkToken } = await import("open-sse/services/tokenRefresh.js");
    const refreshed = await refreshQuworkToken(conn.refreshToken, log, proxyOptions);
    if (!refreshed?.accessToken) throw new QuworkAccountError("账号 token 已失效且续期失败，请重新登录 QuWork", 401);
    const { updateProviderCredentials } = await import("./tokenRefresh.js");
    await updateProviderCredentials(conn.id, refreshed);
    conn.accessToken = refreshed.accessToken;
    return fn(refreshed.accessToken, proxyOptions);
  }
}

async function patchPsd(conn, patch) {
  try {
    const { getProviderConnectionById, updateProviderConnection } = await import("../../lib/localDb.js");
    const latest = (await getProviderConnectionById(conn.id)) || conn;
    const next = { ...(latest.providerSpecificData || {}), ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k];
    await updateProviderConnection(conn.id, { providerSpecificData: next });
    conn.providerSpecificData = next;
  } catch { /* best-effort */ }
}

/** Account facts (WeChat bound / own invite code / inviter / invite summary). Cached on the row for display. */
export async function getQuworkAccountInfo(conn) {
  const { quworkSelfInfo, quworkInviteSummary, quworkAccountFromSelf, quworkPointsFromSelf } = await import("open-sse/shared/quwork/client.js");
  return withAccess(conn, async (token, proxyOptions) => {
    const self = await quworkSelfInfo(token, { proxyOptions });
    let summary = null;
    try { summary = await quworkInviteSummary(token, { proxyOptions }); } catch { /* optional */ }
    const acct = quworkAccountFromSelf(self, summary);
    const points = quworkPointsFromSelf(self).remaining;
    await patchPsd(conn, {
      quworkWechatBound: acct.wechatBound,
      quworkAffCode: acct.affCode,
      quworkInviterId: acct.inviterId,
      quworkAccountAt: new Date().toISOString(),
    });
    return { ...acct, points };
  });
}

/** New WeChat QR link; the state is remembered on the row (10 min) to check the pasted callback. */
export async function createQuworkWechatQr(conn) {
  const { quworkWechatQrUrl } = await import("open-sse/shared/quwork/client.js");
  const { url, state } = quworkWechatQrUrl({ state: randomBytes(16).toString("hex") });
  await patchPsd(conn, { quworkWechatState: { state, at: Date.now() } });
  return { url, state, expiresInSec: 300 };
}

export async function bindQuworkWechat(conn, callbackInput) {
  const client = await import("open-sse/shared/quwork/client.js");
  const pending = conn.providerSpecificData?.quworkWechatState;
  const expectedState = pending?.state && Date.now() - Number(pending.at || 0) < WECHAT_STATE_TTL_MS ? pending.state : "";
  // Parse first so a malformed paste never reaches the network.
  client.quworkParseWechatCallback(callbackInput);
  const result = await withAccess(conn, async (token, proxyOptions) => {
    const self = await client.quworkSelfInfo(token, { proxyOptions });
    if (client.quworkAccountFromSelf(self).wechatBound) {
      throw new QuworkAccountError("该 QuWork 账号已经绑定了微信，无需重复绑定");
    }
    return client.quworkBindWechatFromCallback(token, callbackInput, { expectedState, proxyOptions });
  });
  await patchPsd(conn, { quworkWechatState: undefined, quworkWechatBound: true });
  return { ...result, message: "微信绑定成功" };
}

export async function activateQuworkCode(conn, code) {
  const { quworkActivateCode, quworkDeviceIdentifier } = await import("open-sse/shared/quwork/client.js");
  let deviceId = String(conn.providerSpecificData?.quworkDeviceId || "").trim();
  if (!/^[0-9a-f]{64}$/.test(deviceId)) {
    // 旧连接没记登录时的设备标识：按连接 id 派生一个稳定值并记下，之后一直用它。
    deviceId = quworkDeviceIdentifier(`10router-connection:${conn.id}`);
    await patchPsd(conn, { quworkDeviceId: deviceId });
  }
  const r = await withAccess(conn, (token, proxyOptions) => quworkActivateCode(token, code, { deviceId, proxyOptions }));
  return { activated: true, message: r.message };
}

/** Uniform route error → {status, body}. Never echoes tokens. */
export function quworkAccountErrorResponse(e) {
  const status = e instanceof QuworkAccountError ? e.status : (e?.expired ? 401 : e?.status === 405 ? 502 : 400);
  return { status, body: { error: e?.message || String(e), code: e?.code || "" } };
}
