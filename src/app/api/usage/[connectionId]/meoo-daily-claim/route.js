// Ensure proxyFetch is loaded to patch globalThis.fetch
import "open-sse/index.js";

import { getProviderConnectionById } from "@/lib/localDb";
import {
  fetchMeooIdentity,
  fetchMeooPoints,
  getMeooControlKey,
} from "open-sse/services/meooAk.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshAndUpdateCredentials } from "../route.js";

const REREAD_DELAY_MS = 2000;
const REREAD_ATTEMPTS = 3; // first re-read + up to 2 retries

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Same credential priority as the usage handler: OAuth access token
// first, then the stored control key. Never logged, never returned.
function pickCredential(connection) {
  if (typeof connection?.accessToken === "string" && connection.accessToken.trim()) {
    return connection.accessToken.trim();
  }
  return getMeooControlKey(connection || {});
}

/**
 * POST /api/usage/[connectionId]/meoo-daily-claim
 *
 * Meoo grants 2000 points on the first login of each day (the plan's
 * `daily_login` benefit) — there is no claim endpoint, so "claiming" is
 * a login-equivalent authenticated action on the control plane:
 *   OAuth connection      → force one token refresh through the executor
 *                           refresh chain (a fresh /oauth/token exchange);
 *   paste-key connection  → one identity read with the control key.
 * The result is verified against the points ledger: claimed=true only
 * when totalGranted actually increased across the action. Anything else
 * reports claimed=false with the reason — never a pretend success.
 */
export async function POST(request, { params }) {
  try {
    const { connectionId } = await params;

    let connection = await getProviderConnectionById(connectionId);
    if (!connection) return Response.json({ error: "Connection not found" }, { status: 404 });
    if (connection.provider !== "meoo") {
      return Response.json(
        { error: "Daily points claim is only available for Meoo connections." },
        { status: 400 },
      );
    }

    const proxyConfig = await resolveConnectionProxyConfig(connection.providerSpecificData);
    const proxyOptions = {
      connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
      connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
      connectionNoProxy: proxyConfig.connectionNoProxy || "",
      vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
      strictProxy: false,
    };

    let credential = pickCredential(connection);
    if (!credential) {
      return Response.json({
        claimed: false,
        delta: 0,
        balance: null,
        message:
          "当前连接没有可用的 Meoo 控制面凭证（OAuth 登录或粘贴的控制面 Key），无法触发每日登录积分。",
      });
    }

    // ① Baseline ledger read — the delta is measured across the action.
    let before;
    try {
      before = await fetchMeooPoints(credential, { proxyOptions });
    } catch (error) {
      return Response.json({
        claimed: false,
        delta: 0,
        balance: null,
        message: `读取积分账面失败：${error.message}`,
      });
    }
    if (!before || typeof before.totalGranted !== "number") {
      return Response.json({
        claimed: false,
        delta: 0,
        balance: typeof before?.availableBalance === "number" ? before.availableBalance : null,
        message: "Meoo 未返回积分账面数据，无法核验领取结果。",
      });
    }

    // ② Login-equivalent action.
    if (connection.refreshToken) {
      // OAuth: force one refresh. Best effort — a failed refresh leaves
      // the stored credential in place and the re-read below arbitrates.
      try {
        ({ connection } = await refreshAndUpdateCredentials(connection, true, proxyOptions));
        credential = pickCredential(connection) || credential;
      } catch {
        // Keep the pre-refresh credential; the ledger delta decides.
      }
    } else {
      // Paste-key: one authenticated identity read with the control key.
      // Best effort — a scoped key may refuse identity; the re-read
      // below arbitrates either way.
      try {
        await fetchMeooIdentity(credential, { proxyOptions });
      } catch {
        // Identity is the trigger touch, not the verdict.
      }
    }

    // ③ Re-read the ledger, retrying briefly while a grant settles.
    let after = before;
    for (let attempt = 0; attempt < REREAD_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(REREAD_DELAY_MS);
      try {
        after = await fetchMeooPoints(credential, { proxyOptions });
      } catch {
        break;
      }
      if (typeof after?.totalGranted === "number" && after.totalGranted > before.totalGranted) {
        break;
      }
    }

    // ④ Verdict from the ledger, not from the action's apparent success.
    const delta =
      typeof after?.totalGranted === "number" ? after.totalGranted - before.totalGranted : 0;
    const balance =
      typeof after?.availableBalance === "number"
        ? after.availableBalance
        : before.availableBalance;

    if (delta > 0) {
      return Response.json({
        claimed: true,
        delta,
        balance,
        message: `已领取每日登录积分 +${delta}`,
      });
    }
    return Response.json({
      claimed: false,
      delta: 0,
      balance,
      message: "今日可能已领取，或该权益需在 meoo.com 网页登录触发",
    });
  } catch (error) {
    console.warn(`[Meoo Daily Claim] ${error.message}`);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
