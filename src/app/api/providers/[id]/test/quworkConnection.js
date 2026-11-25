import { quworkProbeInference } from "open-sse/shared/quwork/client.js";

/** QuWork probe: GET llm.quwork.cn/v1/models with the llm_token — lists models,
 * never spends points. `effectiveProxy` is the generic resolveConnectionProxyConfig shape. */
export async function testQuworkConnection(connection, effectiveProxy = null, fetchImpl) {
  const llmToken = typeof connection?.apiKey === "string" ? connection.apiKey.trim() : "";
  if (!llmToken) return { valid: false, error: "No llm_token", refreshed: false };
  try {
    const probe = await quworkProbeInference(llmToken, { proxyOptions: effectiveProxy, ...(fetchImpl ? { fetchImpl } : {}) });
    if (probe.ok) return { valid: true, error: null, refreshed: false };
    if (probe.status === 405) return { valid: false, error: "QuWork 网关 405（阿里云 WAF 拦截非中国大陆 IP）——请配置国内出站代理或连接代理", refreshed: false };
    if (probe.status === 401 || probe.status === 403) return { valid: false, error: "Token invalid or revoked", refreshed: false };
    return { valid: false, error: `QuWork API returned ${probe.status}: ${probe.error}`, refreshed: false };
  } catch (error) {
    return { valid: false, error: `QuWork test failed: ${String(error?.message || "network error").slice(0, 160)}`, refreshed: false };
  }
}
