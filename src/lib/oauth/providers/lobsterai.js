// LobsterAI OAuth — 门户授权 → 本机 loopback 回调 → `/api/auth/exchange`。
//
// ── 流程 ────────────────────────────────────────────────────
//   1. 授权页：{portal}/portal#/login?source=electron&redirect_uri=…&state=…
//   2. 门户 302 回本机 loopback：`/auth/callback?code=…&state=…`
//   3. 换码：POST {api}/api/auth/exchange（**不带 Authorization**）
//        体 { authCode, firstKeyfrom, latestKeyfrom, uuid, version }
//   4. 落账号：`uuid` 与两个 keyfrom 是**续期载荷件**，随 token 一起存进
//      providerSpecificData —— 只存两个 token 的账号永远续不了期。
//
// `uuid` / `firstKeyfrom` / `latestKeyfrom` 由客户端生成（参考实现 TS
// `lobsterai-oauth.ts:82-84` / Go `cmd/login`）。`latestKeyfrom` 登录后
// **永不更新**：续期时原样回传这一份是唯一经过生产验证的形态。
import {
  LOBSTERAI_API_BASE,
  LOBSTERAI_EXCHANGE_URL,
  LOBSTERAI_PATHS,
  LOBSTERAI_PORTAL_BASE,
  LOBSTERAI_REFRESH_URL,
  LOBSTERAI_REQUEST_TIMEOUT_MS,
  LOBSTERAI_USER_AGENT,
} from "open-sse/shared/lobsterai/constants.js";
import {
  jwtExpiryMs,
  resolveClientVersion,
  unwrapEnvelope,
  uuidV4,
} from "open-sse/shared/lobsterai/client.js";

export const LOBSTERAI_CONFIG = {
  authorizeUrl: `${LOBSTERAI_PORTAL_BASE}/portal#/login`,
  tokenUrl: LOBSTERAI_EXCHANGE_URL,
  refreshUrl: LOBSTERAI_REFRESH_URL,
  profileSummaryUrl: `${LOBSTERAI_API_BASE}${LOBSTERAI_PATHS.profileSummary}`,
  // loopback 回调路径跟随参考实现的裸 `/auth/callback`；端口 0 = 动态端口，
  // 实际 redirect_uri 由调用方（或本机回调服务）拼好传给 buildAuthUrl。
  callbackPath: "/auth/callback",
  fixedPort: 0,
};

function positive(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

/** 回调 URL 或裸 code 都接受；裸 code 原样返回。 */
export function extractAuthCode(input) {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) return "";
  if (!/[?&]code=/.test(raw)) return raw;
  try {
    return new URL(raw).searchParams.get("code")?.trim() || "";
  } catch {
    const match = /[?&]code=([^&#]+)/.exec(raw);
    return match ? decodeURIComponent(match[1]) : "";
  }
}

async function postEnvelope(url, body, what) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": LOBSTERAI_USER_AGENT,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(LOBSTERAI_REQUEST_TIMEOUT_MS),
  });

  const text = await response.text().catch(() => "");
  if (response.status === 401 || response.status === 403) {
    throw new Error(`LobsterAI ${what}被拒（HTTP ${response.status}），请重新登录`);
  }
  if (!response.ok) {
    throw new Error(`LobsterAI ${what}返回 HTTP ${response.status}${text ? `：${text.slice(0, 300)}` : ""}`);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`LobsterAI ${what}响应不是 JSON`);
  }
  const unwrapped = unwrapEnvelope(payload, what);
  if (!unwrapped.ok) throw new Error(unwrapped.message);
  return unwrapped.data;
}

const lobsterai = {
  config: LOBSTERAI_CONFIG,
  flowType: "authorization_code",
  fixedPort: LOBSTERAI_CONFIG.fixedPort,
  callbackPath: LOBSTERAI_CONFIG.callbackPath,

  buildAuthUrl: (config, redirectUri, state) => {
    const params = new URLSearchParams({
      source: "electron",
      redirect_uri: redirectUri,
      state,
    });
    return `${config.authorizeUrl}?${params.toString()}`;
  },

  exchangeToken: async (config, code) => {
    const authCode = extractAuthCode(code);
    if (!authCode) throw new Error("LobsterAI 缺少授权码");

    // keyfrom 是毫秒时间戳字符串；uuid 是这次安装的标识（续期要原样回传）。
    const keyfrom = String(Date.now());
    const uuid = uuidV4();
    const version = await resolveClientVersion();

    const data = await postEnvelope(
      config.tokenUrl,
      {
        authCode,
        firstKeyfrom: keyfrom,
        latestKeyfrom: keyfrom,
        uuid,
        version,
      },
      "换码",
    );

    if (!data || typeof data.accessToken !== "string" || !data.accessToken.trim()) {
      throw new Error("LobsterAI 换码响应缺少 accessToken");
    }

    return {
      ...data,
      _lobsterai: {
        uuid,
        firstKeyfrom: keyfrom,
        latestKeyfrom: keyfrom,
        version,
      },
    };
  },

  mapTokens: (tokens) => {
    const extra = tokens?._lobsterai || {};
    const user = tokens?.user && typeof tokens.user === "object" ? tokens.user : {};
    const uid = String(user.id || user.yid || user.userId || "").trim();
    const userId = String(user.userId || "").trim();
    const nickname = String(user.nickname || "").trim();

    // 响应缺 expiresIn 时从 JWT 的 exp 反推（access token 是 30 天 HS512 JWT）。
    let expiresIn = positive(tokens?.expiresIn);
    if (!expiresIn) {
      const expMs = jwtExpiryMs(tokens?.accessToken);
      if (expMs > 0) expiresIn = Math.max(1, Math.floor((expMs - Date.now()) / 1000));
    }

    return {
      accessToken: tokens?.accessToken,
      refreshToken: tokens?.refreshToken || null,
      expiresIn,
      // OAuth 连接按 email 去重；上游不一定给邮箱，用 uid 造一个稳定标识，
      // 重复登录会更新同一行而不是堆出 "Account N"。
      email: uid ? `lobsterai-${uid}` : null,
      displayName: nickname || (uid ? `LobsterAI ${uid}` : "LobsterAI"),
      providerSpecificData: {
        authMethod: "oauth",
        uid,
        userId,
        nickname,
        uuid: extra.uuid || "",
        firstKeyfrom: extra.firstKeyfrom || "",
        latestKeyfrom: extra.latestKeyfrom || "",
        version: extra.version || "",
      },
    };
  },
};

export default lobsterai;
